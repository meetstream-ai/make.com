import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { executeModule } from './lib/local-runtime.mjs';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
const evidenceDir = new URL('../.local/', import.meta.url);
const key = process.env.MEETSTREAM_API_KEY;
const botId = process.env.MEETSTREAM_TEST_BOT_ID;
if (!key || !botId) {
  console.error('Live verification requires MEETSTREAM_API_KEY and MEETSTREAM_TEST_BOT_ID set locally. No live tests were executed.');
  process.exitCode = 2;
} else {
  const results = [];
  for (const module of ['getBot', 'getTranscriptions', 'getLatestTranscription', 'getSummary', 'getRecording', 'makeApiCall']) {
    try {
      await executeModule(bundle.modules[module], bundle.base, module === 'makeApiCall' ? { url: '/api/v1/bots', method: 'GET' } : { botId }, key);
      results.push({ module, passed: true });
    } catch (error) { results.push({ module, passed: false, status: error.status || 0, type: error.type || 'TransportError' }); }
  }
  if (process.env.MEETSTREAM_TEST_TRANSCRIPT_ID) {
    try { await executeModule(bundle.modules.getTranscript, bundle.base, { transcriptId: process.env.MEETSTREAM_TEST_TRANSCRIPT_ID }, key); results.push({ module: 'getTranscript', passed: true }); }
    catch (error) { results.push({ module: 'getTranscript', passed: false, status: error.status || 0 }); }
  }
  const connection = bundle.connections.apiKey.api;
  try {
    const response = await fetch(connection.url, { headers: { Authorization: 'Token synthetic-invalid-key' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    results.push({ module: 'invalidCredentials', passed: [401, 403].includes(response.status), status: response.status });
  } catch { results.push({ module: 'invalidCredentials', passed: false, status: 0, type: 'TransportError' }); }
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(new URL('live-evidence.json', evidenceDir), JSON.stringify({ at: new Date().toISOString(), engine: 'local contract harness against live MeetStream; not Make runtime', results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
