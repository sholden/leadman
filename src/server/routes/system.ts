import { Router } from 'express';
import { z } from 'zod';
import { db, allSettings, setSetting, getNumberSetting } from '../db/index.js';
import { budgetStatus, monthKey } from '../ai/budget.js';
import { runTick, isTickRunning } from '../jobs/scheduler.js';
import { config } from '../config.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { credentialStatus } from '../ai/credentials.js';

export const systemRouter = Router();

/** Everything the dashboard needs in one call. */
systemRouter.get('/dashboard', (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  const scope = profileId ? 'AND p.profile_id = ?' : '';
  const params = profileId ? [profileId] : [];

  const newlyDiscovered = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM project_sources ps WHERE ps.project_id = p.id) AS source_count
       FROM projects p
       WHERE p.status = 'discovered' ${scope}
       ORDER BY p.relevance DESC, p.first_seen_at DESC LIMIT 40`,
    )
    .all(...params);

  const recentlyUpdated = db
    .prepare(
      `SELECT p.*, u.summary AS update_summary, u.kind AS update_kind, u.created_at AS update_at
       FROM projects p
       JOIN project_updates u ON u.id = (
         SELECT id FROM project_updates WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE p.status = 'tracked' ${scope}
       ORDER BY u.created_at DESC LIMIT 40`,
    )
    .all(...params);

  const activity = db
    .prepare(
      `SELECT u.*, p.name AS project_name, p.status AS project_status
       FROM project_updates u JOIN projects p ON p.id = u.project_id
       ${profileId ? 'WHERE p.profile_id = ?' : ''}
       ORDER BY u.created_at DESC LIMIT 60`,
    )
    .all(...params);

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='discovered' THEN 1 ELSE 0 END) AS discovered,
         SUM(CASE WHEN status='tracked' THEN 1 ELSE 0 END) AS tracked,
         SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
         COUNT(*) AS total
       FROM projects ${profileId ? 'WHERE profile_id = ?' : ''}`,
    )
    .get(...params);

  const sourceCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END) AS candidate,
         SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
         SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead,
         COUNT(*) AS total
       FROM sources ${profileId ? 'WHERE profile_id = ?' : ''}`,
    )
    .get(...params);

  const runs = db
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 15')
    .all();

  res.json({
    newlyDiscovered,
    recentlyUpdated,
    activity,
    counts,
    sourceCounts,
    runs,
    budget: budgetStatus(),
    schedulerRunning: isTickRunning(),
    schedulerEnabled: config.schedulerEnabled,
    apiKeyConfigured: Boolean(config.apiKey),
    credentials: credentialStatus(),
  });
});

systemRouter.get('/settings', (_req, res) => {
  res.json({ settings: allSettings(), defaults: DEFAULT_SETTINGS });
});

systemRouter.put('/settings', (req, res) => {
  const parsed = z.record(z.string(), z.union([z.string(), z.number()])).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    setSetting(key, String(value));
  }
  res.json({ settings: allSettings() });
});

systemRouter.get('/runs', (_req, res) => {
  res.json(db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100').all());
});

systemRouter.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const usage = db
    .prepare('SELECT * FROM usage_ledger WHERE run_id = ? ORDER BY created_at')
    .all(req.params.id);
  res.json({ run, usage });
});

systemRouter.get('/budget', (_req, res) => {
  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, ROUND(SUM(cost_usd), 4) AS cost, COUNT(*) AS calls
       FROM usage_ledger WHERE month_key = ? GROUP BY day ORDER BY day`,
    )
    .all(monthKey());
  const byPurpose = db
    .prepare(
      `SELECT purpose, ROUND(SUM(cost_usd), 4) AS cost, COUNT(*) AS calls
       FROM usage_ledger WHERE month_key = ? GROUP BY purpose ORDER BY cost DESC`,
    )
    .all(monthKey());
  res.json({ ...budgetStatus(), daily, byPurpose });
});

/** Run a full scheduler pass right now. */
systemRouter.post('/tick', async (_req, res) => {
  if (isTickRunning()) return res.status(409).json({ error: 'A pass is already running.' });
  const outcome = await runTick('manual');
  res.json(outcome);
});

systemRouter.post('/updates/seen', (req, res) => {
  const ids = z.array(z.string()).safeParse(req.body?.ids);
  if (!ids.success) return res.status(400).json({ error: 'ids must be a string array' });
  const stmt = db.prepare('UPDATE project_updates SET seen = 1 WHERE id = ?');
  const tx = db.transaction((list: string[]) => list.forEach((id) => stmt.run(id)));
  tx(ids.data);
  res.status(204).end();
});
