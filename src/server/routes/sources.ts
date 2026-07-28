import { Router } from 'express';
import { z } from 'zod';
import { db, newId, nowIso } from '../db/index.js';
import { normalizeUrl } from '../lib/text.js';
import type { ProfileRow, SourceRow } from '../lib/models.js';
import { withRun } from '../jobs/runs.js';
import { scanSource } from '../jobs/scanSource.js';
import { SOURCE_KINDS } from '../ai/schemas.js';
import { workTypesForSource, linkSourceWorkTypes } from '../jobs/workTypes.js';

export const sourcesRouter = Router();

sourcesRouter.get('/', (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  const status = String(req.query.status ?? '');
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (profileId) {
    clauses.push('profile_id = ?');
    params.push(profileId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM sources ${where} ORDER BY status, score DESC, name`)
    .all(...params) as SourceRow[];
  res.json(rows.map((s) => ({ ...s, workTypes: workTypesForSource(s.id).map((t) => ({ id: t.id, key: t.key, name: t.name })) })));
});

sourcesRouter.get('/:id', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'not found' });
  const scans = db
    .prepare('SELECT * FROM source_scans WHERE source_id = ? ORDER BY started_at DESC LIMIT 25')
    .all(req.params.id);
  res.json({ source, scans });
});

const sourceInput = z.object({
  profile_id: z.string().min(1),
  name: z.string().min(1).max(200),
  url: z.string().url(),
  kind: z.enum(SOURCE_KINDS).optional(),
  jurisdiction: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
});

sourcesRouter.post('/', (req, res) => {
  const parsed = sourceInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const s = parsed.data;
  const id = newId();
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO sources
         (id, profile_id, name, url, kind, jurisdiction, description, discovery_reason,
          status, origin, score, next_scan_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'added by user', 'active', 'manual', 70, ?, ?, ?)`,
    ).run(
      id,
      s.profile_id,
      s.name,
      normalizeUrl(s.url),
      s.kind ?? 'other',
      s.jurisdiction ?? '',
      s.description ?? '',
      now,
      now,
      now,
    );
  } catch (err) {
    return res.status(409).json({ error: 'A source with that URL already exists on this profile.' });
  }
  res.status(201).json(db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
});

const patchInput = z.object({
  status: z.enum(['candidate', 'active', 'paused', 'dead']).optional(),
  name: z.string().min(1).max(200).optional(),
  kind: z.enum(SOURCE_KINDS).optional(),
  jurisdiction: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  scan_interval_hours: z.number().min(1).max(2000).optional(),
  work_type_ids: z.array(z.string()).max(20).optional(),
});

sourcesRouter.patch('/:id', (req, res) => {
  const parsed = patchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined;
  if (!existing) return res.status(404).json({ error: 'not found' });
  const p = parsed.data;

  // Promoting a paused/candidate source should make it eligible immediately.
  const nextScan =
    p.status === 'active' && existing.status !== 'active' ? nowIso() : existing.next_scan_at;

  db.prepare(
    `UPDATE sources SET status = ?, name = ?, kind = ?, jurisdiction = ?, description = ?,
       scan_interval_hours = ?, next_scan_at = ?, consecutive_empty_scans = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    p.status ?? existing.status,
    p.name ?? existing.name,
    p.kind ?? existing.kind,
    p.jurisdiction ?? existing.jurisdiction,
    p.description ?? existing.description,
    p.scan_interval_hours ?? existing.scan_interval_hours,
    nextScan,
    p.status === 'active' && existing.status !== 'active' ? 0 : existing.consecutive_empty_scans,
    nowIso(),
    req.params.id,
  );
  if (p.work_type_ids) linkSourceWorkTypes(req.params.id, p.work_type_ids);
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id));
});

sourcesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/** Scan one source right now. */
sourcesRouter.post('/:id/scan', async (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined;
  if (!source) return res.status(404).json({ error: 'not found' });
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(source.profile_id) as
    | ProfileRow
    | undefined;
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const outcome = await withRun(
    { kind: 'scan', profileId: profile.id, trigger: 'manual', label: source.name },
    (ctx) => scanSource(ctx, profile, source),
  );
  res.json(outcome);
});
