import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DEFAULT_SETTINGS, type SettingKey } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Adds a column only if it isn't already there, so migrate() stays idempotent. */
function addColumnIfMissing(table: string, column: string, declaration: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length === 0) return; // table doesn't exist yet; schema.sql will create it
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  console.log(`[db] added column ${table}.${column}`);
}

export function migrate() {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Columns added to tables that already existed in an earlier version.
  // SQLite cannot add a column with a REFERENCES clause to an existing table,
  // so the type is plain here; the FK exists on freshly-created databases.
  addColumnIfMissing('projects', 'work_type_id', 'TEXT');

  const insert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const seed = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
  });
  seed();
}

export function getSetting(key: SettingKey): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key];
}

export function getNumberSetting(key: SettingKey): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(DEFAULT_SETTINGS[key]);
}

export function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
