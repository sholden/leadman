import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db/index.js';
import type { ProfileRow, ProjectRow } from '../lib/models.js';
import { withRun } from '../jobs/runs.js';
import { researchProject } from '../jobs/researchProject.js';

export const projectsRouter = Router();

projectsRouter.get('/', (req, res) => {
  const { profileId, status, q, workTypeId } = req.query as Record<string, string | undefined>;
  const clauses: string[] = ['p.account_id = ?'];
  const params: unknown[] = [req.auth!.accountId];
  if (profileId) {
    clauses.push('p.profile_id = ?');
    params.push(profileId);
  }
  if (status) {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (workTypeId) {
    if (workTypeId === 'none') {
      clauses.push('p.work_type_id IS NULL');
    } else {
      clauses.push('p.work_type_id = ?');
      params.push(workTypeId);
    }
  }
  if (q) {
    clauses.push('(p.name LIKE ? OR p.summary LIKE ? OR p.jurisdiction LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = db
    .prepare(
      `SELECT p.*,
              wt.name AS work_type_name, wt.key AS work_type_key,
              (SELECT COUNT(*) FROM project_sources ps WHERE ps.project_id = p.id) AS source_count,
              (SELECT COUNT(*) FROM project_facts f WHERE f.project_id = p.id AND f.superseded = 0) AS fact_count,
              (SELECT MAX(created_at) FROM project_updates u WHERE u.project_id = p.id) AS last_update_at
       FROM projects p
       LEFT JOIN work_types wt ON wt.id = p.work_type_id ${where}
       ORDER BY CASE p.status WHEN 'tracked' THEN 0 WHEN 'discovered' THEN 1 ELSE 2 END,
                p.relevance DESC, p.first_seen_at DESC`,
    )
    .all(...params);
  res.json(rows);
});

projectsRouter.get('/:id', (req, res) => {
  const project = db
    .prepare(
      `SELECT p.*, wt.name AS work_type_name, wt.key AS work_type_key
       FROM projects p LEFT JOIN work_types wt ON wt.id = p.work_type_id
       WHERE p.id = ? AND p.account_id = ?`,
    )
    .get(req.params.id, req.auth!.accountId) as ProjectRow | undefined;
  if (!project) return res.status(404).json({ error: 'not found' });

  const workTypes = db
    .prepare('SELECT id, key, name FROM work_types WHERE profile_id = ? AND active = 1 ORDER BY sort_order')
    .all(project.profile_id);

  const sources = db
    .prepare(
      `SELECT ps.*, s.name AS source_name, s.kind AS source_kind,
              (SELECT a.id FROM artifacts a WHERE a.project_source_id = ps.id ORDER BY a.fetched_at DESC LIMIT 1) AS artifact_id
       FROM project_sources ps
       LEFT JOIN sources s ON s.id = ps.source_id
       WHERE ps.project_id = ? ORDER BY ps.found_at DESC`,
    )
    .all(req.params.id);

  const facts = db
    .prepare(
      `SELECT * FROM project_facts WHERE project_id = ? AND superseded = 0
       ORDER BY CASE category
         WHEN 'timeline' THEN 0 WHEN 'budget' THEN 1 WHEN 'company' THEN 2
         WHEN 'contact' THEN 3 WHEN 'milestone' THEN 4 ELSE 5 END, found_at DESC`,
    )
    .all(req.params.id);

  const history = db
    .prepare(
      `SELECT * FROM project_facts WHERE project_id = ? AND superseded = 1 ORDER BY found_at DESC LIMIT 50`,
    )
    .all(req.params.id);

  const updates = db
    .prepare('SELECT * FROM project_updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.params.id);

  const artifacts = db
    .prepare(
      `SELECT id, url, title, byte_size, fetched_at, LENGTH(content_text) AS text_length
       FROM artifacts WHERE project_id = ? ORDER BY fetched_at DESC`,
    )
    .all(req.params.id);

  res.json({ project, sources, facts, history, updates, artifacts, workTypes });
});

const patchInput = z.object({
  status: z.enum(['discovered', 'tracked', 'archived', 'rejected']).optional(),
  notes: z.string().max(20_000).optional(),
  name: z.string().min(1).max(300).optional(),
  relevance: z.number().int().min(0).max(100).optional(),
  /** null clears the classification; the model gets it wrong sometimes. */
  work_type_id: z.string().nullable().optional(),
});

projectsRouter.patch('/:id', (req, res) => {
  const parsed = patchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = findProject(req.params.id, req.auth!.accountId);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const p = parsed.data;
  const now = nowIso();

  // A work type from another account (or another profile) must not be attachable.
  if (p.work_type_id) {
    const owned = db
      .prepare('SELECT 1 FROM work_types WHERE id = ? AND account_id = ? AND profile_id = ?')
      .get(p.work_type_id, req.auth!.accountId, existing.profile_id);
    if (!owned) return res.status(400).json({ error: 'No such work type on this profile.' });
  }

  const becomingTracked = p.status === 'tracked' && existing.status !== 'tracked';

  db.prepare(
    `UPDATE projects SET status = ?, notes = ?, name = ?, relevance = ?, work_type_id = ?,
       tracked_at = ?, next_research_at = ?, last_updated_at = ? WHERE id = ?`,
  ).run(
    p.status ?? existing.status,
    p.notes ?? existing.notes,
    p.name ?? existing.name,
    p.relevance ?? existing.relevance,
    p.work_type_id === undefined ? existing.work_type_id : p.work_type_id,
    becomingTracked ? now : existing.tracked_at,
    // Tracking a project makes it eligible for research on the next tick.
    becomingTracked ? now : existing.next_research_at,
    now,
    req.params.id,
  );

  if (p.status && p.status !== existing.status) {
    db.prepare(
      `INSERT INTO project_updates (id, project_id, kind, summary, created_at)
       VALUES (?, ?, 'status_change', ?, ?)`,
    ).run(newId(), req.params.id, `Status changed from ${existing.status} to ${p.status}`, now);
  }

  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

projectsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ? AND account_id = ?').run(
    req.params.id,
    req.auth!.accountId,
  );
  res.status(204).end();
});

/** Research one project right now. */
projectsRouter.post('/:id/research', async (req, res) => {
  const project = findProject(req.params.id, req.auth!.accountId);
  if (!project) return res.status(404).json({ error: 'not found' });
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(project.profile_id) as
    | ProfileRow
    | undefined;
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const outcome = await withRun(
    { kind: 'research', profileId: profile.id, trigger: 'manual', label: project.name },
    (ctx) => researchProject(ctx, profile, project),
  );
  res.json(outcome);
});

/**
 * Full archived text of one stored document. Artifacts are addressed directly
 * by id with no parent in the URL, which is exactly why they carry their own
 * account_id rather than being scoped through a join.
 */
projectsRouter.get('/artifacts/:artifactId', (req, res) => {
  const artifact = db
    .prepare('SELECT * FROM artifacts WHERE id = ? AND account_id = ?')
    .get(req.params.artifactId, req.auth!.accountId);
  if (!artifact) return res.status(404).json({ error: 'not found' });
  res.json(artifact);
});

/** Scoped lookup, so another tenant's id is indistinguishable from a missing one. */
function findProject(id: string, accountId: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND account_id = ?').get(id, accountId) as
    | ProjectRow
    | undefined;
}
