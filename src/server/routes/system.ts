import { Router } from 'express';
import { z } from 'zod';
import { db, allSettings, setSetting, getNumberSetting } from '../db/index.js';
import { monthKey, visibleBudgetStatus } from '../ai/budget.js';
import { runTick, isTickRunning } from '../jobs/scheduler.js';
import { config } from '../config.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { credentialStatus } from '../ai/credentials.js';
import { allProviders } from '../ai/client.js';
import { isPriced, priceFor } from '../config.js';

export const systemRouter = Router();

/** Everything the dashboard needs in one call. */
systemRouter.get('/dashboard', (req, res) => {
  const accountId = req.auth!.accountId;
  const profileId = String(req.query.profileId ?? '');
  // Every query below is account-scoped first; the profile filter narrows
  // within that, it never widens.
  const scope = profileId ? 'AND p.profile_id = ?' : '';
  const params: string[] = profileId ? [accountId, profileId] : [accountId];

  const newlyDiscovered = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM project_sources ps WHERE ps.project_id = p.id) AS source_count
       FROM projects p
       WHERE p.account_id = ? AND p.status = 'discovered' ${scope}
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
       WHERE p.account_id = ? AND p.status = 'tracked' ${scope}
       ORDER BY u.created_at DESC LIMIT 40`,
    )
    .all(...params);

  const activity = db
    .prepare(
      `SELECT u.*, p.name AS project_name, p.status AS project_status
       FROM project_updates u JOIN projects p ON p.id = u.project_id
       WHERE p.account_id = ? ${profileId ? 'AND p.profile_id = ?' : ''}
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
       FROM projects WHERE account_id = ? ${profileId ? 'AND profile_id = ?' : ''}`,
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
       FROM sources WHERE account_id = ? ${profileId ? 'AND profile_id = ?' : ''}`,
    )
    .get(...params);

  const runs = db
    .prepare('SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 15')
    .all(accountId);

  res.json({
    newlyDiscovered,
    recentlyUpdated,
    activity,
    counts,
    sourceCounts,
    runs,
    budget: visibleBudgetStatus(accountId, Boolean(req.auth!.user.is_site_admin)),
    schedulerRunning: isTickRunning(),
    schedulerEnabled: config.schedulerEnabled,
    apiKeyConfigured: Boolean(config.apiKey),
    credentials: credentialStatus(accountId),
  });
});

/**
 * Models this installation can actually use, queried from each account rather
 * than hardcoded — a stale list is how you end up offering a model that 404s or
 * hiding one the account already has.
 */
systemRouter.get('/models', async (_req, res) => {
  const out: Record<string, unknown>[] = [];
  for (const provider of allProviders()) {
    if (!provider.hasApiKey()) {
      out.push({ provider: provider.id, configured: false, models: [], error: '' });
      continue;
    }
    try {
      const models = await provider.availableModels();
      out.push({
        provider: provider.id,
        configured: true,
        error: '',
        models: models.map((id) => {
          const p = priceFor(id);
          return { id, priced: isPriced(id), inputPerMTok: p.input, outputPerMTok: p.output };
        }),
      });
    } catch (err) {
      out.push({
        provider: provider.id,
        configured: true,
        models: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json(out);
});

systemRouter.get('/settings', (req, res) => {
  res.json({ settings: allSettings(req.auth!.accountId), defaults: DEFAULT_SETTINGS });
});

systemRouter.put('/settings', (req, res) => {
  const parsed = z.record(z.string(), z.union([z.string(), z.number()])).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const accountId = req.auth!.accountId;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    setSetting(key, String(value), accountId);
  }
  res.json({ settings: allSettings(accountId) });
});

/** Active and recent work, for the Activity view. */
systemRouter.get('/activity', (req, res) => {
  const accountId = req.auth!.accountId;
  const limit = Math.min(200, Number(req.query.limit ?? 40));
  const runSelect = `
    SELECT r.*, p.name AS profile_name,
           (SELECT COUNT(*) FROM run_events e WHERE e.run_id = r.id) AS event_count
    FROM runs r LEFT JOIN profiles p ON p.id = r.profile_id`;

  const active = db
    .prepare(`${runSelect} WHERE r.account_id = ? AND r.status = 'running' ORDER BY r.started_at`)
    .all(accountId);

  // The last few events of each in-progress run, so the view shows live movement.
  const liveEvents = active.length
    ? db
        .prepare(
          `SELECT * FROM run_events WHERE run_id IN (${active.map(() => '?').join(',')})
           ORDER BY run_id, seq`,
        )
        .all(...active.map((r) => (r as { id: string }).id))
    : [];

  const recent = db
    .prepare(
      `${runSelect} WHERE r.account_id = ? AND r.status != 'running' ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(accountId, limit);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS runs, ROUND(SUM(cost_usd), 4) AS cost,
              SUM(sources_added) AS sources_added, SUM(sources_scanned) AS sources_scanned,
              SUM(projects_found) AS projects_found, SUM(facts_added) AS facts_added
       FROM runs WHERE account_id = ? AND started_at >= datetime('now', '-7 days')`,
    )
    .get(accountId);

  res.json({ active, liveEvents, recent, totals, schedulerRunning: isTickRunning() });
});

systemRouter.get('/runs', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 100')
      .all(req.auth!.accountId),
  );
});

systemRouter.get('/runs/:id', (req, res) => {
  const run = db
    .prepare('SELECT * FROM runs WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.auth!.accountId);
  if (!run) return res.status(404).json({ error: 'not found' });
  const usage = db
    .prepare('SELECT * FROM usage_ledger WHERE run_id = ? ORDER BY created_at')
    .all(req.params.id);
  const events = db
    .prepare(
      `SELECT e.*, s.name AS source_name, pr.name AS project_name, wt.name AS work_type_name
       FROM run_events e
       LEFT JOIN sources s ON s.id = e.source_id
       LEFT JOIN projects pr ON pr.id = e.project_id
       LEFT JOIN work_types wt ON wt.id = e.work_type_id
       WHERE e.run_id = ? ORDER BY e.seq`,
    )
    .all(req.params.id);
  res.json({ run, usage, events });
});

systemRouter.get('/budget', (req, res) => {
  const accountId = req.auth!.accountId;
  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, ROUND(SUM(cost_usd), 4) AS cost, COUNT(*) AS calls
       FROM usage_ledger WHERE account_id = ? AND month_key = ? GROUP BY day ORDER BY day`,
    )
    .all(accountId, monthKey());
  const byPurpose = db
    .prepare(
      `SELECT purpose, ROUND(SUM(cost_usd), 4) AS cost, COUNT(*) AS calls
       FROM usage_ledger WHERE account_id = ? AND month_key = ? GROUP BY purpose ORDER BY cost DESC`,
    )
    .all(accountId, monthKey());
  res.json({
    ...visibleBudgetStatus(accountId, Boolean(req.auth!.user.is_site_admin)),
    daily,
    byPurpose,
  });
});

/** Run a full scheduler pass right now. */
systemRouter.post('/tick', async (req, res) => {
  if (isTickRunning()) return res.status(409).json({ error: 'A pass is already running.' });
  // A manual tick works this account only, so one tenant cannot trigger paid
  // work for every other tenant on the installation.
  const outcome = await runTick('manual', req.auth!.accountId);
  res.json(outcome);
});

systemRouter.post('/updates/seen', (req, res) => {
  const ids = z.array(z.string()).safeParse(req.body?.ids);
  if (!ids.success) return res.status(400).json({ error: 'ids must be a string array' });
  const stmt = db.prepare(
    `UPDATE project_updates SET seen = 1
     WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE account_id = ?)`,
  );
  const accountId = req.auth!.accountId;
  const tx = db.transaction((list: string[]) => list.forEach((id) => stmt.run(id, accountId)));
  tx(ids.data);
  res.status(204).end();
});
