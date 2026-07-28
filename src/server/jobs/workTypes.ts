import { db } from '../db/index.js';
import type { WorkTypeRow } from '../lib/models.js';

/** URL/model-friendly stable key derived from the name. */
export function workTypeKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base || 'work-type';
}

/** Ensures the key is unique within the profile by suffixing if needed. */
export function uniqueWorkTypeKey(profileId: string, name: string, excludeId?: string): string {
  const base = workTypeKey(name);
  const taken = new Set(
    (
      db
        .prepare('SELECT id, key FROM work_types WHERE profile_id = ?')
        .all(profileId) as { id: string; key: string }[]
    )
      .filter((r) => r.id !== excludeId)
      .map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function activeWorkTypes(profileId: string): WorkTypeRow[] {
  return db
    .prepare(
      'SELECT * FROM work_types WHERE profile_id = ? AND active = 1 ORDER BY sort_order, created_at',
    )
    .all(profileId) as WorkTypeRow[];
}

export function allWorkTypes(profileId: string): WorkTypeRow[] {
  return db
    .prepare('SELECT * FROM work_types WHERE profile_id = ? ORDER BY sort_order, created_at')
    .all(profileId) as WorkTypeRow[];
}

/** Replaces a source's work-type tags. */
export function linkSourceWorkTypes(sourceId: string, workTypeIds: string[]) {
  const tx = db.transaction((ids: string[]) => {
    db.prepare('DELETE FROM source_work_types WHERE source_id = ?').run(sourceId);
    const ins = db.prepare(
      'INSERT INTO source_work_types (source_id, work_type_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
    );
    for (const id of ids) ins.run(sourceId, id);
  });
  tx(workTypeIds);
}

export function workTypesForSource(sourceId: string): WorkTypeRow[] {
  return db
    .prepare(
      `SELECT wt.* FROM work_types wt
       JOIN source_work_types swt ON swt.work_type_id = wt.id
       WHERE swt.source_id = ? ORDER BY wt.sort_order, wt.created_at`,
    )
    .all(sourceId) as WorkTypeRow[];
}

/**
 * Per-work-type coverage, used by the assessment to decide which specialization is
 * starved of sources and should get the next discovery pass.
 */
export interface WorkTypeCoverage {
  workType: WorkTypeRow;
  activeSources: number;
  projectsFound: number;
}

export function coverageByWorkType(profileId: string): WorkTypeCoverage[] {
  const types = activeWorkTypes(profileId);
  return types.map((workType) => {
    const activeSources = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM source_work_types swt
           JOIN sources s ON s.id = swt.source_id
           WHERE swt.work_type_id = ? AND s.status = 'active'`,
        )
        .get(workType.id) as { n: number }
    ).n;
    const projectsFound = (
      db
        .prepare("SELECT COUNT(*) AS n FROM projects WHERE work_type_id = ? AND status != 'rejected'")
        .get(workType.id) as { n: number }
    ).n;
    return { workType, activeSources, projectsFound };
  });
}

/** The active work type most in need of new sources, or null if all are adequately covered. */
export function leastCoveredWorkType(
  profileId: string,
  targetPerType: number,
): WorkTypeRow | null {
  const coverage = coverageByWorkType(profileId).filter((c) => c.activeSources < targetPerType);
  if (coverage.length === 0) return null;
  coverage.sort((a, b) => a.activeSources - b.activeSources);
  return coverage[0].workType;
}
