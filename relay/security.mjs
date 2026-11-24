import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class RejectedEvent extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function verifyWorkspaceEvent(raw, headers, secret, now = Date.now(), tolerance = 300_000) {
  const signature = headers['x-meetstream-signature'];
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$(?![\s\S])/.test(signature)) throw new RejectedEvent(401, 'Invalid signature');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw new RejectedEvent(401, 'Invalid signature');
  const timestamp = headers['x-meetstream-timestamp'];
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || Math.abs(now - Date.parse(timestamp)) > tolerance) throw new RejectedEvent(401, 'Invalid delivery timestamp');
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { throw new RejectedEvent(400, 'Invalid JSON'); }
  if (!event || Array.isArray(event) || typeof event !== 'object') throw new RejectedEvent(400, 'Invalid event');
  if (typeof event.bot_id === 'number' && Number.isSafeInteger(event.bot_id) && event.bot_id > 0) event.bot_id = String(event.bot_id);
  if (typeof event.bot_id !== 'string' || !/^(?=[^\r\n]*\S)[^\r\n]{1,256}$(?![\s\S])/.test(event.bot_id)) throw new RejectedEvent(400, 'Invalid bot ID');
  const name = event.bot_event || event.event;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.]{0,100}$(?![\s\S])/.test(name)) throw new RejectedEvent(400, 'Invalid event name');
  // The header is unsigned. Require a timestamp inside the signed body too.
  if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new RejectedEvent(400, 'Invalid or missing signed event timestamp');
  if (Date.parse(event.timestamp) !== Date.parse(timestamp)) throw new RejectedEvent(401, 'Delivery timestamp does not match signed event');
  return event;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function deliveryId(event) {
  // Lifecycle statuses and one-shot artifacts survive manual resends whose
  // timestamp changes. Distinct transcription jobs use their transcript ID.
  // Other repeating/participant events retain the full signed payload identity.
  const name = event.bot_event || event.event;
  const oneShot = /^(?:bot\.(?:scheduled|in_waiting_room|inmeeting|recording|leaving|stopped|kicked|denied|notallowed|failed|done)|audio\.processed|video\.processed|data_deletion)$/.test(name) || (name === 'transcription.processed' && Boolean(event.transcript_id));
  const identity = oneShot
    ? { bot_id: event.bot_id, bot_event: name, transcript_id: event.transcript_id || null }
    : event;
  // A failed processing attempt must not consume the later success delivery.
  const outcomeField = { 'video.processed': 'video_status', 'audio.processed': 'audio_status', 'transcription.processed': 'transcript_status' }[name];
  if (oneShot && outcomeField) identity.outcome = event[outcomeField] ?? null;
  return createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
}

export function envelope(row, secret, now = Date.now()) {
  const issued_at = Math.floor(now / 1000);
  const signature = createHmac('sha256', secret).update(`${row.id}:${issued_at}:${row.payload}`).digest('hex');
  return { delivery_id: row.id, issued_at, payload: row.payload, signature };
}

export function retryDelay(attempt, retryAfter, now = Date.now(), random = Math.random) {
  const seconds = typeof retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : NaN;
  const dateDelay = typeof retryAfter === 'string' ? Date.parse(retryAfter) - now : NaN;
  const guidance = Number.isFinite(seconds) ? seconds : Number.isFinite(dateDelay) ? Math.max(0, dateDelay) : 0;
  const backoff = Math.min(300_000, 1000 * 2 ** Math.min(attempt - 1, 20)) * (0.75 + random() * 0.5);
  return Math.ceil(Math.max(backoff, guidance));
}

export function makeWebhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('MAKE_WEBHOOK_URL must be a Make webhook HTTPS URL'); }
  if (url.protocol !== 'https:' || !/^hook\.(?:eu1|eu2|us1|us2)\.make\.com$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('MAKE_WEBHOOK_URL must be on hook.eu1/eu2/us1/us2.make.com without credentials, query, or fragment');
  return url.href;
}
