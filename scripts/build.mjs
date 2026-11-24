import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const reference = JSON.parse(await readFile(path.join(root, 'reference/n8n-contract.json'), 'utf8'));
const baseErrors = JSON.parse(await readFile(path.join(root, 'app/base.json'), 'utf8')).response.error;
const write = async (file, value) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
};
const field = (name, label, type = 'text', extra = {}) => {
  const value = { name, label, type, ...extra };
  if (value.validate?.pattern?.endsWith('$')) value.validate = { ...value.validate, pattern: value.validate.pattern + '(?![\\s\\S])' };
  return value;
};
const id = (name, label) => field(name, label, 'text', { required: true, validate: { min: 1, max: 256, pattern: '^(?!\\.{1,2}$)(?=[^\\r\\n]*\\S)[^\\r\\n]+$' } });
const json = (name, label, extra = {}) => field(name, label, 'text', { default: '{}', multiline: true, validate: { pattern: '^\\s*\\{[\\s\\S]*\\}\\s*$' }, ...extra });
const date = (name, label) => field(name, label, 'date');
const key = field('deduplicationKey', 'Deduplication Key', 'text', { required: true, validate: { min: 1, max: 2000, pattern: '^[\\x20-\\x7E]+$' }, help: 'Use one stable key per logical meeting, such as a calendar ID plus event occurrence ID. Reuse it on retries. Serialize creation: simultaneous first calls can create duplicates.' });
const select = (name, label, values, defaultValue) => field(name, label, 'select', { required: true, default: defaultValue, options: values.map(value => ({ label: value, value })) });
const botInterface = [field('bot_id', 'Bot ID'), field('transcript_id', 'Transcript ID'), field('meeting_url', 'Meeting URL'), field('status', 'Status'), date('join_at', 'Join At'), field('replayed', 'Replayed', 'boolean')];
const botSample = { bot_id: 'bot-example', transcript_id: 'transcript-example', meeting_url: 'https://meet.google.com/example-only', status: 'Scheduled', join_at: '2026-10-20T06:04:00.000Z', replayed: false };
const modules = {};
const providerOptions = (live = false) => [
  select(live ? 'liveProvider' : 'postCallProvider', 'Provider', Object.keys(reference.providers).filter(name => name.endsWith('_streaming') === live), live ? 'deepgram_streaming' : 'meetstream'),
  field('transcriptionLanguage', 'Language', 'text', { help: 'Optional provider language code. Leave blank for the provider default.' }),
  json('providerOptions', 'Provider Options (JSON)', { advanced: true, help: 'Overrides the provider defaults. Enter a JSON object.' })
];
const selectedProvider = "if(parameters.transcriptionMode == 'live', ifempty(parameters.liveProvider, 'deepgram_streaming'), ifempty(parameters.postCallProvider, 'meetstream'))";
const languageKey = "switch(" + selectedProvider + ", 'assemblyai', 'language_code', 'sarvam', 'language_code', 'language')";
const defaultsText = 'switch(' + selectedProvider + ', ' + Object.entries(reference.providers).map(([name, value]) => `'${name}', '${JSON.stringify(value).replace(/'/g, "\\'")}'`).join(', ') + ", '{}')";
const languageObject = `if(parameters.transcriptionLanguage && ${selectedProvider} != 'meeting_captions', parseJSON('{"' + ${languageKey} + '":' + createJSON(ifempty(parameters.transcriptionLanguage, '')) + '}'), parseJSON('{}'))`;
const optionsObject = `toCollection(merge(toArray(parseJSON(${defaultsText})), toArray(${languageObject}), toArray(parseJSON(ifempty(parameters.providerOptions, '{}')))), 'key', 'value')`;
const recordingObject = `parseJSON('{"transcript":{"provider":{' + createJSON(${selectedProvider}) + ':' + createJSON(${optionsObject}) + '}}}')`;
function module(name, label, description, expect, api, iface, sample, typeId = 4, parameters = []) {
  modules[name] = { metadata: { name, typeId, label, description, ...(typeId === 10 ? { webhook: 'meetingEvents' } : { connection: 'apiKey' }) }, parameters, expect, api, interface: iface, samples: sample };
}

module('createBot', 'Create a Bot', 'Creates or schedules a meeting bot with a stable deduplication key.', [
  field('meetingLink', 'Meeting URL', 'url', { required: true, validate: { pattern: '^[Hh][Tt][Tt][Pp][Ss]://[^\\s]+$' } }),
  field('botName', 'Bot Name', 'text', { required: true, default: 'MeetStream Notetaker', validate: { min: 1, max: 256 } }),
  key,
  date('joinAt', 'Join At'),
  field('videoRequired', 'Record Video', 'boolean', { required: true, default: reference.defaults.videoRequired }),
  field('transcriptionMode', 'Transcription', 'select', { required: true, default: reference.defaults.transcriptionMode, options: [
    { label: 'None', value: 'none' },
    { label: 'Post-call', value: 'post', nested: providerOptions() },
    { label: 'Post-call (n8n name)', value: 'postCall', nested: providerOptions() },
    { label: 'Live', value: 'live', nested: [...providerOptions(true), field('liveWebhookUrl', 'Live Transcript Webhook URL', 'url', { required: true, validate: { pattern: '^[Hh][Tt][Tt][Pp][Ss]://[^\\s]+$' }, help: 'Streaming transcript chunks use a separate channel from meeting events.' })] }
  ] }),
  json('recordingConfig', 'Recording Configuration Override', { advanced: true, help: 'Optional complete recording_config for existing advanced scenarios. A nonempty object overrides the provider controls. Do not enable a live provider in post-call mode.' }),
  field('callbackUrl', 'Lifecycle Callback URL', 'url', { advanced: true, validate: { pattern: '^[Hh][Tt][Tt][Pp][Ss]://[^\\s]+$' }, help: 'Per-bot callbacks are unsigned. Use a signed workspace webhook through the verification relay for production events.' }),
  json('customAttributes', 'Custom Attributes', { advanced: true, help: 'A JSON object echoed in events. Include destination keys, never credentials.' })
], {
  url: '/api/v1/bots/create_bot', method: 'POST', type: 'json',
  temp: { request: {
    meeting_link: '{{parameters.meetingLink}}', bot_name: '{{parameters.botName}}', deduplication_key: '{{parameters.deduplicationKey}}', video_required: '{{parameters.videoRequired}}',
    join_at: "{{if(parameters.joinAt, formatDate(parameters.joinAt, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', 'UTC'), null)}}",
    callback_url: '{{parameters.callbackUrl}}', custom_attributes: "{{parseJSON(ifempty(parameters.customAttributes, '{}'))}}",
    recording_config: `{{if(length(keys(parseJSON(ifempty(parameters.recordingConfig, '{}')))) > 0, parseJSON(ifempty(parameters.recordingConfig, '{}')), ${recordingObject})}}`,
    live_transcription_required: { webhook_url: '{{parameters.liveWebhookUrl}}' }
  } },
  body: "{{omit(temp.request, if(parameters.joinAt, '', 'join_at'), if(parameters.callbackUrl, '', 'callback_url'), if(parameters.transcriptionMode == 'none', 'recording_config', ''), if(parameters.transcriptionMode == 'live', '', 'live_transcription_required'), if(length(keys(parseJSON(ifempty(parameters.customAttributes, '{}')))) == 0, 'custom_attributes', ''))}}",
  response: { output: { bot_id: '{{body.bot_id}}', transcript_id: '{{body.transcript_id}}', meeting_url: '{{body.meeting_url}}', status: '{{body.status}}', join_at: "{{if(body.join_at, parseDate(body.join_at, 'YYYY-MM-DDTHH:mm:ss.SSSZ'), null)}}", replayed: '{{statusCode == 200}}' } }
}, botInterface, botSample);

module('getBot', 'Get a Bot', 'Retrieves bot details and current status.', [id('botId', 'Bot ID')], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/detail', encodeUrl: false, method: 'GET',
  response: { output: {
    bot_id: '{{body.bot_details.BotID}}', status: '{{body.bot_details.Status}}', meeting_url: '{{body.bot_details.MeetingLink}}', platform: '{{body.bot_details.Platform}}', transcript_id: '{{body.bot_details.transcript_id}}',
    created_at: "{{if(body.bot_details.CreatedAt, parseDate(body.bot_details.CreatedAt, 'YYYY-MM-DDTHH:mm:ss.SSSZ'), null)}}",
    updated_at: "{{if(body.bot_details.LastUpdatedAt, parseDate(body.bot_details.LastUpdatedAt, 'X'), null)}}", details: '{{body.bot_details}}'
  } }
}, [field('bot_id', 'Bot ID'), field('status', 'Status'), field('meeting_url', 'Meeting URL'), field('platform', 'Platform'), field('transcript_id', 'Transcript ID'), date('created_at', 'Created At'), date('updated_at', 'Updated At'), field('details', 'Bot Details', 'collection')], { bot_id: 'bot-example', status: 'Stopped', platform: 'GoogleMeet', transcript_id: 'transcript-example', details: {} });

module('getTranscriptions', 'List Transcriptions', 'Lists transcription jobs and their transcript IDs for a bot.', [id('botId', 'Bot ID'), field('limit', 'Limit', 'uinteger', { required: true, default: 10, validate: { min: 1, max: 100 } })], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/transcriptions', encodeUrl: false, method: 'GET',
  response: { limit: '{{parameters.limit}}', iterate: '{{body.transcriptions}}', output: { bot_id: '{{parameters.botId}}', transcript_id: '{{item.transcript_id}}', provider: '{{item.provider}}', status: '{{item.status}}', created_at: "{{if(item.created_at, parseDate(item.created_at, 'YYYY-MM-DDTHH:mm:ss.SSSZ'), null)}}", config: '{{item.config}}', download_urls: '{{item.download_urls}}' } }
}, [field('bot_id', 'Bot ID'), field('transcript_id', 'Transcript ID'), field('provider', 'Provider'), field('status', 'Status'), date('created_at', 'Created At'), field('config', 'Configuration', 'collection'), field('download_urls', 'Download URLs', 'collection')], { bot_id: 'bot-example', transcript_id: 'transcript-example', provider: 'meetstream', status: 'Success', created_at: '2026-10-13T12:00:00.000Z' }, 9);

// Normalize dates per job before sorting: ISO strings with offsets do not sort
// chronologically. A wrapper keeps this action's single-bundle interface.
const latestTranscript = "get(first(sort(output, 'desc', 'created_at')), 'transcript_id')";
const isoDatePattern = '/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})$/';
const stringValue = value => `substring(createJSON(${value}), 0, 1) == '\"'`;
const hasTranscript = `${stringValue("get(item, 'transcript')")} && trim(get(item, 'transcript'))`;
// Validate the mapped word-text array as JSON strings before joining. Null/missing
// word text is omitted by map; other types flag incomplete text instead of coercing
// objects/numbers into a CRM transcript.
const wordStrings = String.raw`/^\[(?:"(?:[^"\\]|\\.)*"(?:,"(?:[^"\\]|\\.)*")*)?\]$/`;
const wordTexts = "remove(map(remove(get(item, 'words'), null), 'text'), null)";
const validWords = `replace(createJSON(${wordTexts}), '${wordStrings}', '') == ''`;
const segmentText = `if(${hasTranscript}, get(item, 'transcript'), if(${validWords}, join(${wordTexts}, ' '), ''))`;

module('getLatestTranscription', 'Get the Latest Successful Transcription', 'Retrieves the latest completed post-call transcription ID for a bot.', [id('botId', 'Bot ID')], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/transcriptions', encodeUrl: false, method: 'GET',
  response: {
    valid: { condition: "{{length(trim(join(map(remove(body.transcriptions, null), 'transcript_id', 'status', 'Success'), ''))) > 0}}", type: 'DataError', message: 'No successful post-call transcription is ready. Wait for transcription.processed, then try again. Caption and live providers use separate artifacts.' },
    iterate: { container: '{{remove(body.transcriptions, null)}}', condition: "{{item && item.status == 'Success' && trim(toString(item.transcript_id))}}" },
    output: { transcript_id: '{{item.transcript_id}}', created_at: `{{if(item.created_at && replace(item.created_at, '${isoDatePattern}', '') == '', formatDate(parseDate(if(item.created_at && replace(item.created_at, '${isoDatePattern}', '') == '', item.created_at, '1970-01-01T00:00:00Z'), 'YYYY-MM-DDTHH:mm:ss.SSSZ'), 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', 'UTC'), '')}}` },
    wrapper: { bot_id: '{{parameters.botId}}', transcript_id: '{{' + latestTranscript + '}}' }
  }
}, [field('bot_id', 'Bot ID'), field('transcript_id', 'Transcript ID')], { bot_id: 'bot-example', transcript_id: 'transcript-example' });

module('getTranscript', 'Get a Transcript', 'Retrieves transcript text, segments, and metadata by transcript ID.', [id('transcriptId', 'Transcript ID'), field('raw', 'Raw Provider Response', 'boolean', { required: true, default: false })], {
  url: '/api/v1/transcript/{{encodeURL(parameters.transcriptId)}}/get_transcript', encodeUrl: false, method: 'GET', qs: { raw: '{{if(parameters.raw, true, null)}}' },
  response: {
    iterate: "{{remove(if(parameters.raw, parseJSON('[]'), body), null)}}",
    output: { text: '{{' + segmentText + '}}', incomplete: '{{!(' + hasTranscript + ') && !(' + validWords + ')}}' },
    wrapper: {
    transcript_id: '{{parameters.transcriptId}}',
    text: "{{if(parameters.raw, '', join(remove(map(output, 'text'), ''), decodeURL('%0A')))}}",
    text_incomplete: "{{length(map(output, 'incomplete', 'incomplete', true)) > 0}}",
    segments: '{{if(parameters.raw, null, body)}}', raw_json: '{{createJSON(body)}}', raw: '{{parameters.raw}}'
  } }
}, [field('transcript_id', 'Transcript ID'), field('text', 'Transcript Text'), field('text_incomplete', 'Text Contains Unsupported Word Values', 'boolean'), field('segments', 'Segments / Participant Groups', 'array', { spec: [field('speaker', 'Speaker'), field('transcript', 'Transcript'), field('start_time', 'Start Time', 'number'), field('end_time', 'End Time', 'number'), field('participant', 'Participant', 'collection', { spec: [field('id', 'ID', 'integer'), field('name', 'Name'), field('platform', 'Platform')] }), field('words', 'Words', 'array', { spec: [field('text', 'Text'), field('word', 'Word'), field('punctuated_word', 'Punctuated Word'), field('start_timestamp', 'Start Timestamp', 'any'), field('end_timestamp', 'End Timestamp', 'any')] }), field('language_code', 'Language Code')] }), field('raw_json', 'Full Response JSON'), field('raw', 'Raw Provider Response', 'boolean')], { transcript_id: 'transcript-example', text: 'This is a synthetic transcript.', text_incomplete: false, segments: [{ speaker: 'Example Speaker', transcript: 'This is a synthetic transcript.', start_time: 0, end_time: 3 }], raw_json: '[]', raw: false });

module('getSummary', 'Get a Summary', 'Retrieves a completed summary when supported; rejects processing and empty responses.', [id('botId', 'Bot ID')], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/summary', encodeUrl: false, method: 'GET',
  response: {
    valid: {
      condition: String.raw`{{statusCode == 200 && body != null && createJSON(body) != '{}' && createJSON(body) != '[]' && replace(createJSON(body), '/^"(?:\\[nrt]|\s)*"$/', '') != ''}}`,
      type: 'DataError',
      message: 'No completed summary was returned. HTTP 202 means processing; retry later with a bounded policy. An empty 200 response is not a completed summary.'
    },
    error: { ...baseErrors, '404': { type: 'DataError', message: '[404] The summary endpoint or this bot\'s summary is unavailable. Verify the bot with Get a Bot and confirm summary API support with MeetStream. Waiting or retranscribing is not guaranteed to resolve this response.' } },
    output: { bot_id: '{{parameters.botId}}', summary: '{{body}}', summary_json: '{{createJSON(body)}}' }
  }
}, [field('bot_id', 'Bot ID'), field('summary', 'Summary', 'any'), field('summary_json', 'Summary JSON')], { bot_id: 'bot-example', summary: { summary: 'Synthetic meeting summary.' }, summary_json: '{"summary":"Synthetic meeting summary."}' });

module('getRecording', 'Get a Recording', 'Retrieves video metadata and a fresh download URL valid for one hour.', [id('botId', 'Bot ID')], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/get_video', encodeUrl: false, method: 'GET',
  response: {
    valid: { condition: `{{${stringValue('body.video_url')} && body.video_url && replace(body.video_url, '/^[Hh][Tt][Tt][Pp][Ss]:[/][/][^\\s]+$/', '') == ''}}`, type: 'DataError', message: 'Recording is not ready or has no valid HTTPS download URL. Enable video recording, wait for video.processed with Success, and check media retention before fetching a fresh URL.' },
    output: { bot_id: '{{parameters.botId}}', video_url: '{{body.video_url}}', video_info: '{{body.video_info}}', fetched_at: '{{now}}' }
  }
}, [field('bot_id', 'Bot ID'), field('video_url', 'Video Download URL'), field('video_info', 'Video Information', 'collection', { spec: [field('duration', 'Duration (seconds)', 'number'), field('size_mb', 'Size (MB)', 'number'), field('resolution', 'Resolution'), field('fps', 'FPS', 'number'), field('frames_processed', 'Frames Processed', 'integer'), field('corrupted_frames', 'Corrupted Frames', 'integer')] }), date('fetched_at', 'Fetched At')], { bot_id: 'bot-example', video_url: 'https://media.example.invalid/synthetic.webm', video_info: { duration: 30, size_mb: 1 }, fetched_at: '2026-10-13T12:00:00.000Z' });

module('leaveMeeting', 'Leave a Meeting', 'Asks an active bot to leave or cancels a scheduled bot while retaining its data.', [id('botId', 'Bot ID')], {
  url: '/api/v1/bots/{{encodeURL(parameters.botId)}}/remove_bot', encodeUrl: false, method: 'GET',
  response: { output: { bot_id: '{{body.bot_id}}', status: '{{body.status}}', bot_status: '{{body.bot_status}}', control_request_id: '{{body.control_request_id}}', requested_at: "{{if(body.requested_at, parseDate(body.requested_at, 'X'), null)}}", acknowledged_at: "{{if(body.acknowledged_at, parseDate(body.acknowledged_at, 'X'), null)}}", completed_at: "{{if(body.completed_at, parseDate(body.completed_at, 'X'), null)}}", reason: '{{body.reason}}' } }
}, [field('bot_id', 'Bot ID'), field('status', 'Stop Request Status'), field('bot_status', 'Bot Status'), field('control_request_id', 'Control Request ID'), date('requested_at', 'Requested At'), date('acknowledged_at', 'Acknowledged At'), date('completed_at', 'Completed At'), field('reason', 'Reason')], { bot_id: 'bot-example', status: 'stopping', bot_status: 'InMeeting', control_request_id: 'control-example' });

const pairs = [field('key', 'Key', 'text', { required: true }), field('value', 'Value')];
module('makeApiCall', 'Make an API Call', 'Performs an arbitrary authorized API call.', [
  field('url', 'URL', 'text', { required: true, default: '/api/v1/bots', validate: { pattern: '^/api/v[0-9]+(?:/[A-Za-z0-9_%~-]+)+$' }, help: 'Enter a path relative to https://api.meetstream.ai, for example /api/v1/bots. Put query parameters below. External hosts and redirects are blocked.' }),
  select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET'),
  field('qs', 'Query String', 'array', { spec: pairs }),
  field('headers', 'Headers', 'array', { spec: [field('key', 'Key', 'text', { required: true, validate: { pattern: '^(?!(?:[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Hh][Oo][Ss][Tt]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Pp][Rr][Oo][Xx][Yy]-[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn])$)[A-Za-z0-9-]+$' } }), field('value', 'Value')] }),
  field('body', 'Body', 'text', { multiline: true, help: 'Optional JSON request body. You are responsible for the method, path, and body. Writes can change meetings and incur charges. Do not put credentials here.' })
], {
  url: 'https://api.meetstream.ai{{parameters.url}}', method: '{{parameters.method}}', type: 'text', body: '{{parameters.body}}',
  qs: { '{{...}}': "{{toCollection(parameters.qs, 'key', 'value')}}" },
  headers: { '{{...}}': "{{toCollection(parameters.headers, 'key', 'value')}}", Authorization: 'Token {{connection.apiKey}}', 'Content-Type': 'application/json' },
  followRedirects: false, followAllRedirects: false,
  response: { output: { body: '{{body}}', headers: "{{omit(headers, 'set-cookie')}}", statusCode: '{{statusCode}}' } }
}, [field('body', 'Body', 'any'), field('headers', 'Headers', 'collection'), field('statusCode', 'Status Code', 'integer')], { body: { bots: [] }, headers: {}, statusCode: 200 }, 12);

const eventInterface = [field('delivery_id', 'Delivery ID'), field('bot_id', 'Bot ID'), field('bot_event', 'Bot Event'), field('event', 'Legacy Event'), field('bot_status', 'Bot Status'), field('status_code', 'Status Code', 'integer'), field('message', 'Message'), date('timestamp', 'Event Timestamp'), field('transcript_id', 'Transcript ID'), field('custom_attributes', 'Custom Attributes', 'collection'), field('payload', 'Event Payload', 'collection')];
module('watchMeetingEvents', 'Watch Meeting Events', 'Receives verified meeting lifecycle and artifact events through the MeetStream relay.', [], {}, eventInterface,
  { delivery_id: 'delivery-example', bot_id: 'bot-example', bot_event: 'transcription.processed', event: 'transcription.processed', status_code: 200, payload: { bot_id: 'bot-example', bot_event: 'transcription.processed', transcript_status: 'Success' } }, 10,
  [{ type: 'banner', title: 'Connect a verified workspace webhook', theme: 'info', text: 'Use the included verification relay. Copy this webhook URL into the relay configuration, and register the relay HTTPS URL at app.meetstream.ai/webhooks. Set the same relay signing key in this webhook and the relay secrets. Subscribe to transcription.processed, video.processed, bot.done and all five ending events. See the setup guide. Do not send unsigned per-bot callbacks directly to this trigger.' }]);

const valid = "method == 'POST' && body.delivery_id && body.payload && body.signature == sha256(body.delivery_id + ':' + body.issued_at + ':' + body.payload, 'hex', parameters.relaySecret) && parseDate(body.issued_at, 'X') >= addSeconds(now, -300) && parseDate(body.issued_at, 'X') <= addSeconds(now, 300)";
const webhook = {
  metadata: { type: 'dedicated', label: 'MeetStream Verified Meeting Events' },
  parameters: [field('relaySecret', 'Relay Signing Key', 'password', { required: true, validate: { min: 32, max: 256 }, help: 'Store the shared relay signing key here, never in a scenario mapper. This is distinct from the MeetStream workspace signing secret.' })],
  api: {
    // Make skips `respond` when a top-level condition is false and returns its
    // generic 200 Accepted. Verification requests never emit a scenario bundle.
    verification: { condition: '{{if(' + valid + ', false, true)}}', respond: { status: 401, type: 'json', body: { received: false } } },
    respond: { status: 202, type: 'json', body: { received: true } },
    output: {
      delivery_id: '{{body.delivery_id}}', bot_id: "{{toString(get(parseJSON(body.payload), 'bot_id'))}}", bot_event: "{{ifempty(get(parseJSON(body.payload), 'bot_event'), get(parseJSON(body.payload), 'event'))}}",
      event: "{{get(parseJSON(body.payload), 'event')}}", bot_status: "{{get(parseJSON(body.payload), 'bot_status')}}", status_code: "{{get(parseJSON(body.payload), 'status_code')}}", message: "{{get(parseJSON(body.payload), 'message')}}",
      timestamp: "{{if(get(parseJSON(body.payload), 'timestamp'), parseDate(get(parseJSON(body.payload), 'timestamp'), 'YYYY-MM-DDTHH:mm:ss.SSSZ'), null)}}", transcript_id: "{{get(parseJSON(body.payload), 'transcript_id')}}", custom_attributes: "{{get(parseJSON(body.payload), 'custom_attributes')}}", payload: '{{parseJSON(body.payload)}}'
    }
  }
};

for (const [name, parts] of Object.entries(modules)) for (const [part, value] of Object.entries(parts)) await write(`app/modules/${name}/${part}.json`, value);
for (const [part, value] of Object.entries(webhook)) await write(`app/webhooks/meetingEvents/${part}.json`, value);
const app = JSON.parse(await readFile(path.join(root, 'app/app.json'), 'utf8'));
const base = JSON.parse(await readFile(path.join(root, 'app/base.json'), 'utf8'));
await write('dist/meetstream.app.json', { app, base, connections: { apiKey: { metadata: JSON.parse(await readFile(path.join(root, 'app/connections/apiKey/metadata.json'))), parameters: JSON.parse(await readFile(path.join(root, 'app/connections/apiKey/parameters.json'))), api: JSON.parse(await readFile(path.join(root, 'app/connections/apiKey/api.json'))) } }, webhooks: { meetingEvents: webhook }, modules });
console.log(`Built ${Object.keys(modules).length} native Make modules and one verified webhook.`);
await import('./build-templates.mjs');
