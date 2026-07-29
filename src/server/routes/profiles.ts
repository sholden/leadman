import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db/index.js';
import type { ProfileRow } from '../lib/models.js';
import { withRun } from '../jobs/runs.js';
import { discoverSources } from '../jobs/discoverSources.js';
import { assessCoverage } from '../jobs/assessCoverage.js';

export const profilesRouter = Router();

const profileInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(10).max(20_000),
  center_label: z.string().min(1).max(300),
  center_lat: z.number().min(-90).max(90),
  center_lng: z.number().min(-180).max(180),
  radius_miles: z.number().min(1).max(500),
  active: z.boolean().optional(),
});

profilesRouter.get('/', (req, res) => {
  const accountId = req.auth!.accountId;
  const rows = db
    .prepare('SELECT * FROM profiles WHERE account_id = ? ORDER BY created_at')
    .all(accountId) as ProfileRow[];
  const counts = db
    .prepare(
      `SELECT profile_id,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_sources,
              COUNT(*) AS total_sources
       FROM sources WHERE account_id = ? GROUP BY profile_id`,
    )
    .all(accountId) as { profile_id: string; active_sources: number; total_sources: number }[];
  const projects = db
    .prepare(
      `SELECT profile_id,
              SUM(CASE WHEN status='discovered' THEN 1 ELSE 0 END) AS discovered,
              SUM(CASE WHEN status='tracked' THEN 1 ELSE 0 END) AS tracked
       FROM projects WHERE account_id = ? GROUP BY profile_id`,
    )
    .all(accountId) as { profile_id: string; discovered: number; tracked: number }[];

  res.json(
    rows.map((p) => ({
      ...p,
      keywords: JSON.parse(p.keywords),
      jurisdictions: JSON.parse(p.jurisdictions),
      active: !!p.active,
      stats: {
        activeSources: counts.find((c) => c.profile_id === p.id)?.active_sources ?? 0,
        totalSources: counts.find((c) => c.profile_id === p.id)?.total_sources ?? 0,
        discovered: projects.find((c) => c.profile_id === p.id)?.discovered ?? 0,
        tracked: projects.find((c) => c.profile_id === p.id)?.tracked ?? 0,
      },
    })),
  );
});

profilesRouter.post('/', (req, res) => {
  const parsed = profileInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const p = parsed.data;
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO profiles
       (id, account_id, name, description, center_label, center_lat, center_lng, radius_miles, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    req.auth!.accountId,
    p.name,
    p.description,
    p.center_label,
    p.center_lat,
    p.center_lng,
    p.radius_miles,
    p.active === false ? 0 : 1,
    now,
    now,
  );
  res.status(201).json(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
});

profilesRouter.patch('/:id', (req, res) => {
  const parsed = profileInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = findProfile(req.params.id, req.auth!.accountId);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const p = { ...parsed.data };
  db.prepare(
    `UPDATE profiles SET name = ?, description = ?, center_label = ?, center_lat = ?,
       center_lng = ?, radius_miles = ?, active = ?, updated_at = ? WHERE id = ?`,
  ).run(
    p.name ?? existing.name,
    p.description ?? existing.description,
    p.center_label ?? existing.center_label,
    p.center_lat ?? existing.center_lat,
    p.center_lng ?? existing.center_lng,
    p.radius_miles ?? existing.radius_miles,
    p.active === undefined ? existing.active : p.active ? 1 : 0,
    nowIso(),
    req.params.id,
  );
  res.json(db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id));
});

profilesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM profiles WHERE id = ? AND account_id = ?').run(
    req.params.id,
    req.auth!.accountId,
  );
  res.status(204).end();
});

/** Manually kick off source discovery for one profile. */
profilesRouter.post('/:id/discover', async (req, res) => {
  const profile = findProfile(req.params.id, req.auth!.accountId);
  if (!profile) return res.status(404).json({ error: 'not found' });

  const outcome = await withRun(
    { kind: 'discovery', profileId: profile.id, trigger: 'manual', label: profile.name },
    (ctx) => discoverSources(ctx, profile, { limit: 14 }),
  );
  res.json(outcome);
});

/** Manually kick off a coverage assessment (which may trigger discovery). */
profilesRouter.post('/:id/assess', async (req, res) => {
  const profile = findProfile(req.params.id, req.auth!.accountId);
  if (!profile) return res.status(404).json({ error: 'not found' });

  const outcome = await withRun(
    { kind: 'assessment', profileId: profile.id, trigger: 'manual', label: profile.name },
    (ctx) => assessCoverage(ctx, profile),
  );
  res.json(outcome);
});

/**
 * Always looks a profile up with its account, so an id belonging to another
 * tenant reads as "not found" rather than being fetched and then checked.
 */
function findProfile(id: string, accountId: string): ProfileRow | undefined {
  return db.prepare('SELECT * FROM profiles WHERE id = ? AND account_id = ?').get(id, accountId) as
    | ProfileRow
    | undefined;
}
