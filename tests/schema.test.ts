import { describe, expect, it } from 'vitest';
import { db, migrate, getSetting, getNumberSetting, setSetting, allSettings } from '../src/server/db/index.js';
import { DEFAULT_SETTINGS } from '../src/server/config.js';
import { reconcileOrphanedRuns } from '../src/server/jobs/runs.js';
import { newId, nowIso } from '../src/server/db/index.js';

migrate();

describe('migration', () => {
  it('is idempotent — running it again is a no-op', () => {
    expect(() => {
      migrate();
      migrate();
    }).not.toThrow();
  });

  it('creates every table the app queries', () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of [
      'settings',
      'profiles',
      'work_types',
      'sources',
      'source_work_types',
      'runs',
      'run_events',
      'source_scans',
      'projects',
      'project_sources',
      'artifacts',
      'project_facts',
      'project_updates',
      'usage_ledger',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('has the columns added by later migrations', () => {
    const cols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['current_step', 'sources_added', 'sources_scanned', 'projects_found', 'facts_added']) {
      expect(cols, `runs.${c}`).toContain(c);
    }
    const projectCols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(projectCols).toContain('work_type_id');
  });

  it('enforces foreign keys', () => {
    const [{ foreign_keys: on }] = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(on).toBe(1);
  });
});

describe('settings', () => {
  it('seeds every default', () => {
    const all = allSettings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(all[key], `missing setting ${key}`).toBeDefined();
    }
  });

  it('round-trips a value', () => {
    setSetting('perRunBudgetUsd', '7.5');
    expect(getSetting('perRunBudgetUsd')).toBe('7.5');
    expect(getNumberSetting('perRunBudgetUsd')).toBe(7.5);
  });

  it('falls back to the default when a number cannot be parsed', () => {
    setSetting('maxSourcesPerTick', 'not-a-number');
    expect(getNumberSetting('maxSourcesPerTick')).toBe(Number(DEFAULT_SETTINGS.maxSourcesPerTick));
  });
});

describe('orphaned runs', () => {
  it('marks runs left mid-flight by a restart, so nothing shows as active forever', () => {
    const id = newId();
    db.prepare(
      "INSERT INTO runs (id, kind, status, started_at) VALUES (?, 'scan', 'running', ?)",
    ).run(id, nowIso());

    reconcileOrphanedRuns();

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as {
      status: string;
      error: string;
      finished_at: string | null;
    };
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/interrupted/i);
    expect(run.finished_at).toBeTruthy();
  });

  it('leaves finished runs alone', () => {
    const id = newId();
    db.prepare(
      "INSERT INTO runs (id, kind, status, started_at, finished_at) VALUES (?, 'scan', 'ok', ?, ?)",
    ).run(id, nowIso(), nowIso());
    reconcileOrphanedRuns();
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: string };
    expect(run.status).toBe('ok');
  });
});
