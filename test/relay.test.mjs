import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Queue } from '../relay/queue.mjs';
import { verifyWorkspaceEvent, deliveryId, retryDelay, makeWebhookUrl } from '../relay/security.mjs';
import { createRelay } from '../relay/server.mjs';
const workspaceSecret = 'synthetic-workspace-signing-secret';
const relaySecret = 'synthetic-relay-secret-at-least-32-bytes';
const target = 'https://hook.eu1.make.com/synthetic_hook';
const now = Date.parse('2026-10-13T12:00:00Z');
const event = { bot_id: 'bot-example', bot_event: 'transcription.processed', event: 'transcription.processed', transcript_status: 'Success', timestamp: new Date(now).toISOString() };
const sign = (raw, at = now) => ({ 'content-type': 'application/json', 'x-meetstream-signature': 'sha256=' + createHmac('sha256', workspaceSecret).update(raw).digest('hex'), 'x-meetstream-timestamp': new Date(at).toISOString() });

test('workspace signature verification uses unmodified body bytes', () => {
  const raw = Buffer.from(JSON.stringify(event, null, 2));
  assert.deepEqual(verifyWorkspaceEvent(raw, sign(raw), workspaceSecret, now), event);
  for (const [body, headers] of [
    [Buffer.from(JSON.stringify(event)), sign(raw)],
    [raw, {}], [raw, { ...sign(raw), 'x-meetstream-signature': 'sha256=abcd' }],
    [raw, { ...sign(raw), 'x-meetstream-signature': 'sha256=' + '00'.repeat(32) }],
    [raw, sign(raw, now - 301_000)], [raw, sign(raw, now + 301_000)],
    [raw, { ...sign(raw), 'x-meetstream-timestamp': 'invalid' }]
  ]) assert.throws(() => verifyWorkspaceEvent(body, headers, workspaceSecret, now), error => error.status === 401);
  for (const value of ['{}', '[]', 'null', '{not json}']) {
    const raw = Buffer.from(value); assert.throws(() => verifyWorkspaceEvent(raw, sign(raw), workspaceSecret, now), error => error.status === 400);
  }
});

test('an unsigned header cannot refresh a stale signed payload timestamp', () => {
  const raw = Buffer.from(JSON.stringify({ ...event, timestamp: new Date(now - 600_000).toISOString() }));
  assert.throws(() => verifyWorkspaceEvent(raw, sign(raw, now), workspaceSecret, now), error => error.status === 401);
  const fresh = Buffer.from(JSON.stringify({ ...event, timestamp: new Date(now).toISOString() }));
  assert.deepEqual(verifyWorkspaceEvent(fresh, sign(fresh, now), workspaceSecret, now), JSON.parse(fresh));
  assert.throws(() => verifyWorkspaceEvent(fresh, sign(fresh, now + 1000), workspaceSecret, now), error => error.status === 401);
  for (const timestamp of [undefined, null, [event.timestamp]]) {
    const invalid = Buffer.from(JSON.stringify({ ...event, timestamp }));
    assert.throws(() => verifyWorkspaceEvent(invalid, sign(invalid), workspaceSecret, now), error => error.status === 400 && /signed event timestamp/.test(error.message));
  }
});

test('delivery identities handle terminal aliases, resends, jobs, and repeated informational events', () => {
  const a = { bot_id: 'bot-example', event: 'bot.stopped', bot_event: 'bot.denied', timestamp: '2026-10-13T12:00:00Z' };
  assert.equal(deliveryId(a), deliveryId({ ...a, timestamp: '2026-10-13T12:00:01Z' }));
  assert.notEqual(deliveryId(a), deliveryId({ ...a, bot_event: 'bot.kicked' }));
  assert.notEqual(deliveryId(event), deliveryId({ ...event, transcript_id: 'new-job' }));
  assert.notEqual(deliveryId({ ...a, bot_event: 'bot.joining' }), deliveryId({ ...a, bot_event: 'bot.joining', timestamp: '2026-10-13T12:00:01Z' }));
  assert.equal(deliveryId(event), deliveryId(Object.fromEntries(Object.entries(event).reverse())));
});

test('distinct transcription runs without a job ID do not share a permanent one-shot key', () => {
  const first = { ...event, timestamp: '2026-10-14T12:00:00Z' };
  assert.equal(deliveryId(first), deliveryId({ ...first }));
  assert.notEqual(deliveryId(first), deliveryId({ ...first, timestamp: '2026-10-14T12:01:00Z' }));
  const identified = { ...first, transcript_id: 'stable-job-id' };
  assert.equal(deliveryId(identified), deliveryId({ ...identified, timestamp: '2026-10-14T12:01:00Z' }));
});

test('artifact failure cannot suppress later success while successful resends still deduplicate', () => {
  const queue = new Queue(':memory:');
  try {
    for (const [bot_event, field] of [['video.processed', 'video_status'], ['audio.processed', 'audio_status'], ['transcription.processed', 'transcript_status']]) {
      const failed = { bot_id: 'test-bot', bot_event, transcript_id: 'job-1', [field]: 'Failed', timestamp: '2026-10-13T12:00:00Z' };
      const success = { ...failed, [field]: 'Success' };
      assert.notEqual(deliveryId(failed), deliveryId(success));
      assert.equal(queue.enqueue(failed, Buffer.from(JSON.stringify(failed)), now).duplicate, false);
      assert.equal(queue.enqueue(success, Buffer.from(JSON.stringify(success)), now).duplicate, false);
      const resend = { ...success, timestamp: '2026-10-13T12:01:00Z' };
      assert.equal(queue.enqueue(resend, Buffer.from(JSON.stringify(resend)), now).duplicate, true);
    }
    assert.equal(queue.stats().queued, 6);
  } finally { queue.close(); }
});

test('relay remains busy until an in-flight ingress request commits to the queue', async t => {
  const queue = new Queue(':memory:');
  const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => now });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { relay.server.closeAllConnections(); await new Promise(resolve => relay.server.close(resolve)); queue.close(); });
  const raw = Buffer.from(JSON.stringify(event));
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ hostname: '127.0.0.1', port: relay.server.address().port, path: '/events', method: 'POST', headers: { ...sign(raw), 'content-length': raw.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject);
  });
  const received = new Promise(resolve => relay.server.once('request', () => resolve()));
  request.write(raw.subarray(0, 10));
  await received;
  assert.equal(relay.idle(), false);
  let closed = false;
  const draining = relay.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  request.end(raw.subarray(10));
  assert.equal(await response, 202);
  await draining;
  assert.equal(relay.idle(), true);
  assert.deepEqual(queue.stats(), { queued: 1 });
});

test('numeric bot IDs normalize like the reference and newline-tainted signatures are rejected', () => {
  const raw = Buffer.from(JSON.stringify({ ...event, bot_id: 42 }));
  assert.equal(verifyWorkspaceEvent(raw, sign(raw), workspaceSecret, now).bot_id, '42');
  assert.throws(() => verifyWorkspaceEvent(raw, { ...sign(raw), 'x-meetstream-signature': sign(raw)['x-meetstream-signature'] + '\n' }, workspaceSecret, now), error => error.status === 401);
});

test('durable queue survives restart, retains dedup IDs, and clears successful payloads', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meetstream-relay-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'events.sqlite');
  let queue = new Queue(filename);
  const accepted = queue.enqueue(event, Buffer.from(JSON.stringify(event)), now);
  assert.equal(queue.enqueue(event, Buffer.from(JSON.stringify(event)), now).duplicate, true);
  const row = queue.claim(now); assert.equal(row.attempts, 1); assert.equal(queue.claim(now), undefined);
  queue.close(); queue = new Queue(filename);
  assert.equal(queue.claim(now + 59_000), undefined);
  const recovered = queue.claim(now + 61_000); assert.equal(recovered.id, accepted.id); assert.equal(recovered.attempts, 2);
  queue.complete(recovered, now + 61_000);
  assert.equal(queue.db.prepare('SELECT payload FROM events WHERE id = ?').get(accepted.id).payload, null);
  assert.equal(queue.enqueue(event, Buffer.from('{}'), now + 62_000).duplicate, true);
  queue.prune(now + 91 * 86_400_000); assert.deepEqual(queue.stats(), {}); queue.close();
});

test('queue capacity and bounded retries preserve failed events for manual recovery', () => {
  const queue = new Queue(':memory:', { capacity: 1, maxAttempts: 2 });
  try {
    queue.enqueue(event, Buffer.from(JSON.stringify(event)), now);
    assert.throws(() => queue.enqueue({ ...event, bot_id: 'another' }, Buffer.from('{}'), now), /capacity/);
    assert.equal(queue.enqueue(event, Buffer.from('{}'), now).duplicate, true);
    const one = queue.claim(now); assert.equal(queue.fail(one, 429, 10_000, true, now), 'queued');
    assert.equal(queue.claim(now + 9999), undefined);
    const two = queue.claim(now + 10_000); assert.equal(queue.fail(two, 503, 1, true, now), 'dead');
    assert.equal(queue.requeue(two.id, now + 20_000), 1);
    assert.equal(queue.claim(now + 20_000).attempts, 1);
  } finally { queue.close(); }
});

test('repeated worker crashes cannot bypass the finite delivery budget', () => {
  const queue = new Queue(':memory:', { maxAttempts: 2 });
  try {
    queue.enqueue(event, Buffer.from(JSON.stringify(event)), now);
    assert.equal(queue.claim(now).attempts, 1);
    assert.equal(queue.claim(now + 61_000).attempts, 2);
    assert.equal(queue.claim(now + 122_000), undefined);
    assert.equal(queue.stats().dead, 1);
  } finally { queue.close(); }
});

test('an old delivery worker cannot update an event claimed again after manual recovery', () => {
  const queue = new Queue(':memory:', { maxAttempts: 1 });
  try {
    queue.enqueue(event, Buffer.from(JSON.stringify(event)), now);
    const old = queue.claim(now);
    assert.equal(queue.claim(now + 61_000), undefined);
    assert.equal(queue.requeue(old.id, now + 61_000), 1);
    const current = queue.claim(now + 61_000);
    assert.equal(current.attempts, old.attempts);
    queue.complete(old, now + 62_000);
    queue.fail(old, 503, 1000, true, now + 62_000);
    assert.deepEqual(queue.stats(), { delivering: 1 });
    queue.complete(current, now + 63_000);
    assert.deepEqual(queue.stats(), { sent: 1 });
  } finally { queue.close(); }
});

test('retry guidance supports seconds, HTTP dates, backoff, and jitter', () => {
  assert.equal(retryDelay(1, '30', now, () => 0.5), 30_000);
  assert.equal(retryDelay(1, new Date(now + 90_000).toUTCString(), now, () => 0.5), 90_000);
  assert.equal(retryDelay(3, null, now, () => 0.5), 4000);
  assert.equal(retryDelay(1, 'invalid', now, () => 0.5), 1000);
  assert.equal(retryDelay(1, '0', now, () => 0.5), 1000);
  assert.equal(retryDelay(1, '86400', now, () => 0.5), 86_400_000);
  assert(retryDelay(20, null, now, () => 0) <= 300_000);
});

test('relay target validation rejects arbitrary hosts, credentials, and redirects', () => {
  assert.equal(makeWebhookUrl(target), target);
  for (const bad of ['http://hook.eu1.make.com/path', 'https://evil.example/path', 'https://hook.eu1.make.com.evil.example/path', 'https://user:pass@hook.eu1.make.com/path', target + '?secret=x', target + '#fragment', 'https://hook.eu1.make.com:8443/path']) assert.throws(() => makeWebhookUrl(bad));
});

test('relay HTTP boundary queues only valid signed events and returns fast acknowledgement', async t => {
  const queue = new Queue(':memory:');
  const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => now, maxBodyBytes: 1024 });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => relay.server.close(resolve)); queue.close(); });
  const url = `http://127.0.0.1:${relay.server.address().port}/events`;
  const raw = Buffer.from(JSON.stringify(event));
  assert.equal((await fetch(url, { method: 'POST', headers: sign(raw), body: raw })).status, 202);
  const duplicate = await fetch(url, { method: 'POST', headers: sign(raw), body: raw });
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'POST', body: raw })).status, 415);
  const large = Buffer.from(JSON.stringify({ ...event, message: 'x'.repeat(1500) }));
  assert.equal((await fetch(url, { method: 'POST', headers: sign(large), body: large })).status, 413);
  assert.deepEqual(queue.stats(), { queued: 1 });
});

test('relay retries delivery failures, honors Retry-After, and signs each retry afresh', async () => {
  const queue = new Queue(':memory:');
  let clock = now; const sent = []; const logs = [];
  const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => clock, report: entry => logs.push(entry), fetchImpl: async (url, options) => {
    assert.equal(url, target); assert.equal(options.redirect, 'error'); sent.push(JSON.parse(options.body));
    return sent.length === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }) : new Response('{"received":true}', { status: 202 });
  } });
  try {
    queue.enqueue(event, Buffer.from(JSON.stringify(event)), clock);
    await relay.tick(); assert.deepEqual(queue.stats(), { queued: 1 });
    clock += 29_999; await relay.tick(); assert.equal(sent.length, 1);
    clock += 1; await relay.tick(); assert.deepEqual(queue.stats(), { sent: 1 });
    assert.equal(sent[0].delivery_id, sent[1].delivery_id); assert.notEqual(sent[0].signature, sent[1].signature);
    assert(!JSON.stringify(logs).includes(workspaceSecret)); assert(!JSON.stringify(logs).includes(relaySecret)); assert(!JSON.stringify(logs).includes('transcript_status'));
  } finally { queue.close(); }
});

test('relay preserves rejected acknowledgements and permanent failures', async () => {
  for (const [status, body, expected] of [[200, 'Accepted', 'queued'], [202, '{}', 'queued'], [401, '{}', 'dead'], [404, '{}', 'dead'], [503, '{}', 'queued']]) {
    const queue = new Queue(':memory:');
    const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => now, fetchImpl: async () => new Response(body, { status }) });
    try { queue.enqueue(event, Buffer.from(JSON.stringify(event)), now); await relay.tick(); assert.equal(queue.stats()[expected], 1); }
    finally { queue.close(); }
  }
});

test('network timeouts and connection failures retry without leaking response details', async () => {
  const queue = new Queue(':memory:');
  const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => now, fetchImpl: async () => { throw new Error('Sensitive remote payload'); } });
  try { queue.enqueue(event, Buffer.from(JSON.stringify(event)), now); await relay.tick(); assert.deepEqual(queue.stats(), { queued: 1 }); }
  finally { queue.close(); }
});

test('relay stops reading an oversized Make acknowledgement and keeps the event queued', async () => {
  const queue = new Queue(':memory:');
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(4097, ' ')); },
    cancel() { cancelled = true; }
  });
  const relay = createRelay({ queue, workspaceSecret, relaySecret, webhookUrl: target, now: () => now, fetchImpl: async () => new Response(body, { status: 202 }) });
  try {
    queue.enqueue(event, Buffer.from(JSON.stringify(event)), now);
    await relay.tick();
    assert.equal(cancelled, true);
    assert.deepEqual(queue.stats(), { queued: 1 });
  } finally { queue.close(); }
});
