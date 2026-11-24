import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function deploymentPlan(bundle, appId = bundle.app.name, zone = 'eu1.make.com') {
  if (!/^[a-z][0-9a-z-]+[0-9a-z]$(?![\s\S])/.test(appId)) throw new Error('MAKE_APP_ID must follow Make app naming rules');
  if (!/^(?:eu1|eu2|us1|us2)\.make\.com$(?![\s\S])/.test(zone)) throw new Error('MAKE_ZONE must be an official Make production zone');
  return { zone, appId, appVersion: bundle.app.version, modules: Object.keys(bundle.modules), visibility: 'private' };
}

export async function deployApp({ bundle, appId, zone, token, root, fetchImpl = fetch }) {
  const plan = deploymentPlan(bundle, appId, zone);
  if (!token) throw new Error('Set MAKE_API_TOKEN locally with sdk-apps:read and sdk-apps:write scopes. Never paste it into chat.');
  const basePath = `/sdk/apps/${plan.appId}/${plan.appVersion}`;
  const stateFile = path.join(root, '.local', 'deployments', plan.zone, plan.appId, 'state.json');
  let state = {};
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.appId && (state.appId !== plan.appId || state.zone !== plan.zone || state.appVersion !== plan.appVersion)) throw new Error('Deployment state does not match this app and zone');
  async function request(method, endpoint, body, allowed = [], contentType = 'application/json') {
    const response = await fetchImpl(`https://${plan.zone}/api/v2${endpoint}`, {
      method, headers: { Authorization: `Token ${token}`, 'Content-Type': contentType },
      ...(body === undefined ? {} : { body: contentType === 'application/json' ? JSON.stringify(body) : body }),
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok && !allowed.includes(response.status)) throw new Error(`Make ${method} ${endpoint}: HTTP ${response.status}. Remote error bodies are omitted to protect secrets.`);
    return { result, status: response.status };
  }
  const save = async () => {
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temp = stateFile + '.tmp';
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(temp, stateFile);
  };
  const existing = await request('GET', basePath, undefined, [404]);
  if (existing.status !== 404) {
    if (!state.appId) throw new Error('This remote app is not tracked by this workspace. Choose a unique MAKE_APP_ID or reconcile ownership before uploading.');
    const remote = existing.result.app;
    if (!remote || remote.public !== false) throw new Error('Deployment requires a confirmed private app. Inspect visibility in the Apps Editor.');
  } else {
    if (state.appId) throw new Error('Tracked app is missing remotely. Reconcile state instead of reusing stale component identities.');
    await request('POST', '/sdk/apps', { app: { ...bundle.app, name: plan.appId, public: false } });
  }
  state = { ...state, appId: plan.appId, appVersion: plan.appVersion, zone: plan.zone, phase: 'uploading' };
  await save();
  await request('POST', `${basePath}/base`, bundle.base);
  const identity = (value, label) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value)) throw new Error(`Make did not return a valid ${label} identity. Reconcile it in Apps Editor before retrying.`);
    return value;
  };
  const ensureComponent = async (kind, definition, stateKey) => {
    // Read the catalog before creation. A retry after an ambiguous creation can
    // recover the original component by label rather than create a duplicate.
    const catalog = await request('GET', `/sdk/apps/${plan.appId}/${kind}s`);
    const items = catalog.result[kind === 'connection' ? 'appConnections' : 'appWebhooks'];
    if (!Array.isArray(items)) throw new Error(`Make returned an unexpected ${kind} catalog; no component was created`);
    if (!state[stateKey]) {
      const matches = items.filter(item => item.label === definition.metadata.label);
      if (matches.length > 1) throw new Error(`Multiple ${kind}s share the expected label; reconcile them before retrying`);
      const result = matches[0] || (await request('POST', `/sdk/apps/${plan.appId}/${kind}s`, definition.metadata)).result[kind === 'connection' ? 'appConnection' : 'appWebhook'];
      state[stateKey] = identity(result?.name, kind);
      await save();
    } else {
      identity(state[stateKey], kind);
      if (!items.some(item => item.name === state[stateKey])) throw new Error(`Tracked ${kind} is missing; reconcile the component instead of recreating it`);
    }
    for (const section of ['parameters', 'api']) await request('PUT', `/sdk/apps/${kind}s/${state[stateKey]}/${section}`, definition[section]);
  };
  await ensureComponent('connection', bundle.connections.apiKey, 'connection');
  await ensureComponent('webhook', bundle.webhooks.meetingEvents, 'webhook');
  const remoteModules = (await request('GET', `${basePath}/modules`)).result.appModules;
  if (!Array.isArray(remoteModules)) throw new Error('Make returned an unexpected module catalog; upload stopped');
  for (const [name, definition] of Object.entries(bundle.modules)) {
    const metadata = { ...definition.metadata, ...(definition.metadata.connection ? { connection: state.connection } : {}), ...(definition.metadata.webhook ? { webhook: state.webhook } : {}) };
    if (!remoteModules.some(module => module.name === name)) await request('POST', `${basePath}/modules`, metadata);
    else await request('PATCH', `${basePath}/modules/${name}`, { label: metadata.label, description: metadata.description, ...(metadata.connection ? { connection: metadata.connection } : {}) });
    for (const section of ['api', 'parameters', 'expect', 'interface', 'samples']) await request('PUT', `${basePath}/modules/${name}/${section}`, definition[section]);
  }
  await request('PUT', `${basePath}/readme`, await readFile(path.join(root, 'docs/user-guide.md'), 'utf8'), [], 'text/markdown');
  state.phase = 'uploaded'; state.uploadedAt = new Date().toISOString(); await save();
  return state;
}
