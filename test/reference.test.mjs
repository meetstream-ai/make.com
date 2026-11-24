import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeModule } from '../scripts/lib/local-runtime.mjs';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
const reference = JSON.parse(await readFile(new URL('../reference/n8n-contract.json', import.meta.url)));
const input = { meetingLink: 'https://meet.google.com/example-only', deduplicationKey: 'synthetic-logical-create' };
async function requestBody(parameters) {
  let body;
  await executeModule(bundle.modules.createBot, bundle.base, { ...input, ...parameters }, 'synthetic-api-key', {
    fetchImpl: async (_, options) => { body = JSON.parse(options.body); return new Response('{"bot_id":"synthetic"}', { status: 201 }); }
  });
  return body;
}

test('reference commit and n8n request defaults are pinned', async () => {
  assert.equal(reference.repository, 'https://github.com/meetstream-ai/n8n-plugin');
  assert.equal(reference.commit, '5319cd482c3cb17b836c0dd72d307117b1919729');
  assert.equal(bundle.base.baseUrl + '/api/v1', reference.baseUrl);
  for (const [operation, endpoint] of Object.entries(reference.endpoints)) {
    const module = bundle.modules[operation === 'removeBot' ? 'leaveMeeting' : operation];
    const expectedPath = operation === 'createBot'
      ? '/api/v1/bots/' + endpoint
      : '/api/v1/bots/{{encodeURL(parameters.botId)}}/' + endpoint;
    assert.equal(module.api.url, expectedPath);
  }
  const body = await requestBody({});
  assert.equal(body.bot_name, reference.defaults.botName); assert.equal(body.video_required, reference.defaults.videoRequired);
  assert.equal(body.recording_config, undefined); assert.equal(body.custom_attributes, undefined);
});

test('all eight providers use the reference defaults and retain native option types', async () => {
  for (const [provider, defaults] of Object.entries(reference.providers)) {
    const live = provider.endsWith('_streaming');
    const body = await requestBody({ transcriptionMode: live ? 'live' : 'postCall', [live ? 'liveProvider' : 'postCallProvider']: provider, ...(live ? { liveWebhookUrl: 'https://stream.example.invalid/webhook' } : {}) });
    assert.deepEqual(body.recording_config, { transcript: { provider: { [provider]: defaults } } }, provider);
    assert.equal(body.live_transcription_required?.webhook_url, live ? 'https://stream.example.invalid/webhook' : undefined);
  }
});

test('language selection and JSON overrides match n8n precedence', async () => {
  const deepgram = await requestBody({ transcriptionMode: 'postCall', postCallProvider: 'deepgram', transcriptionLanguage: 'hi', providerOptions: '{"paragraphs":false,"language":"en","utt_split":1.25}' });
  assert.deepEqual(deepgram.recording_config.transcript.provider.deepgram, { ...reference.providers.deepgram, language: 'en', paragraphs: false, utt_split: 1.25 });
  const assembly = await requestBody({ transcriptionMode: 'postCall', postCallProvider: 'assemblyai', transcriptionLanguage: 'en_uk' });
  assert.equal(assembly.recording_config.transcript.provider.assemblyai.language_code, 'en_uk');
  const captions = await requestBody({ transcriptionMode: 'postCall', postCallProvider: 'meeting_captions', transcriptionLanguage: 'ignored' });
  assert.deepEqual(captions.recording_config.transcript.provider.meeting_captions, {});
});

test('complete configuration override and the old post mode remain compatible', async () => {
  const config = { transcript: { provider: { deepgram: { model: 'custom' } } } };
  const body = await requestBody({ transcriptionMode: 'post', recordingConfig: JSON.stringify(config) });
  assert.deepEqual(body.recording_config, config);
});

test('latest successful transcript follows the reference selection across unsorted and failed jobs', async () => {
  const jobs = { transcriptions: [null,
    { transcript_id: 'older-success', status: 'Success', created_at: '2026-10-10T10:00:00Z' },
    { transcript_id: 'newer-failed', status: 'Failed', created_at: '2026-10-14T10:00:00Z' },
    { transcript_id: 'latest-success', status: 'Success', created_at: '2026-10-13T10:00:00Z' },
    { transcript_id: 'newer-processing', status: 'Processing', created_at: '2026-10-14T11:00:00Z' }
  ] };
  const output = await executeModule(bundle.modules.getLatestTranscription, bundle.base, { botId: 'bot' }, 'synthetic', { fetchImpl: async () => new Response(JSON.stringify(jobs)) });
  assert.equal(output.transcript_id, 'latest-success');
  await assert.rejects(executeModule(bundle.modules.getLatestTranscription, bundle.base, { botId: 'bot' }, 'synthetic', { fetchImpl: async () => new Response('{"transcriptions":[]}') }), error => error.type === 'DataError' && /No successful/.test(error.message));
});

test('IDs containing slash and spaces are encoded as a single path segment like n8n', async () => {
  for (const [module, parameters, suffix] of [
    ['getBot', { botId: 'bot/with spaces' }, '/bots/bot%2Fwith%20spaces/detail'],
    ['getTranscriptions', { botId: 'bot/with spaces' }, '/bots/bot%2Fwith%20spaces/transcriptions'],
    ['getRecording', { botId: 'bot/with spaces' }, '/bots/bot%2Fwith%20spaces/get_video'],
    ['getSummary', { botId: 'bot/with spaces' }, '/bots/bot%2Fwith%20spaces/summary'],
    ['leaveMeeting', { botId: 'bot/with spaces' }, '/bots/bot%2Fwith%20spaces/remove_bot'],
    ['getTranscript', { transcriptId: 'transcript/with spaces', raw: true }, '/transcript/transcript%2Fwith%20spaces/get_transcript']
  ]) await executeModule(bundle.modules[module], bundle.base, parameters, 'synthetic', { fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://api.meetstream.ai'); assert.equal(url.pathname, '/api/v1' + suffix);
    assert.equal(bundle.modules[module].api.encodeUrl, false);
    if (module === 'leaveMeeting') assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(module === 'getTranscript' ? [] : { bot_details: {}, transcriptions: [], video_url: 'https://media.example.invalid/video' }));
  } });
});

test('latest transcript compares offset dates and ranks missing or malformed dates last', async () => {
  const rows = [
    { status: 'Success', transcript_id: 'older', created_at: '2026-10-20T10:00:00+05:30' },
    { status: 'Success', transcript_id: 'newer', created_at: '2026-10-20T06:00:00Z' },
    { status: 'Success', transcript_id: 'invalid', created_at: 'not-a-date' },
    { status: 'Success', transcript_id: 'unknown' },
    { status: 'Success', created_at: '2026-10-22T06:00:00Z' },
    { status: 'Success', transcript_id: '   ', created_at: '2026-10-23T06:00:00Z' },
    { status: 'Failed', transcript_id: 'failed', created_at: '2026-10-22T06:00:00Z' }
  ];
  for (const transcriptions of [rows, [...rows].reverse(), [rows[3]]]) {
    const result = await executeModule(bundle.modules.getLatestTranscription, bundle.base, { botId: 'bot' }, 'synthetic', { fetchImpl: async () => new Response(JSON.stringify({ transcriptions })) });
    assert.equal(result.transcript_id, transcriptions.length === 1 ? 'unknown' : 'newer');
  }
});
