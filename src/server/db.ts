import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';
import type { EventRow, EventStats, GuestRow } from '../shared/types';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'invitaciones.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Migraciones en orden. Cada una se aplica una sola vez según PRAGMA user_version.
const migrations: string[] = [
  `
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    date          TEXT NOT NULL,
    time          TEXT NOT NULL,
    venue         TEXT NOT NULL,
    address       TEXT NOT NULL DEFAULT '',
    wa_template   TEXT NOT NULL,
    email_subject TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE guests (
    id              INTEGER PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    business        TEXT NOT NULL DEFAULT '',
    phone           TEXT,
    email           TEXT,
    token           TEXT NOT NULL UNIQUE,
    email_status    TEXT NOT NULL DEFAULT 'pending',
    email_sent_at   TEXT,
    email_error     TEXT,
    wa_status       TEXT NOT NULL DEFAULT 'pending',
    wa_queued_at    TEXT,
    wa_message_id   TEXT,
    wa_sent_at      TEXT,
    wa_error        TEXT,
    wa_replied_at   TEXT,
    confirmed_at    TEXT,
    checked_in_at   TEXT,
    checked_in_role TEXT,
    created_at      TEXT NOT NULL
  );

  CREATE UNIQUE INDEX guests_event_phone ON guests(event_id, phone) WHERE phone IS NOT NULL;
  CREATE INDEX guests_event ON guests(event_id);
  CREATE INDEX guests_wa_status ON guests(wa_status);
  CREATE INDEX guests_wa_message ON guests(wa_message_id);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

function migrate() {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
migrate();

export const nowIso = () => new Date().toISOString();

export function kvGet<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return { ...fallback, ...JSON.parse(row.value) };
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

// ── Consultas compartidas ────────────────────────────────────────

export const getEvent = (id: number) =>
  db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;

export const getGuest = (id: number) =>
  db.prepare('SELECT * FROM guests WHERE id = ?').get(id) as GuestRow | undefined;

export const getGuestByToken = (token: string) =>
  db.prepare('SELECT * FROM guests WHERE token = ?').get(token) as GuestRow | undefined;

export const listGuests = (eventId: number) =>
  db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY name COLLATE NOCASE').all(eventId) as GuestRow[];

export function eventStats(eventId: number): EventStats {
  return db
    .prepare(
      `SELECT
        COUNT(*)                                                         AS total,
        SUM(email_status = 'sent')                                       AS emailSent,
        SUM(email_status = 'failed')                                     AS emailFailed,
        SUM(wa_status = 'queued')                                        AS waQueued,
        SUM(wa_status IN ('sent','delivered','read'))                    AS waSent,
        SUM(wa_status IN ('delivered','read'))                           AS waDelivered,
        SUM(wa_status = 'read')                                          AS waRead,
        SUM(wa_status IN ('failed','no_whatsapp','uncertain'))           AS waProblems,
        SUM(confirmed_at IS NOT NULL)                                    AS confirmed,
        SUM(checked_in_at IS NOT NULL)                                   AS checkedIn
      FROM guests WHERE event_id = ?`,
    )
    .get(eventId) as EventStats;
}

/** SUM() sobre cero filas devuelve NULL; el panel espera números. */
export function normalizeStats(s: EventStats): EventStats {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v ?? 0)])) as unknown as EventStats;
}
