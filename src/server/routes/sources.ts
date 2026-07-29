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
  const clauses: string[] = ['account_id = ?'];
  const params: unknown[] = [req.auth!.accountId];
  if (profileId) {
    clauses.push('profile_id = ?');
    params.push(profileId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM sources ${where} ORDER BY status, score DESC, name`)
    .all(...params) as SourceRow[];
  res.json(rows.map((s) => ({ ...s, workTypes: workTypesForSource(s.id).map((t) => ({ id: t.id, key: t.key, name: t.name })) })));
});

sourcesRouter.get('/:id', (req, res) => {
  const source = findSource(req.params.id, req.auth!.accountId);
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
  const accountId = req.auth!.accountId;
  // The profile is named in the body, so it has to be proven to belong to this
  // account — otherwise a source could be attached to another tenant's profile.
  const owns = db
    .prepare('SELECT 1 FROM profiles WHERE id = ? AND account_id = ?')
    .get(s.profile_id, accountId);
  if (!owns) return res.status(404).json({ error: 'No such profile.' });

  const id = newId();
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO sources
         (id, account_id, profile_id, name, url, kind, jurisdiction, description, discovery_reason,
          status, origin, score, next_scan_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'added by user', 'active', 'manual', 70, ?, ?, ?)`,
    ).run(
      id,
      accountId,
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
  const existing = findSource(req.params.id, req.auth!.accountId);
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
  if (p.work_type_ids) {
    // Only work types from this account may be linked.
    const owned = db
      .prepare(
        `SELECT id FROM work_types WHERE account_id = ? AND id IN (${p.work_type_ids.map(() => '?').join(',') || "''"})`,
      )
      .all(req.auth!.accountId, ...p.work_type_ids) as { id: string }[];
    linkSourceWorkTypes(req.params.id, owned.map((w) => w.id));
  }
  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id));
});

sourcesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ? AND account_id = ?').run(
    req.params.id,
    req.auth!.accountId,
  );
  res.status(204).end();
});

/** Scan one source right now. */
sourcesRouter.post('/:id/scan', async (req, res) => {
  const source = findSource(req.params.id, req.auth!.accountId);
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

/** Scoped lookup, so another tenant's id is indistinguishable from a missing one. */
function findSource(id: string, accountId: string): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ? AND account_id = ?').get(id, accountId) as
    | SourceRow
    | undefined;
}
