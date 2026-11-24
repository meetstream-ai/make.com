import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindBlueprint } from './lib/bind-blueprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const appId = process.argv[2];
if (!appId || ![3, 4, 5, 6].includes(process.argv.length)) throw new Error('Usage: npm run templates:bind -- APP_ID [CRM_JSON_STRUCTURE_ID] [CALENDAR_DATA_STORE_ID] [SUMMARY_DATA_STORE_ID]');
const options = process.argv[3] === undefined ? {} : { crmJsonStructureId: Number(process.argv[3]) };
if (process.argv[4] !== undefined) options.calendarDataStoreId = Number(process.argv[4]);
if (process.argv[5] !== undefined) options.summaryDataStoreId = Number(process.argv[5]);
// Validate before touching the filesystem; IDs cannot become path traversal.
bindBlueprint({ flow: [] }, appId, options);
const destination = path.join(root, '.local', 'templates', appId);
await mkdir(destination, { recursive: true });
for (const file of (await readdir(path.join(root, 'templates'))).filter(file => file.endsWith('.blueprint.json'))) {
  const draft = JSON.parse(await readFile(path.join(root, 'templates', file), 'utf8'));
  await writeFile(path.join(destination, file), JSON.stringify(bindBlueprint(draft, appId, options), null, 2) + '\n');
}
console.log(`Account-bound drafts written to ${destination}. Configure connections, stores and webhooks in Make; safety gates remain disabled.`);
