import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Queue } from './queue.mjs';
import { verifyWorkspaceEvent, envelope, retryDelay, makeWebhookUrl } from './security.mjs';

async function acknowledged(response) {
  if (response.status !== 202) {
    await response.body?.cancel();
    return false;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > 4096) return false;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.received === true; }
  catch { return false; }
}

export function createRelay({ queue, workspaceSecret, relaySecret, webhookUrl, fetchImpl = fetch, maxBodyBytes = 256 * 1024, now = Date.now, report = () => {} }) {
  if (typeof workspaceSecret !== 'string' || workspaceSecret.length < 16 || typeof relaySecret !== 'string' || relaySecret.length < 32) throw new Error('Workspace and relay signing secrets are required');
  const target = makeWebhookUrl(webhookUrl);
  let processing = false;
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
    if (req.url === '/health' && req.method === 'GET') { send(200, { ok: true }); return; }
    if (req.url !== '/events') { send(404, { error: 'Not found' }); return; }
    if (req.method !== 'POST') { send(405, { error: 'POST required' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(415, { error: 'JSON required' }); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { send(415, { error: 'Compressed requests are not supported' }); return; }
    if (active >= 32) { send(503, { error: 'Busy' }); return; }
    active++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { send(413, { error: 'Payload too large' }); req.resume(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const event = verifyWorkspaceEvent(raw, req.headers, workspaceSecret, now());
      const accepted = queue.enqueue(event, raw, now());
      send(202, { received: true, duplicate: accepted.duplicate });
    } catch (error) {
      const status = error.status || 503;
      report({ action: 'reject', status });
      send(status, { error: status >= 500 ? 'Unable to queue event' : error.message });
    } finally { active--; }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;

  async function tick() {
    if (processing) return;
    processing = true;
    try {
      const row = queue.claim(now());
      if (!row) return;
      try {
        const response = await fetchImpl(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope(row, relaySecret, now())), redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const status = response.status;
        const after = response.headers.get('retry-after');
        // Make can return a 2xx HTML warning when a hook is inactive. Require
        // the acknowledgement configured in this app, not merely any 2xx.
        if (await acknowledged(response)) {
          queue.complete(row, now()); report({ action: 'sent', id: row.id, status });
        } else {
          const retryable = status === 429 || status >= 500 || (status >= 200 && status < 300);
          const state = queue.fail(row, status, retryDelay(row.attempts, after, now()), retryable, now());
          report({ action: state, id: row.id, status });
        }
      } catch {
        const state = queue.fail(row, 0, retryDelay(row.attempts, null, now()), true, now());
        report({ action: state, id: row.id, status: 0 });
      }
    } finally { processing = false; }
  }
  const idle = () => !processing && active === 0;
  async function close({ timeoutMs = 20_000 } = {}) {
    // Also wait for accepted sockets still reading headers: those requests have
    // not entered the handler yet and are not represented by the active count.
    const closed = new Promise(resolve => server.close(resolve));
    const timeout = setTimeout(() => server.closeAllConnections(), timeoutMs);
    try {
      await closed;
      while (!idle()) await new Promise(resolve => setTimeout(resolve, 25));
    } finally { clearTimeout(timeout); }
  }
  return { server, tick, idle, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const queue = new Queue(process.env.RELAY_DB || path.resolve('.local/relay/events.sqlite'));
  const relay = createRelay({ queue, workspaceSecret: process.env.MEETSTREAM_WEBHOOK_SECRET, relaySecret: process.env.MAKE_RELAY_SECRET, webhookUrl: process.env.MAKE_WEBHOOK_URL, report: entry => console.log(JSON.stringify(entry)) });
  const port = Number(process.env.RELAY_PORT || 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_PORT must be a valid port');
  relay.server.listen(port, process.env.RELAY_HOST || '127.0.0.1', () => console.log(`MeetStream relay listening on port ${port}`));
  const worker = setInterval(() => { relay.tick().catch(() => console.error('Relay worker failed; inspect queue health')); }, 1000);
  const maintenance = setInterval(() => {
    queue.prune();
    console.log(JSON.stringify({ action: 'queue-health', ...queue.stats() }));
  }, 60_000);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(worker); clearInterval(maintenance);
    await relay.close();
    queue.close();
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
