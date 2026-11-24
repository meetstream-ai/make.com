import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
const bundle = JSON.parse(await readFile(new URL('../dist/meetstream.app.json', import.meta.url)));
const ajv = new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false });
for (const part of ['communication', 'base', 'parameters', 'interface']) {
  test(`native definitions match Make's published ${part} schema`, async () => {
    const schema = JSON.parse(await readFile(new URL(`schemas/${part}.schema.json`, import.meta.url)));
    const validate = ajv.compile(schema);
    const defs = part === 'base' ? [['base', bundle.base]] : Object.entries(bundle.modules).filter(([, module]) => part !== 'communication' || module.metadata.typeId !== 10).map(([name, module]) => [name, module[part === 'communication' ? 'api' : part === 'parameters' ? 'expect' : part]]);
    for (const [name, value] of defs) assert(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
  });
}
