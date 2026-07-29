import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/**
 * Upgrading a database that predates accounts.
 *
 * This is the path the deployed installation takes exactly once, against real
 * data, with no way to retry cleanly — so it starts from the *actual* previous
 * schema (`fixtures/schema-pre-tenancy.sql`, captured verbatim from the last
 * commit before accounts existed) rather than a hand-written approximation that
 * could quietly differ from what is really on disk out there.
 *
 * The old schema is written to the test database before any application module
 * is imported, because `db/index.ts` opens its connection at import time.
 */
const PRE_TENANCY_SCHEMA = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'schema-pre-tenancy.sql',
  ),
  'utf8',
);

const dbPath = process.env.LEADMAN_DB!;

{
  const legacy = new Database(dbPath);
  legacy.exec(PRE_TENANCY_SCHEMA);

  const now = '2026-01-01T00:00:00.000Z';
  legacy
    .prepare(
      `INSERT INTO profiles (id, name, description, center_label, center_lat, center_lng, radius_miles, created_at, updated_at)
       VALUES ('p1', 'Capital Region', 'desc', 'Baton Rouge', 30.45, -91.19, 60, ?, ?)`,
    )
    .run(now, now);
  legacy
    .prepare(
      `INSERT INTO work_types (id, profile_id, key, name, created_at, updated_at)
       VALUES ('w1', 'p1', 'roofing', 'Roofing', ?, ?)`,
    )
    .run(now, now);
  legacy
    .prepare(
      `INSERT INTO sources (id, profile_id, name, url, created_at, updated_at)
       VALUES ('s1', 'p1', 'Agendas', 'https://example.invalid/a', ?, ?)`,
    )
    .run(now, now);
  legacy
    .prepare(
      `INSERT INTO projects (id, profile_id, name, first_seen_at, last_updated_at)
       VALUES ('pr1', 'p1', 'New Library', ?, ?)`,
    )
    .run(now, now);
  legacy
    .prepare("INSERT INTO runs (id, kind, trigger, status, started_at) VALUES ('r1', 'scan', 'manual', 'ok', ?)")
    .run(now);
  legacy
    .prepare(
      `INSERT INTO artifacts (id, project_id, url, fetched_at) VALUES ('a1', 'pr1', 'https://example.invalid/d', ?)`,
    )
    .run(now);
  legacy
    .prepare(
      `INSERT INTO usage_ledger (id, model, cost_usd, created_at, month_key)
       VALUES ('u1', 'claude-opus-5', 1.25, ?, '2026-01')`,
    )
    .run(now);

  // The operator's own configuration, which must survive the upgrade.
  legacy
    .prepare("INSERT INTO settings (key, value) VALUES ('model', 'gpt-5.6-luna'), ('monthlyBudgetUsd', '75'), ('runCountersBackfilled2', ?)")
    .run(now);
  legacy.close();
}

const { db, migrate, getSetting, getSiteSetting } = await import('../src/server/db/index.js');

migrate();

const accountId = (db.prepare('SELECT id FROM accounts').get() as { id: string }).id;

describe('upgrading a pre-tenancy database', () => {
  it('creates exactly one account to adopt the existing data', () => {
    expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(1);
  });

  it('leaves no row without an account', () => {
    for (const table of [
      'profiles',
      'work_types',
      'sources',
      'projects',
      'runs',
      'artifacts',
      'usage_ledger',
    ]) {
      const orphans = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id IS NULL`)
        .get() as { n: number };
      expect(orphans.n, `${table} has unadopted rows`).toBe(0);
    }
  });

  it('adopts every row into that account, losing nothing', () => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM profiles WHERE account_id = ?) AS profiles,
                (SELECT COUNT(*) FROM sources  WHERE account_id = ?) AS sources,
                (SELECT COUNT(*) FROM projects WHERE account_id = ?) AS projects,
                (SELECT COUNT(*) FROM runs     WHERE account_id = ?) AS runs`,
      )
      .get(accountId, accountId, accountId, accountId);
    expect(counts).toEqual({ profiles: 1, sources: 1, projects: 1, runs: 1 });
  });

  it("carries the operator's configuration onto that account", () => {
    // A silent revert to defaults here would quietly change which model the
    // installation pays for.
    expect(getSetting('model', accountId)).toBe('gpt-5.6-luna');
    expect(getSetting('monthlyBudgetUsd', accountId)).toBe('75');
  });

  it('keeps migration bookkeeping installation-wide, not per-account', () => {
    // Duplicating these into every future tenant would re-run old backfills.
    expect(getSiteSetting('runCountersBackfilled2' as never)).toBeTruthy();
    const leaked = db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'runCountersBackfilled2'")
      .get() as { n: number };
    expect(leaked.n).toBe(0);
  });

  it('gives the account the full set of defaults for keys it never had', () => {
    expect(getSetting('perRunBudgetUsd', accountId)).toBeTruthy();
    expect(getSetting('minRelevance', accountId)).toBeTruthy();
  });

  it('is idempotent — a second and third pass change nothing', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    expect(() => {
      migrate();
      migrate();
    }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(
      before.n,
    );
    expect(getSetting('model', accountId)).toBe('gpt-5.6-luna');
  });
});
