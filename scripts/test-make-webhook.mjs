import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { envelope, makeWebhookUrl } from '../relay/security.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) throw new Error('Usage: npm run test:make-webhook -- LOCAL_SECRET_CONFIG.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const url = makeWebhookUrl(config.url);
if (typeof config.relaySecret !== 'string' || config.relaySecret.length < 32) throw new Error('Configure a test relaySecret of at least 32 characters locally');
const payload = JSON.stringify({ bot_id: 42, bot_event: 'video.processed', event: 'bot.stopped', video_status: 'Success', timestamp: new Date().toISOString(), message: 'Synthetic "quoted" speech\nनमस्ते 😀', custom_attributes: { source: 'make_synthetic_validation' } });
const makeEnvelope = offset => envelope({ id: randomUUID(), payload }, config.relaySecret, Date.now() + offset);
const cases = [
  { name: 'invalid signature', method: 'POST', body: { ...makeEnvelope(0), signature: '0'.repeat(64) }, status: 401, received: false },
  { name: 'expired envelope', method: 'POST', body: makeEnvelope(-900_000), status: 401, received: false },
  { name: 'future envelope', method: 'POST', body: makeEnvelope(900_000), status: 401, received: false },
  { name: 'tampered payload', method: 'POST', body: { ...makeEnvelope(0), payload: payload + ' ' }, status: 401, received: false },
  { name: 'unsigned request', method: 'POST', body: {}, status: 401, received: false },
  { name: 'GET request', method: 'GET', status: 401, received: false },
  { name: 'valid synthetic event', method: 'POST', body: makeEnvelope(0), status: 202, received: true }
];
const results = [];
for (const check of cases) {
  try {
    const response = await fetch(url, { method: check.method, headers: { 'Content-Type': 'application/json' }, ...(check.body ? { body: JSON.stringify(check.body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const acknowledgement = await response.json().catch(() => ({}));
    results.push({ name: check.name, status: response.status, received: acknowledgement.received === true, passed: response.status === check.status && acknowledgement.received === check.received });
  } catch {
    results.push({ name: check.name, passed: false, error: 'Transport failure; endpoint and error details omitted' });
  }
  console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'}: ${check.name}`);
}
await mkdir(path.join(root, '.local'), { recursive: true });
await writeFile(path.join(root, '.local/live-make-webhook.json'), JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2) + '\n');
if (results.some(result => !result.passed)) process.exitCode = 1;
