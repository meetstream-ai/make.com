import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { evaluate, executeModule, validateParameters } from '../scripts/lib/local-runtime.mjs';
import { envelope } from '../relay/security.mjs';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
const secret = 'synthetic-test-credential-do-not-use';
function mock(body, status = 200, headers = {}) { return async () => new Response(JSON.stringify(body), { status, headers }); }
const run = (name, input, body, status = 200, options = {}) => executeModule(bundle.modules[name], bundle.base, input, secret, { fetchImpl: mock(body, status), ...options });

test('actual native requests carry Token authentication and stay on MeetStream', async () => {
  const cases = [
    ['getBot', { botId: 'bot-example' }, '/api/v1/bots/bot-example/detail', 'GET', { bot_details: { BotID: 'bot-example', Status: 'Stopped' } }],
    ['getTranscriptions', { botId: 'bot-example' }, '/api/v1/bots/bot-example/transcriptions', 'GET', { transcriptions: [] }],
    ['getTranscript', { transcriptId: 'transcript-example' }, '/api/v1/transcript/transcript-example/get_transcript', 'GET', []],
    ['getSummary', { botId: 'bot-example' }, '/api/v1/bots/bot-example/summary', 'GET', { summary: 'Synthetic completed summary' }],
    ['getRecording', { botId: 'bot-example' }, '/api/v1/bots/bot-example/get_video', 'GET', { video_url: 'https://media.example.invalid/video' }],
    ['leaveMeeting', { botId: 'bot-example' }, '/api/v1/bots/bot-example/remove_bot', 'GET', { bot_id: 'bot-example', status: 'stopping' }],
    ['makeApiCall', { url: '/api/v1/bots', method: 'GET' }, '/api/v1/bots', 'GET', { bots: [] }]
  ];
  for (const [name, input, pathname, method, body] of cases) await run(name, input, body, 200, { fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://api.meetstream.ai'); assert.equal(url.pathname, pathname);
    assert.equal(options.headers.Authorization, `Token ${secret}`); assert.equal(options.method, method); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(body));
  } });
});

test('create validates nested live requirements and safely omits inactive options', async () => {
  const input = { meetingLink: 'https://meet.google.com/example-only', deduplicationKey: 'calendar:occurrence' };
  await run('createBot', input, { bot_id: 'bot-example' }, 201, { fetchImpl: async (_, options) => {
    assert.equal(options.headers['Idempotency-Key'], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.deduplication_key, input.deduplicationKey); assert.equal(body.video_required, false);
    assert.equal(body.recording_config, undefined);
    assert.equal(body.custom_attributes, undefined);
    assert.equal(body.join_at, undefined); assert.equal(body.callback_url, undefined); assert.equal(body.live_transcription_required, undefined);
    return new Response('{"bot_id":"bot-example"}', { status: 201 });
  } });
  await assert.rejects(run('createBot', { ...input, transcriptionMode: 'live' }, {}, 201), /required/);
  await run('createBot', { ...input, transcriptionMode: 'live', liveWebhookUrl: 'https://stream.example.invalid/webhook' }, {}, 201, { fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); assert(body.recording_config.transcript.provider.deepgram_streaming); assert.equal(body.live_transcription_required.webhook_url, 'https://stream.example.invalid/webhook');
    return new Response('{"bot_id":"bot-example"}', { status: 201 });
  } });
  await run('createBot', { ...input, transcriptionMode: 'none', videoRequired: true }, {}, 201, { fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); assert.equal(body.recording_config, undefined); assert.equal(body.video_required, true); return new Response('{}', { status: 201 });
  } });
});

test('native deduplication replays HTTP 200 and refuses HTTP 507', async () => {
  const input = { meetingLink: 'https://meet.google.com/example-only', deduplicationKey: 'calendar:occurrence' };
  assert.equal((await run('createBot', input, { bot_id: 'same-bot' }, 200)).replayed, true);
  await assert.rejects(run('createBot', input, { bot_id: 'same-bot' }, 507), error => error.type === 'DataError' && /Do not retry/.test(error.message));
});

test('invalid mapped inputs are rejected before requests', async () => {
  let requests = 0;
  for (const [name, input] of [
    ['getBot', { botId: '' }], ['getBot', { botId: '..' }], ['getTranscript', { transcriptId: '   ' }],
    ['createBot', { meetingLink: 'http://meet.google.com/test', deduplicationKey: 'key' }],
    ['createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'key\r\nheader' }],
    ['createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'x'.repeat(2001) }],
    ['createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'key', customAttributes: '[]' }],
    ['createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'key', customAttributes: '{broken}' }],
    ['createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'key', joinAt: 'bad date' }],
    ['getTranscriptions', { botId: 'bot', limit: 101 }]
  ]) await assert.rejects(executeModule(bundle.modules[name], bundle.base, input, secret, { fetchImpl: async () => { requests++; return new Response('{}'); } }));
  assert.equal(requests, 0);
});

test('permanent failures remain errors without exposing remote bodies', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    let requests = 0;
    await assert.rejects(run('getSummary', { botId: 'bot-example' }, {}, status, { fetchImpl: async () => { requests++; return new Response(JSON.stringify({ message: secret }), { status, headers: { 'Retry-After': '30' } }); } }), error => {
      assert.equal(error.status, status); assert(!error.message.includes(secret));
      if (status === 403) assert.equal(error.type, 'DataError');
      if (status === 429) { assert.equal(error.type, 'RateLimitError'); assert.equal(error.retryAfter, '30'); assert(error.message.includes('30')); }
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('summary output preserves the complete API response without assuming a response shape', async () => {
  for (const body of [{ summary: 'Meeting summary 👋', action_items: ['Follow up'] }, ['first', 'second'], 'Summary text']) {
    const result = await run('getSummary', { botId: 'synthetic-summary-bot' }, body);
    assert.equal(result.bot_id, 'synthetic-summary-bot');
    assert.deepEqual(result.summary, body);
    assert.deepEqual(JSON.parse(result.summary_json), body);
  }
});

test('summary processing and empty responses cannot masquerade as completed summaries', async () => {
  for (const [status, body] of [[202, { message: 'Processing', private: secret }], [200, null], [200, {}], [200, []], [200, ''], [200, ' \n\t '], [201, { summary: 'Unexpected status' }]]) {
    await assert.rejects(run('getSummary', { botId: 'bot-example' }, body, status), error => {
      assert.equal(error.type, 'DataError'); assert.equal(error.status, status);
      assert.match(error.message, /No completed summary/); assert(!error.message.includes(secret));
      return true;
    });
  }
  await assert.rejects(run('getSummary', { botId: 'bot-example' }, { detail: 'Not Found' }, 404), error => /confirm summary API support/.test(error.message));
});

test('transcript variants preserve Unicode, empty and large data in one bundle', async () => {
  for (const body of [[], [{ speaker: '例', transcript: 'Hello 👋 नमस्ते', start_time: 0, end_time: 1 }], [{ participant: { id: 100, name: '例' }, words: [{ text: 'Hello' }, { text: '世界' }] }], [{ transcript: 'x'.repeat(200_000) }]]) {
    const result = await run('getTranscript', { transcriptId: 'transcript-example' }, body);
    assert.deepEqual(result.segments, body); assert.deepEqual(JSON.parse(result.raw_json), body); assert.equal(typeof result.text, 'string');
    if (body[0]?.participant) assert.equal(result.text, 'Hello 世界');
    else assert.equal(result.text, body[0]?.transcript || '');
  }
  const multiple = await run('getTranscript', { transcriptId: 'transcript-example' }, [{ transcript: 'one' }, { transcript: 'two' }]);
  assert.equal(multiple.text, 'one\ntwo');
  const raw = await run('getTranscript', { transcriptId: 'transcript-example', raw: true }, { arbitrary: ['provider', 'response'] });
  assert.equal(raw.text, ''); assert.equal(raw.segments, null); assert.deepEqual(JSON.parse(raw.raw_json), { arbitrary: ['provider', 'response'] });
});

test('transcription list respects limits and maps dates without inventing pagination', async () => {
  const rows = [{ transcript_id: 'one', status: 'Success', created_at: '2026-10-13T12:00:00.000000+00:00' }, { transcript_id: 'two', status: 'Processing' }];
  const output = await run('getTranscriptions', { botId: 'bot-example', limit: 1 }, { transcriptions: rows });
  assert.equal(output.length, 1); assert.equal(output[0].transcript_id, 'one'); assert.equal(output[0].created_at.toISOString(), '2026-10-13T12:00:00.000Z'); assert.equal(bundle.modules.getTranscriptions.api.pagination, undefined);
});

test('recording not-ready and stop-in-progress are handled', async () => {
  await assert.rejects(run('getRecording', { botId: 'bot-example' }, { message: 'processing' }, 202), /not ready/);
  const output = await run('leaveMeeting', { botId: 'bot-example' }, { bot_id: 'bot-example', status: 'stopping', requested_at: 1791892800 }, 202);
  assert.equal(output.status, 'stopping'); assert(output.requested_at instanceof Date);
});

test('date formatting respects offsets, daylight saving boundaries, and absent values', async () => {
  for (const joinAt of ['2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00', '2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', '2026-10-20T11:34:00+05:30']) {
    await run('createBot', { meetingLink: 'https://meet.google.com/test', deduplicationKey: 'key', joinAt }, {}, 201, { fetchImpl: async (_, options) => { assert.equal(JSON.parse(options.body).join_at, new Date(joinAt).toISOString()); return new Response('{}', { status: 201 }); } });
  }
  const result = await run('getBot', { botId: 'bot' }, { bot_details: { BotID: 'bot', CreatedAt: '', LastUpdatedAt: null } });
  assert.equal(result.created_at, null); assert.equal(result.updated_at, null);
});

test('universal API rejects host injection and credential overrides', async () => {
  for (const url of ['https://evil.example/api/v1/bots', '//evil.example', '/api/v1/../bots', '/api/v1/bots?url=https://evil.example', '/api/v1/bots\n']) assert.throws(() => validateParameters(bundle.modules.makeApiCall.expect, { url, method: 'GET' }));
  for (const key of ['Authorization', 'authorization', 'aUtHoRiZaTiOn', 'Host', 'Cookie', 'Proxy-Authorization']) assert.throws(() => validateParameters(bundle.modules.makeApiCall.expect, { url: '/api/v1/bots', method: 'GET', headers: [{ key, value: 'anything' }] }));
  const output = await run('makeApiCall', { url: '/api/v1/bots', method: 'GET', qs: [{ key: 'status', value: 'Stopped' }], headers: [{ key: 'Accept', value: 'application/json' }] }, { bots: [] }, 200, { fetchImpl: async (url, options) => { assert.equal(url.searchParams.get('status'), 'Stopped'); assert.equal(options.headers.Authorization, `Token ${secret}`); return new Response('{"bots":[]}', { headers: { 'set-cookie': 'secret', 'content-type': 'application/json' } }); } });
  assert.equal(output.headers['set-cookie'], undefined);
});

test('webhook definitions verify relay HMAC, enforce freshness and prefer bot_event', () => {
  const relaySecret = 'synthetic-relay-secret-at-least-32-bytes';
  const now = new Date('2026-10-13T12:00:00Z');
  const payload = JSON.stringify({ bot_id: 'bot-example', event: 'bot.stopped', bot_event: 'bot.denied' });
  const body = envelope({ id: 'synthetic-event', payload }, relaySecret, +now);
  const context = { body, method: 'POST', parameters: { relaySecret }, now };
  const definition = bundle.webhooks.meetingEvents.api;
  assert.equal(evaluate(definition.verification.condition, context), false);
  assert.equal(definition.respond.status, 202);
  assert.equal(definition.verification.respond.status, 401);
  assert.equal(evaluate(definition.output, context).bot_event, 'bot.denied');
  for (const bad of [{ ...body, payload: payload + ' ' }, { ...body, delivery_id: 'tampered' }, { ...body, signature: 'bad' }, envelope({ id: 'synthetic-event', payload }, relaySecret, +now - 301_000), envelope({ id: 'synthetic-event', payload }, relaySecret, +now + 301_000)]) {
    assert.equal(evaluate(definition.verification.condition, { ...context, body: bad }), true);
    assert.equal(definition.verification.respond.status, 401);
  }
});

test('request definitions execute against a local fixture HTTP service', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Token ${secret}`);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ bot_details: { BotID: 'fixture-bot', Status: 'Stopped' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const result = await executeModule(bundle.modules.getBot, bundle.base, { botId: 'fixture-bot' }, secret, { fetchImpl: (url, options) => fetch(`${local}${url.pathname}`, options) });
  assert.equal(result.bot_id, 'fixture-bot'); assert.equal(result.status, 'Stopped');
});

test('transport timeout is enforced on a real hanging HTTP request', async t => {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(executeModule(bundle.modules.getBot, bundle.base, { botId: 'bot' }, secret, { timeout: 30, fetchImpl: (url, options) => fetch(`${local}${url.pathname}`, options) }), error => error.name === 'TimeoutError');
});

test('mixed transcript segments retain speech without first-segment format inference', async () => {
  const segments = [null, { words: [null, {}, { text: 'Launch' }, { text: 'Friday.' }] },
    { participant: { name: 'Alex' }, transcript: 'Preferred text', words: [{ text: 'Do not duplicate' }] },
    { transcript: 42 }, { transcript: { nested: 'Invalid text' } }, { transcript: 'Legacy segment' }];
  const result = await run('getTranscript', { transcriptId: 'synthetic' }, segments);
  assert.match(result.text, /Launch Friday\./); assert.match(result.text, /Preferred text/); assert.match(result.text, /Legacy segment/);
  assert.doesNotMatch(result.text, /42|object Object|Do not duplicate/);
  assert.equal(result.text_incomplete, false); assert.deepEqual(result.segments, segments);
  const malformed = await run('getTranscript', { transcriptId: 'synthetic' }, [{ words: [{ text: 42 }, { text: 'Speech' }] }]);
  assert.equal(malformed.text, ''); assert.equal(malformed.text_incomplete, true);
  assert.match(malformed.raw_json, /Speech/);
  const escaped = await run('getTranscript', { transcriptId: 'synthetic' }, [{ words: [{ text: '"quoted" \\ Unicode 👋\nline' }] }]);
  assert.equal(escaped.text, '"quoted" \\ Unicode 👋\nline'); assert.equal(escaped.text_incomplete, false);
});

test('recording requires nonblank HTTPS text before a downstream download', async () => {
  for (const video_url of [undefined, null, '', ' ', 'http://media.example.invalid/video', 'https://media.example.invalid/a b', 'https://media.example.invalid/a\n', 42, {}, []]) {
    await assert.rejects(run('getRecording', { botId: 'synthetic' }, { video_url }), error => error.type === 'DataError' && /HTTPS/.test(error.message));
  }
  assert.equal((await run('getRecording', { botId: 'synthetic' }, { video_url: 'https://media.example.invalid/video?signature=synthetic' })).video_url, 'https://media.example.invalid/video?signature=synthetic');
});

test('harness retains native regex escapes and rejects null map entries observed in Make', () => {
  assert.equal(evaluate(String.raw`{{replace('[]', '/^\[\]$/', '')}}`), '');
  assert.throws(() => evaluate(String.raw`{{replace('[]', '/^\\[$/', '')}}`), /Invalid regular expression/);
  assert.throws(() => evaluate("{{map(rows, 'transcript_id', 'status', 'Success')}}", { rows: [null, { status: 'Success', transcript_id: 'synthetic' }] }), /null entries/);
  assert.equal(evaluate("{{join(rows, decodeURL('%0A'))}}", { rows: ['one', 'two'] }), 'one\ntwo');
});
