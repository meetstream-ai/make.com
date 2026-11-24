import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindBlueprint } from '../scripts/lib/bind-blueprint.mjs';

test('private app binding matches Make exports and preserves every safety gate', async () => {
  const draft = JSON.parse(await readFile(new URL('../templates/01-calendar-auto-join.blueprint.json', import.meta.url)));
  const original = JSON.stringify(draft);
  const bound = bindBlueprint(draft, 'meetstream-dev-example');
  const result = JSON.stringify(bound);
  assert.equal(result, original.replaceAll('app#meetstream:', 'app#meetstream-dev-example:'));
  assert.equal(JSON.stringify(draft), original);
  assert(result.includes('app#meetstream-dev-example:createBot'));
  assert(result.includes('app#meetstream-dev-example:makeApiCall'));
  assert(!result.includes('"module":"meetstream:'));
});

test('app binding rejects path traversal, URLs and malformed IDs', () => {
  for (const value of ['../secret', 'https://make.com', 'app#meetstream', 'meetstream\n', '', null]) {
    assert.throws(() => bindBlueprint({ flow: [] }, value));
  }
});

test('CRM JSON binding uses an account data structure without leaking it into the draft', async () => {
  const draft = JSON.parse(await readFile(new URL('../templates/02-transcript-to-hubspot.blueprint.json', import.meta.url)));
  const bound = bindBlueprint(draft, 'meetstream-test', { crmJsonStructureId: 123 });
  assert(JSON.stringify(bound).includes('"type":123'));
  assert(!JSON.stringify(draft).includes('"type":123'));
  for (const id of [-1, 0, '123', Infinity, 1.5]) assert.throws(() => bindBlueprint(draft, 'meetstream-test', { crmJsonStructureId: id }));
});

test('calendar store binding reaches every nested branch and the cancellation companion', async () => {
  for (const file of ['01-calendar-auto-join', '01b-calendar-change-cleanup']) {
    const draft = JSON.parse(await readFile(new URL(`../templates/${file}.blueprint.json`, import.meta.url)));
    const bound = bindBlueprint(draft, 'meetstream-test', { calendarDataStoreId: 123 });
    const visit = flow => {
      for (const module of flow) {
        if (module.module.startsWith('datastore:')) assert.equal(module.parameters.datastore, 123);
        for (const route of module.routes || []) visit(route.flow);
        if (module.onerror) visit(module.onerror);
      }
    };
    visit(bound.flow);
    assert(!JSON.stringify(draft).includes('"datastore":123'));
  }
  for (const id of [-1, 0, '123', Infinity, 1.5]) assert.throws(() => bindBlueprint({ flow: [] }, 'meetstream-test', { calendarDataStoreId: id }));
});

test('summary datastore binding is separate from calendar state and reaches both workflows', async () => {
  for (const file of ['04-transcript-to-stored-summary', '04b-get-stored-summary']) {
    const draft = JSON.parse(await readFile(new URL(`../templates/${file}.blueprint.json`, import.meta.url)));
    const withCalendarOnly = bindBlueprint(draft, 'meetstream-test', { calendarDataStoreId: 123 });
    assert(JSON.stringify(withCalendarOnly).includes('SUMMARY_DATA_STORE_ID'));
    const bound = bindBlueprint(draft, 'meetstream-test', { calendarDataStoreId: 123, summaryDataStoreId: 456 });
    assert(!JSON.stringify(bound).includes('SUMMARY_DATA_STORE_ID'));
    assert(!JSON.stringify(bound).includes('"datastore":123'));
    assert(JSON.stringify(bound).includes('"datastore":456'));
    const rebound = bindBlueprint(bound, 'meetstream-test', { calendarDataStoreId: 123 });
    assert(!JSON.stringify(rebound).includes('"datastore":123'));
    assert(JSON.stringify(rebound).includes('"datastore":456'));
    assert(JSON.stringify(draft).includes('SUMMARY_DATA_STORE_ID'));
  }
  for (const id of [-1, 0, '123', Infinity, 1.5]) assert.throws(() => bindBlueprint({ flow: [] }, 'meetstream-test', { summaryDataStoreId: id }));
});
