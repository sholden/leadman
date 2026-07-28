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
  // Live progress + per-run outcome counters.
  addColumnIfMissing('runs', 'current_step', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('runs', 'sources_added', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('runs', 'projects_found', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('runs', 'facts_added', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('runs', 'sources_scanned', 'INTEGER NOT NULL DEFAULT 0');

  backfillRunCounters();

  const insert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const seed = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
  });
  seed();
}

/**
 * Runs predating the outcome counters would otherwise show zero results forever.
 * Both numbers are recoverable from tables that already carry run_id, so derive
 * them once rather than leaving the activity view looking empty.
 */
function backfillRunCounters() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'runCountersBackfilled2'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  db.exec(`
    UPDATE runs SET projects_found = (
      SELECT COUNT(*) FROM project_updates u
      WHERE u.run_id = runs.id AND u.kind = 'discovered'
    ) WHERE projects_found = 0;

    UPDATE runs SET sources_scanned = (
      SELECT COUNT(*) FROM source_scans sc WHERE sc.run_id = runs.id
    ) WHERE sources_scanned = 0;
  `);

  // Sources carry no run_id, so attribute them to the discovery run that was
  // active when they were created. Approximate, but only used for history.
  db.exec(`
    UPDATE runs SET sources_added = (
      SELECT COUNT(*) FROM sources s
      WHERE s.origin = 'ai'
        AND s.created_at >= runs.started_at
        AND s.created_at <= IFNULL(runs.finished_at, runs.started_at)
    ) WHERE kind = 'discovery' AND sources_added = 0;
  `);
  db.prepare("INSERT INTO settings (key, value) VALUES ('runCountersBackfilled2', ?)").run(
    new Date().toISOString(),
  );
  console.log('[db] backfilled run outcome counters from existing history');
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
