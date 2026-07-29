import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  config,
  DEFAULT_SETTINGS,
  DEFAULT_SITE_SETTINGS,
  type SettingKey,
  type SiteSettingKey,
} from '../config.js';
import { currentAccountId } from '../lib/context.js';

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

function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Tables that gained an account_id when tenancy was introduced. */
const TENANT_TABLES = [
  'profiles',
  'work_types',
  'sources',
  'projects',
  'runs',
  'artifacts',
  'usage_ledger',
] as const;

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

  // Tenancy. Nullable on pre-existing tables, then backfilled below.
  for (const table of TENANT_TABLES) addColumnIfMissing(table, 'account_id', 'TEXT');

  // Indexes over account_id live here rather than in schema.sql: on a database
  // upgrading from before tenancy, schema.sql runs while these tables still
  // lack the column, and CREATE INDEX would fail on a column that isn't there.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_profiles_account ON profiles (account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_types_account ON work_types (account_id);
    CREATE INDEX IF NOT EXISTS idx_sources_account ON sources (account_id, status);
    CREATE INDEX IF NOT EXISTS idx_projects_account ON projects (account_id, status);
    CREATE INDEX IF NOT EXISTS idx_runs_account ON runs (account_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts (account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_account_month ON usage_ledger (account_id, month_key);
  `);

  backfillRunCounters();

  // Order matters. Reshaping `settings` must come first, because creating an
  // account seeds settings into it; adoption must come after, because it needs
  // an account to adopt into.
  const legacySettings = reshapeSettingsTable();
  adoptOrphanedData();
  if (legacySettings) applyLegacySettings(legacySettings);
  relocateSchedulerInterval();

  const insert = db.prepare(
    'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const seed = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SITE_SETTINGS)) insert.run(key, value);
  });
  seed();
}

/** Lowercase, hyphenated, unique-ified. Only used for human-facing account URLs. */
function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account';
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM accounts WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function createAccount(name: string): string {
  const id = newId();
  const now = nowIso();
  db.prepare(
    'INSERT INTO accounts (id, name, slug, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(id, name, slugify(name), now, now);
  seedAccountSettings(id);
  return id;
}

/** Gives a new account its own copy of the defaults, so it is configurable in isolation. */
export function seedAccountSettings(accountId: string) {
  const insert = db.prepare(
    'INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT(account_id, key) DO NOTHING',
  );
  const seed = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(accountId, key, value);
  });
  seed();
}

/**
 * The account that pre-tenancy rows belong to.
 *
 * Everything in the database predates accounts existing, so it all belongs to
 * whoever was running the installation. Rather than stranding it, adopt it into
 * the oldest account — creating one if this is a fresh install, so the boot-time
 * admin seed always has somewhere to land.
 */
export function primaryAccountId(): string {
  const existing = db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = createAccount(config.bootstrapAccountName);
  console.log(`[db] created account "${config.bootstrapAccountName}"`);
  return id;
}

/** Assigns every pre-tenancy row to the primary account. */
function adoptOrphanedData() {
  const orphaned = TENANT_TABLES.some(
    (t) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id IS NULL`).get() as { n: number })
        .n > 0,
  );
  const noAccounts =
    (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n === 0;
  if (!orphaned && !noAccounts) return;

  const accountId = primaryAccountId();
  if (!orphaned) return;

  const adopt = db.transaction(() => {
    for (const table of TENANT_TABLES) {
      const res = db
        .prepare(`UPDATE ${table} SET account_id = ? WHERE account_id IS NULL`)
        .run(accountId);
      if (res.changes > 0) console.log(`[db] adopted ${res.changes} row(s) in ${table}`);
    }
  });
  adopt();
}

/**
 * Rebuilds `settings` from one global key/value table into one keyed by account.
 *
 * SQLite cannot repoint a primary key in place, so the table is recreated.
 * Structural only — it returns the operator's old values rather than writing
 * them, because at this point in the migration there is no account to key them
 * to yet, and creating one writes to this very table.
 *
 * Returns null when the table is already per-account.
 */
function reshapeSettingsTable(): { key: string; value: string }[] | null {
  if (hasColumn('settings', 'account_id')) return null;

  const existing = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];

  db.transaction(() => {
    db.exec(`
      ALTER TABLE settings RENAME TO settings_legacy;
      CREATE TABLE settings (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (account_id, key)
      );
      DROP TABLE settings_legacy;
    `);
  })();
  return existing;
}

/**
 * Carries the operator's pre-tenancy configuration onto the primary account, so
 * their chosen model and budget survive the upgrade instead of silently
 * reverting to defaults.
 */
function applyLegacySettings(legacy: { key: string; value: string }[]) {
  const accountId = primaryAccountId();
  const perAccount = db.prepare(
    `INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`,
  );
  const siteWide = db.prepare(
    'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  db.transaction(() => {
    for (const row of legacy) {
      // Bookkeeping flags from earlier migrations are installation-wide, not
      // per-account, and must not be duplicated into every future tenant.
      if (row.key in DEFAULT_SETTINGS) perAccount.run(accountId, row.key, row.value);
      else siteWide.run(row.key, row.value);
    }
  })();
  console.log(`[db] moved ${legacy.length} setting(s) to per-account storage`);
}

/**
 * Moves `tickIntervalMinutes` from per-account settings to installation-wide.
 *
 * There is one scheduler loop in the process, so a per-account cadence has no
 * single value it could take — and `startScheduler()` asking for one with no
 * account in scope crashed the server at boot. Handles databases already
 * upgraded by the first version of this migration, where the key is sitting in
 * `settings`.
 *
 * Takes the value from the oldest account, which on any real installation is
 * the operator's own, rather than inventing a number they never chose.
 */
function relocateSchedulerInterval() {
  const alreadySiteWide = db
    .prepare("SELECT 1 FROM site_settings WHERE key = 'tickIntervalMinutes'")
    .get();
  const perAccount = db
    .prepare(
      `SELECT s.value FROM settings s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.key = 'tickIntervalMinutes'
       ORDER BY a.created_at LIMIT 1`,
    )
    .get() as { value: string } | undefined;

  if (!alreadySiteWide && perAccount) {
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('tickIntervalMinutes', ?)").run(
      perAccount.value,
    );
    console.log(`[db] moved tickIntervalMinutes (${perAccount.value}) to installation settings`);
  }
  const removed = db.prepare("DELETE FROM settings WHERE key = 'tickIntervalMinutes'").run();
  if (removed.changes > 0) {
    console.log(`[db] removed ${removed.changes} per-account copy of tickIntervalMinutes`);
  }
}

/**
 * Runs predating the outcome counters would otherwise show zero results forever.
 * Both numbers are recoverable from tables that already carry run_id, so derive
 * them once rather than leaving the activity view looking empty.
 */
function backfillRunCounters() {
  const done = db.prepare("SELECT value FROM site_settings WHERE key = 'runCountersBackfilled2'").get() as
    | { value: string }
    | undefined;
  // The flag lived in `settings` before that table became per-account; the
  // rebuild moves it across, but on a database upgrading in one step it may
  // still be sitting in the old table.
  const legacyDone =
    !done && !hasColumn('settings', 'account_id')
      ? (db.prepare("SELECT value FROM settings WHERE key = 'runCountersBackfilled2'").get() as
          | { value: string }
          | undefined)
      : undefined;
  if (done || legacyDone) return;

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
  db.prepare("INSERT INTO site_settings (key, value) VALUES ('runCountersBackfilled2', ?)").run(
    new Date().toISOString(),
  );
  console.log('[db] backfilled run outcome counters from existing history');
}

// ---------------------------------------------------------------------------
// Per-account settings.
//
// These resolve against the account in the ambient context rather than taking
// an explicit argument, because they are read from deep inside the provider
// layer — five settings across nested helpers that have no account in hand.
// `currentAccountId()` throws when nothing set the context, so a missing scope
// fails loudly instead of quietly serving another tenant's configuration.
// ---------------------------------------------------------------------------

export function getSetting(key: SettingKey, accountId = currentAccountId()): string {
  const row = db.prepare('SELECT value FROM settings WHERE account_id = ? AND key = ?').get(
    accountId,
    key,
  ) as { value: string } | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key];
}

export function getNumberSetting(key: SettingKey, accountId = currentAccountId()): number {
  const n = Number(getSetting(key, accountId));
  return Number.isFinite(n) ? n : Number(DEFAULT_SETTINGS[key]);
}

export function setSetting(key: string, value: string, accountId = currentAccountId()) {
  db.prepare(
    `INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`,
  ).run(accountId, key, value);
}

export function allSettings(accountId = currentAccountId()): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE account_id = ?')
    .all(accountId) as { key: string; value: string }[];
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

// ---------------------------------------------------------------------------
// Installation-wide settings. No account context required.
// ---------------------------------------------------------------------------

export function getSiteSetting(key: SiteSettingKey): string {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULT_SITE_SETTINGS[key];
}

export function getSiteNumberSetting(key: SiteSettingKey): number {
  const n = Number(getSiteSetting(key));
  return Number.isFinite(n) ? n : Number(DEFAULT_SITE_SETTINGS[key]);
}

export function setSiteSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function allSiteSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM site_settings').all() as {
    key: string;
    value: string;
  }[];
  return { ...DEFAULT_SITE_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
