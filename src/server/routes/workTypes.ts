import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db/index.js';
import type { ProfileRow, WorkTypeRow } from '../lib/models.js';
import { allWorkTypes, coverageByWorkType, uniqueWorkTypeKey } from '../jobs/workTypes.js';
import { withRun } from '../jobs/runs.js';
import { planWorkType } from '../jobs/planWorkType.js';
import { discoverSources } from '../jobs/discoverSources.js';

export const workTypesRouter = Router();

const hydrate = (t: WorkTypeRow) => ({
  ...t,
  active: !!t.active,
  keywords: JSON.parse(t.keywords) as string[],
  lead_signals: JSON.parse(t.lead_signals) as string[],
});

workTypesRouter.get('/', (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  if (!profileId) return res.status(400).json({ error: 'profileId is required' });
  if (!ownsProfile(profileId, req.auth!.accountId)) {
    return res.status(404).json({ error: 'profile not found' });
  }

  const coverage = coverageByWorkType(profileId);
  const rows = allWorkTypes(profileId);
  res.json(
    rows.map((t) => {
      const c = coverage.find((x) => x.workType.id === t.id);
      return {
        ...hydrate(t),
        stats: { activeSources: c?.activeSources ?? 0, projects: c?.projectsFound ?? 0 },
      };
    }),
  );
});

const createInput = z.object({
  profile_id: z.string().min(1),
  name: z.string().min(2).max(200),
  description: z.string().max(8000).optional(),
  active: z.boolean().optional(),
});

workTypesRouter.post('/', (req, res) => {
  const parsed = createInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const t = parsed.data;

  if (!ownsProfile(t.profile_id, req.auth!.accountId)) {
    return res.status(404).json({ error: 'profile not found' });
  }

  const order = (
    db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM work_types WHERE profile_id = ?')
      .get(t.profile_id) as { n: number }
  ).n;

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO work_types (id, account_id, profile_id, key, name, description, active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    req.auth!.accountId,
    t.profile_id,
    uniqueWorkTypeKey(t.profile_id, t.name),
    t.name,
    t.description ?? '',
    t.active === false ? 0 : 1,
    order,
    now,
    now,
  );
  res.status(201).json(hydrate(db.prepare('SELECT * FROM work_types WHERE id = ?').get(id) as WorkTypeRow));
});

const patchInput = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(8000).optional(),
  active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
});

workTypesRouter.patch('/:id', (req, res) => {
  const parsed = patchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = findWorkType(req.params.id, req.auth!.accountId);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const p = parsed.data;

  // Renaming changes the key the model references, so keep it unique.
  const key =
    p.name && p.name !== existing.name
      ? uniqueWorkTypeKey(existing.profile_id, p.name, existing.id)
      : existing.key;

  // A changed description invalidates the derived hunting strategy.
  const descriptionChanged = p.description !== undefined && p.description !== existing.description;

  db.prepare(
    `UPDATE work_types SET name = ?, key = ?, description = ?, active = ?, sort_order = ?,
       planned_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    p.name ?? existing.name,
    key,
    p.description ?? existing.description,
    p.active === undefined ? existing.active : p.active ? 1 : 0,
    p.sort_order ?? existing.sort_order,
    descriptionChanged ? null : existing.planned_at,
    nowIso(),
    req.params.id,
  );
  res.json(hydrate(db.prepare('SELECT * FROM work_types WHERE id = ?').get(req.params.id) as WorkTypeRow));
});

workTypesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM work_types WHERE id = ? AND account_id = ?').run(
    req.params.id,
    req.auth!.accountId,
  );
  res.status(204).end();
});

/** Work out where this kind of work surfaces. Cheap — no web tools. */
workTypesRouter.post('/:id/plan', async (req, res) => {
  const workType = findWorkType(req.params.id, req.auth!.accountId);
  if (!workType) return res.status(404).json({ error: 'not found' });
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(workType.profile_id) as
    | ProfileRow
    | undefined;
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const outcome = await withRun(
    { kind: 'plan', profileId: profile.id, trigger: 'manual', label: workType.name },
    (ctx) => planWorkType(ctx, profile, workType),
  );
  res.json({
    ...outcome,
    workType: hydrate(db.prepare('SELECT * FROM work_types WHERE id = ?').get(workType.id) as WorkTypeRow),
  });
});

/** Hunt for sources serving this work type specifically. */
workTypesRouter.post('/:id/discover', async (req, res) => {
  const workType = findWorkType(req.params.id, req.auth!.accountId);
  if (!workType) return res.status(404).json({ error: 'not found' });
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(workType.profile_id) as
    | ProfileRow
    | undefined;
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const outcome = await withRun(
    {
      kind: 'discovery',
      profileId: profile.id,
      trigger: 'manual',
      label: `${profile.name} — ${workType.name}`,
    },
    async (ctx) => {
      // Plan first if we never have; discovery is much better aimed with it.
      let planned = workType;
      if (!workType.planned_at) {
        await planWorkType(ctx, profile, workType);
        planned = db.prepare('SELECT * FROM work_types WHERE id = ?').get(workType.id) as WorkTypeRow;
      }
      return discoverSources(ctx, profile, { workType: planned, limit: 10 });
    },
  );
  res.json(outcome);
});

const ownsProfile = (profileId: string, accountId: string) =>
  Boolean(
    db.prepare('SELECT 1 FROM profiles WHERE id = ? AND account_id = ?').get(profileId, accountId),
  );

/** Scoped lookup, so another tenant's id is indistinguishable from a missing one. */
function findWorkType(id: string, accountId: string): WorkTypeRow | undefined {
  return db
    .prepare('SELECT * FROM work_types WHERE id = ? AND account_id = ?')
    .get(id, accountId) as WorkTypeRow | undefined;
}
