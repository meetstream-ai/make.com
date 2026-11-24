import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deploymentPlan, deployApp } from '../scripts/lib/deploy-app.mjs';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meetstream-deploy-test-'));
  await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs/user-guide.md'), '# Synthetic guide');
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function mockMake() {
  const apps = new Map(); const calls = []; let failOnce;
  const fetchImpl = async (url, options) => {
    const target = new URL(url), endpoint = target.pathname.replace('/api/v2', ''); const method = options.method;
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Token synthetic');
    calls.push({ zone: target.hostname, endpoint, method });
    if (failOnce?.(endpoint, method)) { failOnce = null; return new Response('{"sensitive":"synthetic-key"}', { status: 503 }); }
    const name = endpoint.match(/^\/sdk\/apps\/([a-z0-9-]+)/)?.[1];
    const mapKey = `${target.hostname}:${name}`; const app = apps.get(mapKey);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (endpoint === '/sdk/apps' && method === 'POST') {
      const body = JSON.parse(options.body).app; assert.equal(body.public, false);
      apps.set(`${target.hostname}:${body.name}`, { public: false, connections: [], webhooks: [], modules: [] }); return json({ app: body });
    }
    if (/^\/sdk\/apps\/[^/]+\/1$/.test(endpoint) && method === 'GET') return app ? json({ app: { public: app.public } }) : json({}, 404);
    if (/\/(?:connections|webhooks)$/.test(endpoint) && !endpoint.includes('/1/')) {
      const kind = endpoint.endsWith('/connections') ? 'connections' : 'webhooks';
      if (method === 'GET') return json({ [kind === 'connections' ? 'appConnections' : 'appWebhooks']: app[kind] });
      const component = { ...JSON.parse(options.body), name: `${name}-${kind}` }; app[kind].push(component);
      return json({ [kind === 'connections' ? 'appConnection' : 'appWebhook']: component });
    }
    if (endpoint.endsWith('/1/modules')) {
      if (method === 'GET') return json({ appModules: app.modules });
      app.modules.push(JSON.parse(options.body)); return json({});
    }
    return json({});
  };
  return { apps, calls, fetchImpl, fail: predicate => { failOnce = predicate; } };
}

test('private deployment resumes partial uploads without recreating components', async t => {
  const root = await workspace(t); const make = mockMake();
  const args = { root, bundle, appId: 'meetstream-dev', zone: 'eu1.make.com', token: 'synthetic', fetchImpl: make.fetchImpl };
  make.fail((endpoint, method) => endpoint.endsWith('/createBot/expect') && method === 'PUT');
  await assert.rejects(deployApp(args), error => error.message.includes('503') && !error.message.includes('synthetic-key'));
  const state = await deployApp(args); assert.equal(state.phase, 'uploaded');
  assert.equal(make.calls.filter(call => call.method === 'POST' && call.endpoint === '/sdk/apps').length, 1);
  assert.equal(make.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/connections')).length, 1);
  assert.equal(make.calls.filter(call => call.method === 'POST' && call.endpoint.endsWith('/webhooks')).length, 1);
  assert(!make.calls.some(call => /publish|review|commit/.test(call.endpoint)));
});

test('deployment state and component IDs are isolated by app and zone', async t => {
  const root = await workspace(t); const make = mockMake();
  for (const [appId, zone] of [['meetstream-first', 'eu1.make.com'], ['meetstream-second', 'eu1.make.com'], ['meetstream-first', 'us1.make.com']]) {
    const state = await deployApp({ root, bundle, appId, zone, token: 'synthetic', fetchImpl: make.fetchImpl });
    assert.equal(state.connection, `${appId}-connections`);
    const persisted = JSON.parse(await readFile(path.join(root, '.local/deployments', zone, appId, 'state.json')));
    assert.equal(persisted.zone, zone); assert.equal(persisted.appId, appId);
  }
});

test('uploader refuses unknown or public remote apps instead of mutating them', async t => {
  const root = await workspace(t); const make = mockMake();
  const args = { root, bundle, appId: 'meetstream-dev', zone: 'eu1.make.com', token: 'synthetic', fetchImpl: make.fetchImpl };
  make.apps.set('eu1.make.com:meetstream-dev', { public: false, connections: [], webhooks: [], modules: [] });
  await assert.rejects(deployApp(args), /not tracked/);
  make.apps.delete('eu1.make.com:meetstream-dev'); await deployApp(args);
  make.apps.get('eu1.make.com:meetstream-dev').public = true;
  const prior = make.calls.length; await assert.rejects(deployApp(args), /private/);
  assert.equal(make.calls.length - prior, 1);
});

test('dry-run target validation rejects path/zone injection and missing tokens', async t => {
  for (const [name, zone] of [['bad/name', 'eu1.make.com'], ['meetstream-dev', 'evil.example'], ['meetstream-dev\n', 'eu1.make.com']]) assert.throws(() => deploymentPlan(bundle, name, zone));
  const root = await workspace(t); await assert.rejects(deployApp({ root, bundle, appId: 'meetstream-dev', zone: 'eu1.make.com' }), /MAKE_API_TOKEN/);
});
