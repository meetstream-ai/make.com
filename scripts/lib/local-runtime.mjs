// Contract harness for the expressions used by this app. This is deliberately
// not a replacement for Make's IML engine; live Make execution remains a gate.
import vm from 'node:vm';
import { createHmac, createHash } from 'node:crypto';

export function get(value, key) {
  return String(key).split('.').reduce((result, part) => result == null ? undefined : result[Array.isArray(result) && /^\d+$/.test(part) ? Number(part) - 1 : part], value);
}
const empty = value => value == null || value === '' || (Array.isArray(value) && value.length === 0);
const functions = {
  iif: (condition, yes, no) => condition ? yes : no,
  iswitch: (value, ...choices) => {
    for (let i = 0; i + 1 < choices.length; i += 2) if (value === choices[i]) return choices[i + 1];
    return choices.length % 2 ? choices.at(-1) : undefined;
  },
  ifempty: (value, fallback) => empty(value) ? fallback : value,
  get,
  omit: (value, ...keys) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !keys.includes(key))),
  parseJSON: value => JSON.parse(value), createJSON: value => JSON.stringify(value),
  flatten: value => Array.isArray(value) ? value.flat(Infinity).filter(item => item != null) : [],
  map: (value, key, filterKey, filterValue) => Array.isArray(value) ? value.filter(item => {
    if (item == null) throw new TypeError('Make map requires null entries to be removed first');
    return filterKey === undefined || get(item, filterKey) === filterValue;
  }).map(item => get(item, key)).filter(item => item != null) : [],
  first: value => value?.[0],
  remove: (value, ...values) => Array.isArray(value) ? value.filter(item => !values.includes(item)) : [],
  decodeURL: value => decodeURIComponent(value),
  keys: value => Object.keys(value || {}),
  toArray: value => Object.entries(value || {}).map(([key, value]) => ({ key, value })),
  merge: (...arrays) => arrays.flat(),
  sort: (value, order = 'asc', key) => [...(value || [])].sort((a, b) => {
    const left = key ? get(a, key) : a, right = key ? get(b, key) : b;
    const comparison = String(left ?? '').localeCompare(String(right ?? ''));
    return order === 'desc' ? -comparison : comparison;
  }),
  length: value => value?.length || 0,
  encodeURL: value => encodeURIComponent(value),
  toString: value => value == null ? '' : String(value),
  trim: value => String(value ?? '').trim(),
  substring: (value, start, end) => String(value ?? '').substring(start, end),
  replace: (value, search, replacement) => {
    const match = String(search).match(/^\/([\s\S]*)\/([gimsuy]*)$/);
    return String(value ?? '').replace(match ? new RegExp(match[1], match[2]) : search, replacement);
  },
  split: (value, separator) => String(value ?? '').split(separator),
  join: (value, separator) => Array.isArray(value) ? value.join(separator) : '',
  toCollection: (values, key, value) => Object.fromEntries((values || []).map(entry => [entry[key], entry[value]])),
  parseDate: (value, format) => {
    if (empty(value)) return null;
    const date = new Date(format === 'X' ? Number(value) * 1000 : value);
    if (!Number.isFinite(+date)) throw new Error('Invalid date');
    return date;
  },
  formatDate: (value, format) => empty(value) ? null : format === 'x' ? String(+new Date(value)) : format === 'X' ? String(Math.floor(+new Date(value) / 1000)) : new Date(value).toISOString(),
  addSeconds: (value, seconds) => new Date(+value + seconds * 1000),
  addMinutes: (value, minutes) => new Date(+value + Number(minutes) * 60_000),
  sha256: (value, encoding = 'hex', key) => (key ? createHmac('sha256', key) : createHash('sha256')).update(String(value)).digest(encoding)
};

export function evaluate(value, context = {}) {
  if (Array.isArray(value)) return value.map(item => evaluate(item, context));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '{{...}}') Object.assign(result, evaluate(item, context));
      else result[key] = evaluate(item, context);
    }
    return result;
  }
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  // Make preserves regex backslashes in quoted IML literals. JavaScript's
  // string parser would consume them, masking over-escaped generated patterns.
  const regexLiterals = expression => expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, literal => {
    const raw = literal.slice(1, -1);
    return /^\/[\s\S]*\/[gimsuy]*$/.test(raw) ? JSON.stringify(raw) : literal;
  });
  const execute = expression => vm.runInNewContext(regexLiterals(expression).replace(/\bif\s*\(/g, 'iif(').replace(/\bswitch\s*\(/g, 'iswitch('), { ...functions, ...context }, { timeout: 1000, codeGeneration: { strings: false, wasm: false } });
  const match = value.match(/^\{\{([\s\S]*)\}\}$/);
  if (match) return execute(match[1]);
  return value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => execute(expression) ?? '');
}

export function evaluateScenario(value, context) {
  function translate(value) {
    if (Array.isArray(value)) return value.map(translate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item)]));
    if (typeof value !== 'string') return value;
    return value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => {
      // Rewrite only outside string literals: scenario IML uses semicolons
      // and numeric module references, whereas app IML uses variables.
      const fragments = expression.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^'"]+/g) || [];
      return '{{' + fragments.map(fragment => /^["']/.test(fragment) ? fragment : fragment.replace(/;/g, ',').replace(/\b(\d+)\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g, (_, id, path) => `get(modules[${id}], '${path}')`)).join('') + '}}';
    });
  }
  return evaluate(translate(value), context);
}

export function validateParameters(fields, supplied, { defaults = true } = {}) {
  const result = { ...supplied };
  for (const field of fields) {
    if (!field.name) continue;
    if (result[field.name] == null && defaults && field.default !== undefined) result[field.name] = field.default;
    const value = result[field.name];
    if (empty(value)) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${field.label} must be a boolean`);
    if (['integer', 'uinteger', 'number'].includes(field.type) && (!Number.isFinite(Number(value)) || (field.type !== 'number' && !Number.isInteger(Number(value))))) throw new Error(`${field.label} must be numeric`);
    if (field.type === 'date' && !Number.isFinite(Date.parse(value))) throw new Error(`${field.label} must be a date`);
    if (field.type === 'text' || field.type === 'url' || field.type === 'password') {
      if (typeof value !== 'string') throw new Error(`${field.label} must be text`);
      if (field.validate?.pattern && !new RegExp(field.validate.pattern).test(value)) throw new Error(`${field.label} has an invalid format`);
    }
    const magnitude = typeof value === 'string' ? value.length : Number(value);
    if (field.validate?.min != null && magnitude < field.validate.min || field.validate?.max != null && magnitude > field.validate.max) throw new Error(`${field.label} is outside its limits`);
    if (field.type === 'select') {
      const option = field.options?.find(option => option.value === value);
      if (!option) throw new Error(`${field.label} has an invalid option`);
      if (option.nested) Object.assign(result, validateParameters(option.nested, result, { defaults }));
    }
    if (field.type === 'array') {
      if (!Array.isArray(value)) throw new Error(`${field.label} must be an array`);
      for (const entry of value) validateParameters(field.spec, entry, { defaults });
    }
  }
  return result;
}

export class ApiError extends Error {
  constructor(status, message, type, retryAfter) { super(message); Object.assign(this, { status, type, retryAfter }); }
}

export async function executeModule(definition, base, input, apiKey, { fetchImpl = fetch, now = new Date(), timeout = 40_000 } = {}) {
  const parameters = validateParameters(definition.expect, input);
  const api = definition.api;
  const context = { parameters, connection: { apiKey }, now, temp: {} };
  context.temp = evaluate(api.temp || {}, context);
  const url = new URL(evaluate(api.url, context), base.baseUrl);
  if (url.origin !== 'https://api.meetstream.ai') throw new Error('MeetStream host required');
  for (const [key, value] of Object.entries(evaluate(api.qs || {}, context))) if (value != null) url.searchParams.append(key, String(value));
  const headers = { ...evaluate(base.headers, context), ...evaluate(api.headers || {}, context) };
  const body = evaluate(api.body, context);
  const method = evaluate(api.method || 'GET', context);
  if (body !== undefined && api.type !== 'text') headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(url, { method, headers, ...(body === undefined || method === 'GET' ? {} : { body: api.type === 'text' ? String(body) : JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  Object.assign(context, { body: parsed, statusCode: response.status, headers: Object.fromEntries(response.headers) });
  const spec = { ...base.response, ...api.response };
  if (response.status < 200 || response.status >= 300) {
    const error = spec.error?.[response.status] || spec.error || {};
    throw new ApiError(response.status, evaluate(error.message || '[{{statusCode}}] MeetStream request failed.', context), error.type || (response.status === 429 ? 'RateLimitError' : response.status >= 500 ? 'ConnectionError' : 'RuntimeError'), response.headers.get('retry-after'));
  }
  if (spec.valid && !evaluate(spec.valid.condition ?? spec.valid, context)) throw new ApiError(response.status, spec.valid.message || 'Invalid response', spec.valid.type || 'RuntimeError');
  let output;
  if (spec.iterate) {
    const container = typeof spec.iterate === 'string' ? spec.iterate : spec.iterate.container;
    output = (evaluate(container, context) || []).filter(item => typeof spec.iterate === 'string' || evaluate(spec.iterate.condition ?? true, { ...context, item }))
      .slice(0, spec.limit == null ? undefined : evaluate(spec.limit, context)).map(item => evaluate(spec.output, { ...context, item }));
  } else output = evaluate(spec.output, context);
  return spec.wrapper ? evaluate(spec.wrapper, { ...context, output }) : output;
}
