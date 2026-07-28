import { db, newId, nowIso } from '../src/server/db/index.js';
import type { RunContext } from '../src/server/jobs/runs.js';
import type { ProfileRow, SourceRow, WorkTypeRow } from '../src/server/lib/models.js';

/**
 * A run context that records what a job logged but spends nothing.
 *
 * `canSpend: false` also makes the optional AI duplicate-matching step skip
 * itself, so ingest tests exercise the deterministic key-dedupe fallback.
 */
export function fakeCtx(opts: { canSpend?: boolean } = {}): RunContext & { events: string[] } {
  const events: string[] = [];
  return {
    runId: null as unknown as string,
    budget: {
      canSpend: () => opts.canSpend ?? false,
      assertCanSpend: () => {},
      record: () => 0,
      remainingTokenAllowance: () => 20_000,
      spentUsd: 0,
    } as never,
    lines: events,
    events,
    log: (m: string) => events.push(m),
    result: (m: string) => events.push(`result:${m}`),
    step: (m: string) => events.push(`step:${m}`),
    count: () => {},
  };
}

export function makeProfile(over: Partial<ProfileRow> = {}): ProfileRow {
  const id = over.id ?? newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO profiles (id, name, description, center_label, center_lat, center_lng, radius_miles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    over.name ?? 'test profile',
    over.description ?? 'a test firm',
    over.center_label ?? 'Baton Rouge',
    over.center_lat ?? 30.45,
    over.center_lng ?? -91.19,
    over.radius_miles ?? 60,
    now,
    now,
  );
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow;
}

export function makeSource(profileId: string, over: Partial<SourceRow> = {}): SourceRow {
  const id = over.id ?? newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO sources (id, profile_id, name, url, kind, jurisdiction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    profileId,
    over.name ?? 'Test Agendas',
    over.url ?? `https://example.invalid/${id}`,
    over.kind ?? 'meeting_minutes',
    over.jurisdiction ?? 'Test Parish',
    over.status ?? 'active',
    now,
    now,
  );
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow;
}

export function makeWorkType(profileId: string, key: string, name = key): WorkTypeRow {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO work_types (id, profile_id, key, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?)`,
  ).run(id, profileId, key, name, now, now);
  return db.prepare('SELECT * FROM work_types WHERE id = ?').get(id) as WorkTypeRow;
}

/** A scan candidate with sensible defaults, overridable per test. */
export function candidate(over: Record<string, unknown> = {}) {
  return {
    name: 'Central Fire Station Replacement',
    summary: 'Replacement of the central fire station.',
    project_type: 'fire station',
    stage: 'planning',
    address: '',
    jurisdiction: 'Test Parish',
    owner_org: 'Test Parish Government',
    estimated_value: '',
    timeline_note: '',
    evidence_url: 'https://example.invalid/agenda/1',
    evidence_quote: 'Council authorized design funding.',
    work_type_key: '',
    relevance: 80,
    confidence: 80,
    ...over,
  } as never;
}

export function resetData() {
  // profiles cascade to sources, projects, work types and their children.
  db.exec('DELETE FROM profiles; DELETE FROM runs; DELETE FROM usage_ledger; DELETE FROM artifacts;');
}
