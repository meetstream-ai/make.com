import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../templates/', import.meta.url));
await mkdir(root, { recursive: true });
const node = (id, module, version, name, mapper = {}, parameters = {}, filter) => ({ id, module, version, parameters, mapper, ...(filter ? { filter } : {}), metadata: { designer: { x: (id - 1) * 300, y: 0, name } } });
const c = (a, o, b) => ({ a, o, ...(b === undefined ? {} : { b }) });
const filter = (name, ...conditions) => ({ name, conditions: [conditions] });
const router = (id, name, routes, gate) => ({ ...node(id, 'builtin:BasicRouter', 1, name, {}, {}, gate), routes: routes.map(flow => ({ flow })) });
const fail = (id, message, gate) => node(id, 'builtin:ThrowError', 1, message, { message }, {}, gate);
const variables = values => ({ variables: Object.entries(values).map(([name, value]) => ({ name, value })), scope: 'roundtrip' });
const enabled = filter('Enable on test connections after setup', c('{{1.enabled}}', 'text:equal', 'true'));
const eventGate = event => filter('Enable after synthetic testing', c('false', 'text:equal', 'true'), c('{{1.bot_event}}', 'text:equal', event), c('{{1.payload.' + (event === 'video.processed' ? 'video_status' : 'transcript_status') + '}}', 'text:equal', 'Success'));
const rawCalendar = (id, name, url, qs = [], gate) => node(id, 'google-calendar:makeApiCall', 5, name, { url, method: 'GET', qs, headers: [] }, {}, gate);
const store = (id, action, name, mapper, gate) => node(id, `datastore:${action}`, 1, name, action === 'GetRecord' ? { ...mapper, returnWrapped: false } : mapper, {}, gate);
const stopStatus = (id, botId) => node(id, 'app#meetstream:makeApiCall', 1, 'Confirm the stop request before continuing', { url: '/api/v1/bots/{{encodeURL(' + botId + ')}}/stop_status', method: 'GET', qs: [], headers: [] });
const completedStop = '^stopped$|^force_stopped$|^cancelled$';
const caseFold = text => [...text].map(letter => /[a-z]/i.test(letter) ? '[' + letter.toLowerCase() + letter.toUpperCase() + ']' : letter === '.' ? '\\.' : letter).join('');
const supported = '^' + caseFold('https') + '://(?:' + [caseFold('meet.google.com'), '(?:[A-Za-z0-9-]+\\.)*' + caseFold('zoom.us'), caseFold('teams.microsoft.com'), caseFold('teams.live.com')].join('|') + ')/[^\\s]+$';
const sourceText = 'ifempty(5.body.hangoutLink; "") + " " + join(map(remove(5.body.conferenceData.entryPoints; null); "uri"; "entryPointType"; "video"); " ") + " " + ifempty(5.body.location; "") + " " + ifempty(5.body.description; "")';
const extractionPattern = '/^[\\s\\S]*?(?:^|[\\s>"\'(])(https:\\/\\/(?:meet\\.google\\.com|(?:[A-Za-z0-9-]+\\.)*zoom\\.us|teams\\.(?:microsoft|live)\\.com)\\/[^\\s<>"\')]+)[\\s\\S]*$/i';
const createBot = (id, prior, gate) => node(id, 'app#meetstream:createBot', 1, 'Create or replay this calendar revision', {
  meetingLink: '{{6.meetingUrl}}', botName: 'MeetStream Notetaker',
  deduplicationKey: '{{sha256(6.key + ":" + ' + prior + ' + ":" + 6.startAt + ":" + 6.meetingUrl)}}', joinAt: '{{6.startAt}}', videoRequired: true,
  transcriptionMode: 'postCall', postCallProvider: 'meetstream', providerOptions: '{}',
}, {}, gate);
const saveBot = (id, createId) => store(id, 'AddRecord', 'Persist event → bot mapping independently of event metadata', { key: '{{6.key}}', overwrite: true, data: {
  bot_id: '{{' + createId + '.bot_id}}', calendar_id: '{{1.calendarId}}', event_id: '{{5.body.id}}', start_at: '{{6.startAt}}', meeting_url: '{{6.meetingUrl}}', status: 'scheduled'
} });
const calendar = [
  node(1, 'util:SetVariables', 1, 'Setup — enabled=false, choose calendar and shared state store', variables({ enabled: 'false', calendarId: 'primary', leadMinutes: '20', meetingLinkPattern: extractionPattern })),
  rawCalendar(2, 'Scan tagged events in the lead-time window', '/v3/calendars/{{encodeURL(1.calendarId)}}/events', [
    { key: 'timeMin', value: '{{formatDate(now; "YYYY-MM-DDTHH:mm:ss[Z]"; "UTC")}}' },
    { key: 'timeMax', value: '{{formatDate(addMinutes(now; 1.leadMinutes); "YYYY-MM-DDTHH:mm:ss[Z]"; "UTC")}}' },
    { key: 'singleEvents', value: 'true' }, { key: 'showDeleted', value: 'true' }, { key: 'orderBy', value: 'startTime' }, { key: 'maxResults', value: '2500' }, { key: 'q', value: '[MeetStream]' }
  ], enabled),
  router(3, 'Fail visibly if the scan exceeds one bounded page', [
    [fail(30, 'Calendar scan overflow: narrow the lead window or implement pagination before enabling this calendar.', filter('Incomplete page', c('{{2.body.nextPageToken}}', 'exist')))],
    [node(4, 'builtin:BasicFeeder', 1, 'Each calendar occurrence', { array: '{{2.body.items}}' }, {}, filter('Complete page', c('{{2.body.nextPageToken}}', 'notexist'))),
      rawCalendar(5, 'Recheck latest event before scheduling', '/v3/calendars/{{encodeURL(1.calendarId)}}/events/{{encodeURL(4.id)}}'),
      node(6, 'util:SetVariables', 1, 'Resolve a supported link and occurrence identity', variables({
        meetingUrl: '{{replace(' + sourceText + '; 1.meetingLinkPattern; "$1")}}',
        key: '{{sha256(1.calendarId + ":" + 5.body.id)}}', startAt: '{{5.body.start.dateTime}}'
      }), {}, filter('Only future timed events', c('{{5.body.status}}', 'text:notequal', 'cancelled'), c('{{5.body.start.dateTime}}', 'exist'), c('{{parseDate(5.body.start.dateTime; "YYYY-MM-DDTHH:mm:ssZ")}}', 'date:after', '{{now}}'))),
      router(7, 'Missing or unsupported links require correction', [
        [fail(31, 'Tagged calendar event has no supported HTTPS meeting URL. Add a Google Meet, Zoom, or Teams link.', filter('Invalid meeting link', c('{{6.meetingUrl}}', 'text:notpattern', supported)))],
        [store(8, 'ExistRecord', 'Look up the persistent occurrence record', { key: '{{6.key}}' }, filter('Supported link', c('{{6.meetingUrl}}', 'text:pattern', supported))),
          router(9, 'New occurrence or saved schedule', [
            [createBot(10, '"initial"', filter('New occurrence', c('{{8.exist}}', 'boolean:equal', false))), saveBot(11, 10)],
            [store(12, 'GetRecord', 'Read persisted bot and revision', { key: '{{6.key}}' }, filter('Existing occurrence', c('{{8.exist}}', 'boolean:equal', true))),
              router(13, 'Replace only changed or cancelled schedules', [
                [createBot(14, '12.bot_id', filter('Reactivate a cancelled event', c('{{12.status}}', 'text:equal', 'cancelled'))), saveBot(15, 14)],
                [node(16, 'app#meetstream:leaveMeeting', 1, 'Cancel old bot before replacement', { botId: '{{12.bot_id}}' }, {}, { name: 'Active saved schedule changed', conditions: [
                  [c('{{12.status}}', 'text:notequal', 'cancelled'), c('{{6.startAt}}', 'text:notequal', '{{12.start_at}}')],
                  [c('{{12.status}}', 'text:notequal', 'cancelled'), c('{{6.meetingUrl}}', 'text:notequal', '{{12.meeting_url}}')]
                ] }), stopStatus(40, '12.bot_id'), router(41, 'Only replace after the old bot has stopped', [
                  [createBot(17, '12.bot_id', filter('Stop confirmed', c('{{40.body.status}}', 'text:pattern', completedStop))), saveBot(18, 17)],
                  [fail(42, 'Old bot stop is not confirmed. Inspect stop status, then replay the calendar occurrence; do not create a replacement yet.', filter('Pending or failed stop', c('{{40.body.status}}', 'text:notpattern', completedStop)))]
                ])]
              ])]
          ])]
      ])]
  ])
];

// Match the input precision explicitly; otherwise a seconds-only format can
// discard fractional seconds before the ordering guard compares milliseconds.
const epochMillis = value => '{{formatDate(parseDate(' + value + '; if(length(split(' + value + '; ".")) > 1; "YYYY-MM-DDTHH:mm:ss.SSSZ"; "YYYY-MM-DDTHH:mm:ssZ")); "x")}}';
const crm = [
  node(1, 'app#meetstream:watchMeetingEvents', 1, 'Verified transcript events — configure relay first'),
  node(2, 'app#meetstream:getBot', 1, 'Get meeting context and contact metadata', { botId: '{{1.bot_id}}' }, {}, eventGate('transcription.processed')),
  node(3, 'app#meetstream:getLatestTranscription', 1, 'Select latest successful post-call transcript', { botId: '{{1.bot_id}}' }),
  node(4, 'hubspotcrm:MakeAPICall', 2, 'Read existing contact and deduplication marker', { url: '/crm/v3/objects/contacts/{{encodeURL(ifempty(1.custom_attributes.hubspot_contact_id; 2.details.custom_attributes.hubspot_contact_id))}}', method: 'GET', qs: [{ key: 'properties', value: 'meetstream_transcript_id,meetstream_meeting_started_at' }], headers: [] }),
  router(5, 'Do not overwrite a newer meeting or repeat the same transcript', [
    [node(6, 'app#meetstream:getTranscript', 1, 'Retrieve the selected final transcript', { transcriptId: '{{3.transcript_id}}', raw: false }, {}, filter('New, non-older transcript', c('{{4.body.properties.meetstream_transcript_id}}', 'text:notequal', '{{3.transcript_id}}'), c(epochMillis('ifempty(4.body.properties.meetstream_meeting_started_at; "1970-01-01T00:00:00Z")'), 'number:lessorequal', epochMillis('ifempty(2.details.StartTime; 2.created_at)')))),
      router(7, 'Treat empty speech as an actionable error', [
        [fail(23, 'Transcript word values have unsupported types. Inspect the preserved segments and raw JSON before writing to CRM.', filter('Incomplete formatted text', c('{{6.text_incomplete}}', 'boolean:equal', true)))],
        [fail(20, 'The selected transcript contains no speech. Inspect the transcription job before retrying.', filter('Empty transcript', c('{{length(trim(6.text))}}', 'number:equal', 0)))],
        [node(8, 'util:SetVariables', 1, 'Bound CRM text and explicitly mark truncation', variables({ text: '{{if(length(6.text) > 15000; substring(6.text; 0; 14800) + decodeURL("%0A%0A") + "[Transcript truncated. Fetch the complete transcript by its saved ID.]"; 6.text)}}' }), {}, filter('Speech exists', c('{{length(trim(6.text))}}', 'number:greater', 0), c('{{6.text_incomplete}}', 'boolean:equal', false))),
          node(22, 'json:CreateJSON', 1, 'Encode HubSpot properties — choose the supplied JSON structure', { properties: {
            meetstream_transcript_id: '{{3.transcript_id}}', meetstream_bot_id: '{{1.bot_id}}',
            meetstream_meeting_started_at: '{{ifempty(2.details.StartTime; 2.created_at)}}', meetstream_transcript: '{{8.text}}'
          } }, { space: '' }),
          node(9, 'hubspotcrm:MakeAPICall', 2, 'Update the existing contact using stable IDs', { url: '/crm/v3/objects/contacts/{{encodeURL(ifempty(1.custom_attributes.hubspot_contact_id; 2.details.custom_attributes.hubspot_contact_id))}}', method: 'PATCH', qs: [], headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{{22.json}}' })]
      ])]
  ])
];
const contactId = '{{ifempty(1.custom_attributes.hubspot_contact_id; 2.details.custom_attributes.hubspot_contact_id)}}';
const crmTail = crm.splice(3);
crmTail[0].filter = filter('Configured contact', c(contactId, 'exist'));
crm.push(router(19, 'Require contact metadata before any CRM request', [
  [fail(21, 'Set custom_attributes.hubspot_contact_id when creating the bot before enabling this CRM scenario.', filter('Missing contact ID', c(contactId, 'notexist')))],
  crmTail
]));

// Drive query literals require backslash and apostrophe escaping, independently
// of URL encoding performed by the native API module.
const driveLiteral = field => String.raw`{{replace(replace(${field}; "/\\/g"; decodeURL("%5C%5C")); "/'/g"; decodeURL("%5C%27"))}}`;
const recording = [
  node(1, 'app#meetstream:watchMeetingEvents', 1, 'Verified recording events — configure relay first'),
  node(2, 'util:SetVariables', 1, 'Setup — choose folder and Make-plan file limit', variables({ folderId: 'REPLACE_WITH_TEST_FOLDER_ID', fileName: 'meetstream-{{1.bot_id}}.mp4', maxSizeMb: '5' }), {}, eventGate('video.processed')),
  node(3, 'google-drive:makeApiCall', 4, 'Look up deterministic recording filename', { url: '/drive/v3/files', method: 'GET', qs: [{ key: 'q', value: "name = '" + driveLiteral("2.fileName") + "' and '" + driveLiteral("2.folderId") + "' in parents and trashed = false" }, { key: 'fields', value: 'files(id,name),nextPageToken' }, { key: 'pageSize', value: '100' }], headers: [] }),
  router(4, 'Do not silently drop storage lookup overflow', [
    [fail(23, 'Drive lookup response is missing the files array. Inspect the response before replaying this event.', filter('Missing lookup results', c('{{3.body.files}}', 'notexist')))],
    [fail(20, 'Drive lookup overflow. Inspect the destination folder before replaying this event.', filter('Incomplete results', c('{{3.body.nextPageToken}}', 'exist')))],
    [node(5, 'app#meetstream:getRecording', 1, 'Fetch fresh video URL immediately before download', { botId: '{{1.bot_id}}' }, {}, filter('No existing archive and complete result', c('{{3.body.files}}', 'exist'), c('{{length(3.body.files)}}', 'number:equal', 0), c('{{3.body.nextPageToken}}', 'notexist'))),
      router(6, 'Verify size instead of silently skipping the file', [
        [fail(21, 'Recording size must be a positive number. Verify metadata and the Make plan limit before downloading.', { name: 'Invalid size', conditions: [[c('{{5.video_info.size_mb}}', 'notexist')], [c('{{5.video_info.size_mb}}', 'text:notpattern', '^([0-9]+([.][0-9]+)?|[.][0-9]+)$')], [c('{{5.video_info.size_mb}}', 'number:lessorequal', 0)]] })],
        [fail(22, 'Recording exceeds the configured Make file limit. Transfer it through customer storage tooling or raise the verified limit.', filter('Oversized recording', c('{{5.video_info.size_mb}}', 'number:greater', '{{2.maxSizeMb}}')))],
        [node(7, 'http:ActionGetFile', 3, 'Download immediately without MeetStream authorization', { url: '{{5.video_url}}', method: 'get', serializeUrl: false, shareCookies: false }, { handleErrors: true }, filter('Known size within limit', c('{{5.video_info.size_mb}}', 'text:pattern', '^([0-9]+([.][0-9]+)?|[.][0-9]+)$'), c('{{5.video_info.size_mb}}', 'number:greater', 0), c('{{5.video_info.size_mb}}', 'number:lessorequal', '{{2.maxSizeMb}}'))),
          node(8, 'google-drive:uploadAFile', 4, 'Upload once; replay the full event after uncertain failure', { data: '{{7.data}}', filename: '{{2.fileName}}', select: 'map', folderId: '{{2.folderId}}', destination: 'drive', convert: false })]
      ])]
  ])
];

const cleanup = [
  node(1, 'google-calendar:watchEvents', 5, 'Watch schedule changes including cancellation tombstones', {}, { calendar: 'primary', select: 'update', showDeleted: true, eventTypes: ['default'], limit: 10 }),
  node(2, 'util:SetVariables', 1, 'Configure the same calendar ID as the main scenario', variables({ calendarId: 'primary', meetingLinkPattern: extractionPattern }), {}, filter('Enable after template review and setup', c('false', 'text:equal', 'true'))),
  store(3, 'ExistRecord', 'Find saved mapping even when private properties are absent', { key: '{{sha256(2.calendarId + ":" + 1.id)}}' }),
  store(4, 'GetRecord', 'Read the saved cancellation target', { key: '{{sha256(2.calendarId + ":" + 1.id)}}' }, filter('Previously scheduled occurrence', c('{{3.exist}}', 'boolean:equal', true))),
  rawCalendar(10, 'Recheck current event even when moved outside the lead window', '/v3/calendars/{{encodeURL(2.calendarId)}}/events/{{encodeURL(1.id)}}', [], filter('Active saved mapping', c('{{4.status}}', 'text:notequal', 'cancelled'))),
  node(11, 'util:SetVariables', 1, 'Resolve current schedule before cancelling a stale bot', variables({ meetingUrl: '{{replace(' + sourceText.replaceAll('5.body', '10.body') + '; 2.meetingLinkPattern; "$1")}}' })),
  node(5, 'app#meetstream:leaveMeeting', 1, 'Cancel only a cancelled or changed mapped occurrence', { botId: '{{4.bot_id}}' }, {}, { name: 'Current event no longer matches the saved schedule', conditions: [
    [c('{{10.body.status}}', 'text:equal', 'cancelled')],
    [c('{{10.body.start.dateTime}}', 'text:notequal', '{{4.start_at}}')],
    [c('{{11.meetingUrl}}', 'text:notequal', '{{4.meeting_url}}')]
  ] }),
  stopStatus(7, '4.bot_id'),
  router(8, 'Do not mark a pending stop as a completed cancellation', [
    [store(6, 'AddRecord', 'Keep mapping and cancellation state for safe reactivation', { key: '{{sha256(2.calendarId + ":" + 1.id)}}', overwrite: true, data: { bot_id: '{{4.bot_id}}', calendar_id: '{{4.calendar_id}}', event_id: '{{4.event_id}}', start_at: '{{4.start_at}}', meeting_url: '{{4.meeting_url}}', status: 'cancelled' } }, filter('Stop confirmed', c('{{7.body.status}}', 'text:pattern', completedStop)))],
    [fail(9, 'Cancellation is not confirmed. Check the stop request, then replay the cancellation event.', filter('Pending or failed stop', c('{{7.body.status}}', 'text:notpattern', completedStop)))]
  ])
];
const metadata = instant => ({ instant, version: 1, scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, autoCommitTriggerLast: true, sequential: true, confidential: true, dataloss: false, dlq: false, freshVariables: false }, designer: { orphans: [] } });
// A separate Make-generated artifact, never a substitute success for getSummary.
const summaryStore = (id, action, name, mapper, gate) => ({ ...store(id, action, name, mapper, gate), parameters: { datastore: 'SUMMARY_DATA_STORE_ID' } });
const summaryKey = (bot, transcript) => `summary:small-v1:{{sha256(${bot})}}:{{sha256(${transcript})}}`;
const summaryOutput = (id, record) => node(id, 'util:SetVariables', 1, 'Return the stored Make-generated summary', variables(Object.fromEntries(['bot_id', 'transcript_id', 'summary', 'summary_source', 'summary_policy', 'generated_at'].map(key => [key, `{{${record}.${key}}}`]))));
const summaryValidity = (record, bot, transcript) => [c(`{{${record}.bot_id}}`, 'text:equal', `{{${bot}}}`), c(`{{${record}.transcript_id}}`, 'text:equal', `{{${transcript}}}`), c(`{{${record}.summary_source}}`, 'text:equal', 'make_ai_toolkit'), c(`{{${record}.summary_policy}}`, 'text:equal', 'small-v1'), c(`{{length(trim(ifempty(${record}.summary; "")))}}`, 'number:greater', 0), c(`{{length(${record}.summary)}}`, 'number:lessorequal', 20000), c(`{{${record}.generated_at}}`, 'exist')];
const returnSummary = (routerId, outputId, errorId, record, bot, transcript) => {
  const checks = summaryValidity(record, bot, transcript);
  const inverse = { 'text:equal': 'text:notequal', 'number:greater': 'number:lessorequal', 'number:lessorequal': 'number:greater', exist: 'notexist' };
  return router(routerId, 'Validate stored summary provenance before returning', [
    [{ ...summaryOutput(outputId, record), filter: filter('Verified stored summary', ...checks) }],
    [fail(errorId, 'Stored summary is empty, oversized or has incompatible provenance. Inspect this exact summary record before retrying; no AI regeneration or overwrite was performed.', { name: 'Invalid stored summary', conditions: checks.map(check => [{ ...check, o: inverse[check.o] }]) })]
  ]);
};
const summaries = [
  node(1, 'util:SetVariables', 1, 'Setup — enable manually and choose a bot ID', variables({ enabled: 'false', botId: 'REPLACE_WITH_BOT_ID' })),
  node(2, 'app#meetstream:getLatestTranscription', 1, 'Select the latest successful real post-call transcript', { botId: '{{1.botId}}' }, {}, enabled),
  node(4, 'app#meetstream:getTranscript', 1, 'Fetch complete transcript text', { transcriptId: '{{2.transcript_id}}', raw: false }),
  router(3, 'Reject empty, malformed or oversized input before AI', [
    [fail(20, 'Summary input is empty, incomplete or exceeds 60000 characters. No summary was generated. Use a complete bounded transcript or a separately reviewed chunking workflow.', { name: 'Invalid transcript', conditions: [[c('{{4.text_incomplete}}', 'boolean:notequal', false)], [c('{{length(trim(ifempty(4.text; "")))}}', 'number:equal', 0)], [c('{{length(4.text)}}', 'number:greater', 60000)]] })],
    [node(6, 'util:SetVariables', 1, 'Namespace summary identity by bot, transcript and policy', variables({ key: summaryKey('1.botId', '2.transcript_id') }), {}, filter('Complete bounded speech', c('{{4.text_incomplete}}', 'boolean:equal', false), c('{{length(trim(4.text))}}', 'number:greater', 0), c('{{length(4.text)}}', 'number:lessorequal', 60000))),
      summaryStore(7, 'ExistRecord', 'Check for a saved summary before spending AI credits', { key: '{{6.key}}' }),
      router(8, 'Reuse the saved summary or generate once', [
        [summaryStore(9, 'GetRecord', 'Retrieve the existing summary', { key: '{{6.key}}' }, filter('Already stored', c('{{7.exist}}', 'boolean:equal', true))), returnSummary(10, 16, 17, 9, '1.botId', '2.transcript_id')],
        [node(11, 'ai-tools:Summarize', 2, 'Generate with Make AI Toolkit — not the MeetStream summary API', { input: '{{4.text}}' }, { model: 'small' }, filter('Not stored', c('{{7.exist}}', 'boolean:equal', false))),
          router(12, 'Only save a nonempty bounded AI result', [
            [fail(21, 'Make AI returned an empty or oversized summary. Nothing was stored.', { name: 'Invalid AI result', conditions: [[c('{{length(trim(ifempty(11.summary; "")))}}', 'number:equal', 0)], [c('{{length(11.summary)}}', 'number:greater', 20000)]] })],
            [summaryStore(13, 'AddRecord', 'Save once; never overwrite an existing summary', { key: '{{6.key}}', overwrite: false, data: { bot_id: '{{1.botId}}', transcript_id: '{{2.transcript_id}}', summary: '{{11.summary}}', summary_source: 'make_ai_toolkit', summary_policy: 'small-v1', generated_at: '{{formatDate(now; "YYYY-MM-DDTHH:mm:ss.SSS[Z]"; "UTC")}}' } }, filter('Nonempty bounded result', c('{{length(trim(ifempty(11.summary; "")))}}', 'number:greater', 0), c('{{length(11.summary)}}', 'number:lessorequal', 20000))),
              summaryStore(14, 'GetRecord', 'Read back the actual saved record', { key: '{{6.key}}' }), returnSummary(15, 18, 19, 14, '1.botId', '2.transcript_id')]
          ])]
      ])]
  ])
];
const summaryRetrieval = [
  node(1, 'util:SetVariables', 1, 'Setup — enable and enter the saved bot/transcript IDs', variables({ enabled: 'false', botId: 'REPLACE_WITH_BOT_ID', transcriptId: 'REPLACE_WITH_TRANSCRIPT_ID' })),
  summaryStore(2, 'GetRecord', 'Retrieve by the exact stored source identity; no AI request', { key: summaryKey('1.botId', '1.transcriptId') }, enabled),
  returnSummary(3, 4, 5, 2, '1.botId', '1.transcriptId')
];
for (const [file, name, flow, instant] of [
  ['01-calendar-auto-join', 'Calendar events → one MeetStream bot per revision', calendar, false],
  ['02-transcript-to-hubspot', 'Latest successful transcript → existing HubSpot contact', crm, true],
  ['03-recording-to-drive', 'Recording ready → customer Google Drive', recording, true],
  ['01b-calendar-change-cleanup', 'Calendar schedule changes → stale mapped bot leaves', cleanup, false],
  ['04-transcript-to-stored-summary', 'Transcript → stored Make AI summary (on demand)', summaries, false],
  ['04b-get-stored-summary', 'Retrieve a stored Make AI summary (no generation)', summaryRetrieval, false]
]) await writeFile(`${root}${file}.blueprint.json`, JSON.stringify({ name, flow, metadata: metadata(instant) }, null, 2) + '\n');
await writeFile(`${root}calendar-state.schema.json`, JSON.stringify({ name: 'MeetStream calendar occurrence state', spec: ['bot_id', 'calendar_id', 'event_id', 'start_at', 'meeting_url', 'status'].map(name => ({ name, type: 'text', required: true })) }, null, 2) + '\n');
await writeFile(`${root}summary-state.schema.json`, JSON.stringify({ name: 'MeetStream Make-generated summaries', spec: ['bot_id', 'transcript_id', 'summary', 'summary_source', 'summary_policy', 'generated_at'].map(name => ({ name, type: 'text', required: false })) }, null, 2) + '\n');
console.log('Built six disabled scenario drafts. Configure customer bindings before activation.');
