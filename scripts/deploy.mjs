import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deploymentPlan, deployApp } from './lib/deploy-app.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = JSON.parse(await readFile(path.join(root, 'dist/meetstream.app.json'), 'utf8'));
const appId = process.env.MAKE_APP_ID || bundle.app.name;
const zone = process.env.MAKE_ZONE || 'eu1.make.com';
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/deploy.mjs [--apply]');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'dry-run', ...deploymentPlan(bundle, appId, zone), note: 'Configure MAKE_API_TOKEN locally, choose a unique MAKE_APP_ID, then run npm run deploy. This only uploads private components; it never publishes or requests review.' }, null, 2));
} else {
  const result = await deployApp({ bundle, appId, zone, root, token: process.env.MAKE_API_TOKEN });
  console.log(`Uploaded private ${result.appId} v${result.appVersion} to ${result.zone}. Verify the Make runtime and commit in Apps Editor before review.`);
}
