import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { deliveryId } from './security.mjs';

export class Queue {
  constructor(filename, { capacity = 10_000, maxAttempts = 8, retentionDays = 90 } = {}) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.capacity = capacity;
    this.maxAttempts = maxAttempts;
    this.retentionDays = retentionDays;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, payload TEXT, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        lease_until INTEGER, received_at INTEGER NOT NULL, sent_at INTEGER, last_status INTEGER
      ); CREATE INDEX IF NOT EXISTS events_due ON events(status, next_at);`);
  }
  enqueue(event, raw, now = Date.now()) {
    const id = deliveryId(event);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM events WHERE id = ?').get(id)) { this.db.exec('COMMIT'); return { id, duplicate: true }; }
      const count = this.db.prepare("SELECT count(*) AS count FROM events WHERE status != 'sent'").get().count;
      if (count >= this.capacity) throw Object.assign(new Error('Queue capacity reached'), { status: 503 });
      this.db.prepare('INSERT INTO events (id, payload, next_at, received_at) VALUES (?, ?, ?, ?)').run(id, raw.toString('utf8'), now, now);
      this.db.exec('COMMIT');
      return { id, duplicate: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claim(now = Date.now()) {
    this.db.prepare("UPDATE events SET status = 'dead', lease_until = NULL WHERE status = 'delivering' AND lease_until < ? AND attempts >= ?").run(now, this.maxAttempts);
    return this.db.prepare(`UPDATE events SET status = 'delivering', attempts = attempts + 1, lease_until = ?
      WHERE id = (SELECT id FROM events WHERE (status = 'queued' AND next_at <= ?) OR (status = 'delivering' AND lease_until < ?) ORDER BY next_at LIMIT 1)
      RETURNING *`).get(now + 60_000, now, now);
  }
  complete(row, now = Date.now()) {
    this.db.prepare("UPDATE events SET status = 'sent', payload = NULL, sent_at = ?, lease_until = NULL, last_status = 202 WHERE id = ? AND attempts = ? AND lease_until = ? AND status = 'delivering'").run(now, row.id, row.attempts, row.lease_until);
  }
  fail(row, status, delay, retryable = true, now = Date.now()) {
    const nextStatus = retryable && row.attempts < this.maxAttempts ? 'queued' : 'dead';
    this.db.prepare("UPDATE events SET status = ?, next_at = ?, lease_until = NULL, last_status = ? WHERE id = ? AND attempts = ? AND lease_until = ? AND status = 'delivering'").run(nextStatus, now + delay, status, row.id, row.attempts, row.lease_until);
    return nextStatus;
  }
  stats() {
    return Object.fromEntries(this.db.prepare('SELECT status, count(*) AS count FROM events GROUP BY status').all().map(row => [row.status, row.count]));
  }
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM events WHERE status = 'sent' AND sent_at < ?").run(now - this.retentionDays * 86_400_000);
  }
  requeue(id, now = Date.now()) {
    return this.db.prepare("UPDATE events SET status = 'queued', attempts = 0, next_at = ? WHERE id = ? AND status = 'dead' AND payload IS NOT NULL").run(now, id).changes;
  }
  close() { this.db.close(); }
}
