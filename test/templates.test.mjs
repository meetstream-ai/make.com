import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateScenario } from '../scripts/lib/local-runtime.mjs';
const load = async name => JSON.parse(await readFile(new URL(`../templates/${name}.blueprint.json`, import.meta.url)));
const calendar = await load('01-calendar-auto-join');
const cleanup = await load('01b-calendar-change-cleanup');
const crm = await load('02-transcript-to-hubspot');
const recording = await load('03-recording-to-drive');
const find = (flow, id) => {
  for (const module of flow) {
    if (module.id === id) return module;
    for (const route of module.routes || []) { const result = find(route.flow, id); if (result) return result; }
  }
};
function passes(filter, context) {
  return !filter || filter.conditions.some(group => group.every(rule => {
    const a = evaluateScenario(rule.a, context), b = evaluateScenario(rule.b, context);
    switch (rule.o) {
      case 'text:equal': case 'boolean:equal': return a === b;
      case 'text:notequal': case 'boolean:notequal': return a !== b;
      case 'text:pattern': return new RegExp(b).test(a);
      case 'text:notpattern': return !new RegExp(b).test(a);
      case 'exist': return a != null && a !== '';
      case 'notexist': return a == null || a === '';
      case 'date:after': return +new Date(a) > +new Date(b);
      case 'date:before': return +new Date(a) < +new Date(b);
      case 'number:equal': return Number(a) === Number(b);
      case 'number:greater': return Number(a) > Number(b);
      case 'number:lessorequal': return a != null && Number(a) <= Number(b);
      default: throw new Error(`Unsupported filter ${rule.o}`);
    }
  }));
}
const event = { id: 'synthetic-occurrence', status: 'confirmed', start: { dateTime: '2026-10-14T12:10:00Z' }, conferenceData: { entryPoints: [null, { entryPointType: 'phone', uri: 'tel:+15555555555' }, { entryPointType: 'video', uri: 'https://meet.google.com/example-only' }] } };
const now = new Date('2026-10-14T12:00:00Z');
const context = { now, modules: { 1: { enabled: 'false', calendarId: 'primary', meetingLinkPattern: find(calendar.flow, 1).mapper.variables.find(value => value.name === 'meetingLinkPattern').value }, 5: { body: event } } };
const vars = (blueprint, id, ctx) => Object.fromEntries(evaluateScenario(find(blueprint.flow, id).mapper, ctx).variables.map(value => [value.name, value.value]));

test('all launch scenarios retain safe default gates and correct instant metadata', () => {
  assert(!passes(find(calendar.flow, 2).filter, context));
  assert(!passes(find(crm.flow, 2).filter, { modules: { 1: { bot_event: 'transcription.processed', payload: { transcript_status: 'Success' } } } }));
  assert(!passes(find(recording.flow, 2).filter, { modules: { 1: { bot_event: 'video.processed', payload: { video_status: 'Success' } } } }));
  assert.equal(calendar.metadata.instant, false); assert.equal(crm.metadata.instant, true); assert.equal(recording.metadata.instant, true);
});

test('draft identifiers match the authenticated Make catalog and defaults fit Free plan', () => {
  assert.equal(find(calendar.flow, 8).module, 'datastore:ExistRecord');
  assert.equal(find(cleanup.flow, 3).module, 'datastore:ExistRecord');
  assert.equal(find(calendar.flow, 12).mapper.returnWrapped, false);
  assert.equal(find(cleanup.flow, 4).mapper.returnWrapped, false);
  assert.equal(find(calendar.flow, 10).filter.conditions[0][0].a, '{{8.exist}}');
  assert.equal(find(cleanup.flow, 4).filter.conditions[0][0].a, '{{3.exist}}');
  assert.equal(find(crm.flow, 4).module, 'hubspotcrm:MakeAPICall');
  assert.equal(find(crm.flow, 4).version, 2);
  assert.equal(find(calendar.flow, 1).mapper.variables.find(value => value.name === 'leadMinutes').value, '20');
  assert.equal(find(recording.flow, 2).mapper.variables.find(value => value.name === 'maxSizeMb').value, '5');
  // Regex is a plain setup value: embedded quotes cannot break scenario IML.
  assert(find(calendar.flow, 6).mapper.variables.find(value => value.name === 'meetingUrl').value.includes('1.meetingLinkPattern'));
});

test('calendar chooses a supported candidate from conference, location, or description', () => {
  assert.equal(vars(calendar, 6, context).meetingUrl, 'https://meet.google.com/example-only');
  for (const body of [
    { ...event, hangoutLink: 'https://meet.google.com.evil.example/no', description: 'Backup: https://teams.live.com/meet/123', conferenceData: undefined },
    { ...event, hangoutLink: null, location: 'Meeting (https://us02web.zoom.us/j/123)', conferenceData: undefined },
    { ...event, hangoutLink: null, description: '<a href="https://teams.microsoft.com/meet/123">Join</a>', conferenceData: undefined }
  ]) assert.match(vars(calendar, 6, { ...context, modules: { ...context.modules, 5: { body } } }).meetingUrl, /^https:\/\/(?:teams|us02web)/);
  for (const link of ['https://meet.google.com.evil.example/no', 'https://user:password@meet.google.com/no', 'https://evil.example/?next=https://meet.google.com/no']) {
    const values = vars(calendar, 6, { ...context, modules: { ...context.modules, 5: { body: { ...event, conferenceData: undefined, hangoutLink: link } } } });
    assert(passes(find(calendar.flow, 31).filter, { modules: { 6: values } }));
  }
  assert(!passes(find(calendar.flow, 6).filter, { ...context, modules: { ...context.modules, 5: { body: { ...event, status: 'cancelled' } } } }));
  assert(!passes(find(calendar.flow, 6).filter, { ...context, modules: { ...context.modules, 5: { body: { ...event, start: { date: '2026-10-14' } } } } }));
  const uppercase = vars(calendar, 6, { ...context, modules: { ...context.modules, 5: { body: { ...event, conferenceData: undefined, hangoutLink: 'HTTPS://ZOOM.US/j/CaseSensitivePath' } } } });
  assert.equal(uppercase.meetingUrl, 'HTTPS://ZOOM.US/j/CaseSensitivePath');
  assert(passes(find(calendar.flow, 8).filter, { modules: { 6: uppercase } }));
});

test('persistent calendar mappings survive cancellation tombstones without private properties', () => {
  const values = vars(calendar, 6, context);
  const createContext = { ...context, modules: { ...context.modules, 6: values } };
  const create = evaluateScenario(find(calendar.flow, 10).mapper, createContext);
  assert.equal(create.deduplicationKey, evaluateScenario(find(calendar.flow, 10).mapper, createContext).deduplicationKey);
  assert.equal(create.customAttributes, undefined);
  const saved = evaluateScenario(find(calendar.flow, 11).mapper, { ...createContext, modules: { ...createContext.modules, 10: { bot_id: 'stored-bot' } } });
  assert.equal(saved.key, values.key); assert.equal(saved.data.bot_id, 'stored-bot');
  const tombstone = { modules: { 1: { id: event.id, status: 'cancelled' }, 2: { calendarId: 'primary' }, 4: saved.data } };
  assert.equal(evaluateScenario(find(cleanup.flow, 3).mapper, tombstone).key, saved.key);
  assert.equal(evaluateScenario(find(cleanup.flow, 5).mapper, tombstone).botId, 'stored-bot');
  const cancelled = evaluateScenario(find(cleanup.flow, 6).mapper, tombstone);
  assert.equal(cancelled.data.status, 'cancelled'); assert.equal(cancelled.data.bot_id, 'stored-bot');
  assert(!passes(find(cleanup.flow, 10).filter, { ...tombstone, modules: { ...tombstone.modules, 4: cancelled.data } }));
});

test('calendar revisions are stable across retries, replacement and reactivation', () => {
  const values = vars(calendar, 6, context);
  const previous = { ...context, modules: { ...context.modules, 6: values, 12: { bot_id: 'prior-bot', status: 'scheduled', start_at: values.startAt, meeting_url: values.meetingUrl } } };
  assert(!passes(find(calendar.flow, 16).filter, previous));
  const changed = { ...previous, modules: { ...previous.modules, 6: { ...values, startAt: '2026-10-14T12:20:00Z' } } };
  assert(passes(find(calendar.flow, 16).filter, changed));
  const key = evaluateScenario(find(calendar.flow, 17).mapper, changed).deduplicationKey;
  assert.equal(key, evaluateScenario(find(calendar.flow, 17).mapper, changed).deduplicationKey);
  assert.notEqual(key, evaluateScenario(find(calendar.flow, 10).mapper, previous).deduplicationKey);
  assert(passes(find(calendar.flow, 14).filter, { ...previous, modules: { ...previous.modules, 12: { ...previous.modules[12], status: 'cancelled' } } }));
});

test('calendar replacement and cancellation require a completed stop, not an HTTP 202 acknowledgement', () => {
  assert.equal(find(calendar.flow, 40).module, 'app#meetstream:makeApiCall');
  assert(find(calendar.flow, 40).mapper.url.endsWith('/stop_status'));
  for (const status of ['stop_requested', 'acknowledged', 'graceful_exit_in_progress', 'failed']) {
    const ctx = { modules: { 40: { body: { status } } } };
    assert(!passes(find(calendar.flow, 17).filter, ctx)); assert(passes(find(calendar.flow, 42).filter, ctx));
    assert(passes(find(cleanup.flow, 9).filter, { modules: { 7: { body: { status } } } }));
  }
  for (const status of ['stopped', 'force_stopped', 'cancelled']) {
    assert(passes(find(calendar.flow, 17).filter, { modules: { 40: { body: { status } } } }));
    assert(passes(find(cleanup.flow, 6).filter, { modules: { 7: { body: { status } } } }));
  }
});

test('overflow, missing links and invalid recording sizes fail visibly instead of disappearing', () => {
  for (const [blueprint, id, modules] of [
    [calendar, 30, { 2: { body: { nextPageToken: 'next-page' } } }],
    [calendar, 31, { 6: { meetingUrl: 'not a meeting URL' } }],
    [recording, 20, { 3: { body: { nextPageToken: 'next-page' } } }],
    [recording, 21, { 5: { video_info: {} } }],
    [recording, 22, { 2: { maxSizeMb: '20' }, 5: { video_info: { size_mb: 21 } } }]
  ]) {
    const guard = find(blueprint.flow, id); assert.equal(guard.module, 'builtin:ThrowError'); assert(passes(guard.filter, { modules })); assert(guard.mapper.message.length > 20);
  }
});

test('CRM selects a successful run, requires contact ID, truncates explicitly and JSON-escapes content', () => {
  assert.equal(find(crm.flow, 3).module, 'app#meetstream:getLatestTranscription');
  assert.equal(find(crm.flow, 6).mapper.transcriptId, '{{3.transcript_id}}');
  assert(passes(find(crm.flow, 21).filter, { modules: { 1: {}, 2: { details: {} } } }));
  const text = 'Speaker "A": path \\ folder\nHello 👋 नमस्ते';
  const ctx = { modules: { 1: { bot_id: 'bot-example', custom_attributes: { hubspot_contact_id: '123' } }, 2: { details: { StartTime: '2026-10-14T12:00:00Z' } }, 3: { transcript_id: 'latest-success' }, 6: { text } } };
  ctx.modules[8] = vars(crm, 8, ctx);
  assert.equal(find(crm.flow, 22).module, 'json:CreateJSON');
  ctx.modules[22] = { json: JSON.stringify(evaluateScenario(find(crm.flow, 22).mapper, ctx)) };
  const update = evaluateScenario(find(crm.flow, 9).mapper, ctx); assert.equal(update.method, 'PATCH');
  assert.equal(JSON.parse(update.body).properties.meetstream_transcript, text);
  assert.equal(JSON.parse(update.body).properties.meetstream_transcript_id, 'latest-success');
  const large = vars(crm, 8, { modules: { 6: { text: 'x'.repeat(20_000) } } }).text;
  assert(large.length <= 15_000); assert(large.startsWith('x'.repeat(14800) + '\n\n[Transcript truncated.'));  assert(passes(find(crm.flow, 20).filter, { modules: { 6: { text: ' \n ' } } }));
});

test('scenario mappings use native JSON modules rather than SDK-only JSON functions', () => {
  for (const blueprint of [calendar, cleanup, crm, recording]) {
    assert(!/\b(?:createJSON|parseJSON)\(/.test(JSON.stringify(blueprint)));
  }
  assert.equal(find(crm.flow, 9).mapper.body, '{{22.json}}');
});

test('recordings download fresh URLs and uploads never use generic automatic retry', () => {
  assert.equal(find(recording.flow, 5).module, 'app#meetstream:getRecording'); assert.equal(find(recording.flow, 7).mapper.url, '{{5.video_url}}'); assert.equal(find(recording.flow, 7).mapper.serializeUrl, false);
  assert(!passes(find(recording.flow, 5).filter, { modules: { 3: { body: { files: [{ id: 'already-archived' }] } } } }));
  assert(!passes(find(recording.flow, 7).filter, { modules: { 2: { maxSizeMb: 20 }, 5: { video_info: {} } } }));
  assert.equal(find(recording.flow, 8).onerror, undefined);
  for (const blueprint of [calendar, cleanup, crm, recording]) {
    assert.equal(blueprint.metadata.scenario.confidential, true);
    assert.equal(blueprint.metadata.scenario.dlq, false);
    const visit = flow => { for (const module of flow) { assert.equal(module.onerror, undefined); for (const route of module.routes || []) visit(route.flow); } };
    visit(blueprint.flow);
  }
});


test('CRM refuses partial text caused by unsupported word values', () => {
  for (const text_incomplete of [false, true]) {
    const ctx = { modules: { 6: { text: 'Speech', text_incomplete } } };
    assert.equal(passes(find(crm.flow, 23).filter, ctx), text_incomplete);
    assert.equal(passes(find(crm.flow, 8).filter, ctx), !text_incomplete);
  }
});

test('calendar cleanup rechecks current revisions and cancels schedules moved outside the scan window', () => {
  const saved = { bot_id: 'scheduled-bot', status: 'scheduled', start_at: event.start.dateTime, meeting_url: 'https://meet.google.com/example-only' };
  const ctx = { modules: { 1: { id: event.id, status: 'cancelled' }, 2: { calendarId: 'primary', meetingLinkPattern: vars(calendar, 1, context).meetingLinkPattern }, 4: saved, 10: { body: event } } };
  assert.equal(evaluateScenario(find(cleanup.flow, 10).mapper, ctx).url, '/v3/calendars/primary/events/' + event.id);
  ctx.modules[11] = vars(cleanup, 11, ctx);
  // Stale cancellation from the watcher cannot stop an unchanged reactivated event.
  assert(!passes(find(cleanup.flow, 5).filter, ctx));
  for (const body of [
    { ...event, start: { dateTime: '2026-10-15T18:00:00Z' } },
    { ...event, start: { date: '2026-10-15' } },
    { ...event, conferenceData: undefined, hangoutLink: 'https://zoom.us/j/new-link' },
    { id: event.id, status: 'cancelled' }
  ]) {
    ctx.modules[10] = { body };
    ctx.modules[11] = vars(cleanup, 11, ctx);
    assert(passes(find(cleanup.flow, 5).filter, ctx));
  }
  assert(!passes(find(cleanup.flow, 10).filter, { modules: { 4: { ...saved, status: 'cancelled' } } }));
});

test('CRM accepts equal timestamps but rejects even fractionally older meetings', () => {
  const ctx = { modules: { 2: { details: { StartTime: '2026-10-14T12:00:00.500Z' } }, 3: { transcript_id: 'new-job' }, 4: { body: { properties: { meetstream_transcript_id: 'prior-job', meetstream_meeting_started_at: '2026-10-14T12:00:00.900Z' } } } } };
  assert(!passes(find(crm.flow, 6).filter, ctx));
  ctx.modules[4].body.properties.meetstream_meeting_started_at = '2026-10-14T17:30:00.500+05:30';
  assert(passes(find(crm.flow, 6).filter, ctx));
  ctx.modules[4].body.properties.meetstream_meeting_started_at = '';
  assert(passes(find(crm.flow, 6).filter, ctx));
  ctx.modules[4].body.properties.meetstream_transcript_id = 'new-job';
  assert(!passes(find(crm.flow, 6).filter, ctx));
});

test('Drive lookup escapes repeated quotes and backslashes and refuses absent results', () => {
  const ctx = { modules: { 2: { fileName: "O'Brien's\\archive\\clip.mp4", folderId: "folder'\\id" } } };
  const request = evaluateScenario(find(recording.flow, 3).mapper, ctx);
  assert.equal(request.qs[0].value, "name = 'O\\'Brien\\'s\\\\archive\\\\clip.mp4' and 'folder\\'\\\\id' in parents and trashed = false");
  assert(!passes(find(recording.flow, 5).filter, { modules: { 3: { body: {} } } }));
  assert(passes(find(recording.flow, 23).filter, { modules: { 3: { body: {} } } }));
  assert(passes(find(recording.flow, 5).filter, { modules: { 3: { body: { files: [] } } } }));
});

test('recording download requires positive numeric metadata within the plan limit', () => {
  for (const size_mb of [undefined, '', -1, 0, 'NaN', 'Infinity', 'garbage']) {
    const ctx = { modules: { 2: { maxSizeMb: 5 }, 5: { video_info: { size_mb } } } };
    assert(!passes(find(recording.flow, 7).filter, ctx), String(size_mb));
    assert(passes(find(recording.flow, 21).filter, ctx), String(size_mb));
  }
  for (const size_mb of [0.68, '0.68', 5]) {
    const ctx = { modules: { 2: { maxSizeMb: 5 }, 5: { video_info: { size_mb } } } };
    assert(passes(find(recording.flow, 7).filter, ctx));
    assert(!passes(find(recording.flow, 21).filter, ctx));
  }
});

const summaryDraft = await load('04-transcript-to-stored-summary');
const summaryRead = await load('04b-get-stored-summary');
const summaryCtx = { now, modules: { 1: { enabled: 'true', botId: 'synthetic-bot' }, 2: { transcript_id: 'synthetic-transcript' }, 4: { text: 'We decided to launch Friday.', text_incomplete: false } } };

test('summary workflow rejects bad transcript input before AI and has a safe disabled default', () => {
  assert.equal(vars(summaryDraft, 1, {}).enabled, 'false');
  assert.equal(vars(summaryRead, 1, {}).enabled, 'false');
  const valid = find(summaryDraft.flow, 6).filter;
  const invalid = find(summaryDraft.flow, 20).filter;
  assert(passes(valid, summaryCtx)); assert(!passes(invalid, summaryCtx));
  for (const text of ['', ' \n\t ', 'x'.repeat(60001)]) {
    const ctx = { ...summaryCtx, modules: { ...summaryCtx.modules, 4: { text, text_incomplete: false } } };
    assert(!passes(valid, ctx)); assert(passes(invalid, ctx));
  }
  for (const incomplete of [true, undefined]) {
    const ctx = { ...summaryCtx, modules: { ...summaryCtx.modules, 4: { text: 'Speech', text_incomplete: incomplete } } };
    assert(!passes(valid, ctx)); assert(passes(invalid, ctx));
  }
});

test('summary record identity is shared by independent retrieval and separates bot, transcript and calendar keys', () => {
  const key = vars(summaryDraft, 6, summaryCtx).key;
  const readContext = { modules: { 1: { botId: 'synthetic-bot', transcriptId: 'synthetic-transcript' } } };
  assert.equal(evaluateScenario(find(summaryRead.flow, 2).mapper.key, readContext), key);
  assert.match(key, /^summary:small-v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
  for (const [botId, transcript_id] of [['other-bot', 'synthetic-transcript'], ['synthetic-bot', 'other-transcript']]) {
    assert.notEqual(vars(summaryDraft, 6, { modules: { 1: { botId }, 2: { transcript_id } } }).key, key);
  }
  assert.equal(find(summaryDraft.flow, 13).mapper.overwrite, false);
  assert.equal(find(summaryDraft.flow, 13).mapper.data.summary_source, 'make_ai_toolkit');
  assert.equal(find(summaryDraft.flow, 13).mapper.data.summary_policy, 'small-v1');
});

test('cached summary bypasses AI while empty AI results cannot be stored', () => {
  for (const exist of [true, false]) {
    const ctx = { modules: { 7: { exist } } };
    assert.equal(passes(find(summaryDraft.flow, 9).filter, ctx), exist);
    assert.equal(passes(find(summaryDraft.flow, 11).filter, ctx), !exist);
  }
  for (const summary of ['', ' \n ', undefined, 'x'.repeat(20001)]) {
    const ctx = { modules: { 11: { summary } } };
    assert(passes(find(summaryDraft.flow, 21).filter, ctx));
    assert(!passes(find(summaryDraft.flow, 13).filter, ctx));
  }
  assert(passes(find(summaryDraft.flow, 13).filter, { modules: { 11: { summary: 'A real summary.' } } }));
});

test('stored summary retrieval verifies content and provenance before output', () => {
  const record = { bot_id: 'synthetic-bot', transcript_id: 'synthetic-transcript', summary: 'Launch Friday.', summary_source: 'make_ai_toolkit', summary_policy: 'small-v1', generated_at: now.toISOString() };
  const contextFor = value => ({ modules: { 1: { botId: 'synthetic-bot', transcriptId: 'synthetic-transcript' }, 2: value } });
  assert(passes(find(summaryRead.flow, 4).filter, contextFor(record)));
  assert(!passes(find(summaryRead.flow, 5).filter, contextFor(record)));
  for (const changed of [{ bot_id: 'wrong' }, { transcript_id: 'wrong' }, { summary_source: 'meetstream_api' }, { summary_policy: 'wrong' }, { summary: ' ' }, { summary: 'x'.repeat(20001) }, { generated_at: undefined }]) {
    const ctx = contextFor({ ...record, ...changed });
    assert(!passes(find(summaryRead.flow, 4).filter, ctx)); assert(passes(find(summaryRead.flow, 5).filter, ctx));
  }
  assert.equal(vars(summaryRead, 4, contextFor(record)).summary, record.summary);
  assert(!JSON.stringify(summaryRead).includes('ai-tools:'));
});
