import { Router } from 'express';
import { z } from 'zod';
import {
  allSiteSettings,
  createAccount,
  db,
  nowIso,
  setSiteSetting,
  seedAccountSettings,
} from '../db/index.js';
import { DEFAULT_SITE_SETTINGS } from '../config.js';
import { requireAuth, requireSiteAdmin } from '../auth/middleware.js';
import { allAccounts, createInvite, findUserByEmail, membershipRole, addMembership } from '../auth/store.js';
import { monthKey } from '../ai/budget.js';

/** Installation-level operations. Site admins only. */
export const adminRouter = Router();

adminRouter.use(requireAuth, requireSiteAdmin);

adminRouter.get('/accounts', (_req, res) => {
  const spend = db
    .prepare(
      `SELECT account_id, ROUND(SUM(cost_usd), 4) AS cost
       FROM usage_ledger WHERE month_key = ? GROUP BY account_id`,
    )
    .all(monthKey()) as { account_id: string; cost: number }[];

  const accounts = (allAccounts() as Record<string, unknown>[]).map((a) => ({
    ...a,
    monthToDateUsd: spend.find((s) => s.account_id === a.id)?.cost ?? 0,
  }));
  res.json(accounts);
});

const createInput = z.object({
  name: z.string().min(1).max(200),
  /** Optional first owner. Returns an invite link rather than setting a password. */
  ownerEmail: z.string().email().max(320).optional(),
});

adminRouter.post('/accounts', (req, res) => {
  const parsed = createInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const admin = req.auth!.user;

  const accountId = createAccount(parsed.data.name);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

  if (!parsed.data.ownerEmail) return res.status(201).json({ account, invite: null });

  // An existing user can simply be made owner; a new address gets a link, since
  // an admin has no business choosing someone else's password.
  const existing = findUserByEmail(parsed.data.ownerEmail);
  if (existing) {
    addMembership(existing.id, accountId, 'owner', admin.id);
    return res.status(201).json({ account, invite: null, ownerAdded: existing.email });
  }

  const { token } = createInvite({
    accountId,
    email: parsed.data.ownerEmail,
    role: 'owner',
    invitedBy: admin.id,
  });
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
  res.status(201).json({
    account,
    invite: { email: parsed.data.ownerEmail, url: `${proto}://${host}/#/invite/${token}` },
  });
});

const patchInput = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
});

adminRouter.patch('/accounts/:id', (req, res) => {
  const parsed = patchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as
    | { name: string; active: number }
    | undefined;
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.prepare('UPDATE accounts SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(
    parsed.data.name ?? existing.name,
    parsed.data.active === undefined ? existing.active : parsed.data.active ? 1 : 0,
    nowIso(),
    req.params.id,
  );
  // Deactivating must not leave sessions parked inside the account.
  if (parsed.data.active === false) {
    db.prepare('UPDATE sessions SET active_account_id = NULL WHERE active_account_id = ?').run(
      req.params.id,
    );
  }
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id));
});

/**
 * Deleting an account destroys every profile, source, project and archived
 * document it owns, via ON DELETE CASCADE. Deactivating is almost always what
 * you want instead, so this requires the name typed back as confirmation.
 */
adminRouter.delete('/accounts/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as
    | { id: string; name: string }
    | undefined;
  if (!account) return res.status(404).json({ error: 'not found' });
  if (String(req.query.confirm ?? '') !== account.name) {
    return res.status(400).json({
      error: 'Deleting an account erases all of its data. Pass ?confirm=<account name> to proceed.',
    });
  }
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

adminRouter.get('/site-settings', (_req, res) => {
  const perAccount = db
    .prepare(
      `SELECT ROUND(SUM(cost_usd), 4) AS cost FROM usage_ledger WHERE month_key = ?`,
    )
    .get(monthKey()) as { cost: number | null };
  res.json({
    settings: allSiteSettings(),
    defaults: DEFAULT_SITE_SETTINGS,
    monthToDateUsd: perAccount.cost ?? 0,
  });
});

adminRouter.put('/site-settings', (req, res) => {
  const parsed = z.record(z.string(), z.union([z.string(), z.number()])).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!(key in DEFAULT_SITE_SETTINGS)) continue;
    setSiteSetting(key, String(value));
  }
  res.json({ settings: allSiteSettings() });
});

/** Re-seeds any setting a new account is missing. Cheap repair for old rows. */
adminRouter.post('/accounts/:id/reseed-settings', (req, res) => {
  seedAccountSettings(req.params.id);
  res.status(204).end();
});

/** Who has been visiting which accounts as a site admin. */
adminRouter.get('/access-log', (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT l.at, u.email, a.name AS account_name
         FROM admin_access_log l
         JOIN users u ON u.id = l.user_id
         JOIN accounts a ON a.id = l.account_id
         ORDER BY l.at DESC LIMIT 200`,
      )
      .all(),
  );
});

/** Every user on the installation, with the accounts they can reach. */
adminRouter.get('/users', (_req, res) => {
  const users = db
    .prepare(
      `SELECT id, email, name, is_site_admin, active, last_login_at, created_at
       FROM users ORDER BY created_at`,
    )
    .all() as { id: string }[];
  const memberships = db
    .prepare(
      `SELECT m.user_id, m.role, a.id AS account_id, a.name AS account_name
       FROM memberships m JOIN accounts a ON a.id = m.account_id`,
    )
    .all() as { user_id: string }[];
  res.json(
    users.map((u) => ({ ...u, accounts: memberships.filter((m) => m.user_id === u.id) })),
  );
});

const userPatch = z.object({
  active: z.boolean().optional(),
  isSiteAdmin: z.boolean().optional(),
});

adminRouter.patch('/users/:id', (req, res) => {
  const parsed = userPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as
    | { id: string; active: number; is_site_admin: number }
    | undefined;
  if (!target) return res.status(404).json({ error: 'not found' });

  // Locking yourself out of your own installation is not a recoverable mistake.
  const selfDemotion = target.id === req.auth!.user.id;
  if (selfDemotion && (parsed.data.isSiteAdmin === false || parsed.data.active === false)) {
    return res.status(409).json({ error: 'You cannot remove your own administrator access.' });
  }

  db.prepare('UPDATE users SET active = ?, is_site_admin = ?, updated_at = ? WHERE id = ?').run(
    parsed.data.active === undefined ? target.active : parsed.data.active ? 1 : 0,
    parsed.data.isSiteAdmin === undefined ? target.is_site_admin : parsed.data.isSiteAdmin ? 1 : 0,
    nowIso(),
    req.params.id,
  );
  if (parsed.data.active === false) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  }
  res.json(db.prepare('SELECT id, email, name, is_site_admin, active FROM users WHERE id = ?').get(req.params.id));
});
