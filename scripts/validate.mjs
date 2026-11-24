import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
assert.equal(bundle.app.public, false);
assert.equal(bundle.base.baseUrl, 'https://api.meetstream.ai');
assert.equal(bundle.base.followRedirects, false);
assert.equal(bundle.base.followAllRedirects, false);
assert(bundle.base.log.sanitize.includes('request.headers.authorization'));
const names = new Set(Object.keys(bundle.modules));
assert.equal(names.size, 10);
assert.equal(bundle.modules.makeApiCall.metadata.typeId, 12);
assert.equal(bundle.modules.watchMeetingEvents.metadata.typeId, 10);
for (const [name, module] of Object.entries(bundle.modules)) {
  assert.equal(module.metadata.name, name);
  assert(module.metadata.description && module.metadata.label);
  assert(Array.isArray(module.expect) && Array.isArray(module.parameters) && Array.isArray(module.interface));
  const fields = new Set(module.interface.map(field => field.name));
  assert.equal(fields.size, module.interface.length);
  for (const key of Object.keys(module.samples)) assert(fields.has(key), `${name}: sample field ${key} has no interface`);
  if (module.metadata.typeId !== 10) {
    assert(module.api.url.startsWith('/api/v1/') || module.api.url.startsWith('https://api.meetstream.ai'));
    assert(module.metadata.connection === 'apiKey');
  }
  if (module.metadata.typeId === 9) assert(module.expect.some(field => field.name === 'limit'));
  const visit = fields => {
    for (const field of fields) {
      if (field.validate?.pattern) new RegExp(field.validate.pattern);
      if (field.spec) visit(field.spec);
      if (field.options) for (const option of field.options) if (option.nested) visit(option.nested);
    }
  };
  visit(module.expect);
}
const webhook = bundle.webhooks.meetingEvents;
assert.equal(webhook.parameters[0].type, 'password');
assert(webhook.api.verification.condition.includes('sha256('));
assert(webhook.api.verification.condition.includes('addSeconds(now, -300)'));
assert.equal(webhook.api.verification.respond.status, 401);
assert.equal(webhook.api.respond.status, 202);
assert(webhook.api.output.bot_event.includes("'bot_event'"));
assert(!JSON.stringify(bundle).includes('Idempotency-Key":'));
const dir = new URL('../templates/', import.meta.url);
const files = (await readdir(dir)).filter(file => file.endsWith('.blueprint.json'));
assert(files.length >= 3);
for (const file of files) {
  const blueprint = JSON.parse(await readFile(new URL(file, dir)));
  assert.equal(blueprint.metadata.scenario.sequential, true);
  assert.equal(blueprint.metadata.scenario.confidential, true);
  assert.equal(blueprint.metadata.scenario.dlq, false);
  const ids = new Set();
  const traverse = flow => {
    for (const module of flow) {
      assert(!ids.has(module.id), `${file}: duplicate module ID`); ids.add(module.id);
      assert.equal(typeof module.version, 'number');
      assert(module.metadata.designer);
      if (module.module.startsWith('app#meetstream:')) assert(names.has(module.module.split(':')[1]));
      for (const key of ['__IMTCONN__', 'makeConnectionId']) {
        assert(!(key in module.parameters), `${file}: account connection reference leaked`);
      }
      if (module.onerror) traverse(module.onerror);
      if (module.routes) for (const route of module.routes) traverse(route.flow);
    }
  };
  traverse(blueprint.flow);
  const text = JSON.stringify(blueprint);
  assert(!/\b(?:createJSON|parseJSON)\(/.test(text), `${file}: SDK-only JSON function in scenario mapper; use a native JSON module`);
  assert(!/Token [A-Za-z0-9]|sha256=[a-f0-9]{64}|x-meetstream-signature/i.test(text), `${file}: secret-shaped data`);
}
console.log(`Validated ${names.size} modules, connection, verified webhook, and ${files.length} blueprint drafts. Make runtime validation is a separate release gate.`);
