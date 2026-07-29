import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db, nowIso } from '../db/index.js';
import { passwordProblem, verifyPassword, hashPassword } from '../lib/password.js';
import { requireAuth, readCookie } from '../auth/middleware.js';
import {
  SESSION_COOKIE,
  accountsForUser,
  addMembership,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  inviteFromToken,
  inviteProblem,
  markInviteAccepted,
  membershipRole,
  normalizeEmail,
  sessionFromToken,
  setSessionAccount,
  setUserPassword,
  allAccounts,
} from '../auth/store.js';

export const authRouter = Router();

const cookieOptions = () =>
  ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    path: '/',
    maxAge: config.sessionTtlDays * 86_400_000,
  });

/**
 * A password check that costs the same whether or not the address exists.
 *
 * Skipping the hash for an unknown email makes the response measurably faster
 * and turns login into an account-enumeration oracle, so a dummy verify runs
 * instead.
 */
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password-placeholder');

const loginInput = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Email and password are required.' });

  const user = findUserByEmail(parsed.data.email);
  const hash = user?.password_hash ?? (await DUMMY_HASH_PROMISE);
  const ok = await verifyPassword(parsed.data.password, hash);

  if (!user || !ok || !user.active) {
    return res.status(401).json({ error: 'That email and password do not match.' });
  }

  const first = accountsForUser(user.id)[0]?.id ?? null;
  const token = createSession(user.id, first, String(req.headers['user-agent'] ?? ''));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.json(sessionPayload(user.id, first));
});

authRouter.post('/logout', (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) destroySession(token);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

/** Who am I, which accounts can I reach, and which am I in right now. */
authRouter.get('/me', requireAuth, (req, res) => {
  const auth = req.auth!;
  res.json(sessionPayload(auth.user.id, auth.accountId));
});

const switchInput = z.object({ accountId: z.string().min(1) });

authRouter.post('/switch-account', requireAuth, (req, res) => {
  const parsed = switchInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'accountId is required.' });
  const auth = req.auth!;
  const target = parsed.data.accountId;

  const account = db.prepare('SELECT id, active FROM accounts WHERE id = ?').get(target) as
    | { id: string; active: number }
    | undefined;
  if (!account || !account.active) return res.status(404).json({ error: 'No such account.' });

  const allowed = membershipRole(auth.user.id, target) !== null || auth.user.is_site_admin === 1;
  if (!allowed) return res.status(403).json({ error: 'You are not a member of that account.' });

  setSessionAccount(auth.session.id, target);
  res.json(sessionPayload(auth.user.id, target));
});

const passwordInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const parsed = passwordInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Both passwords are required.' });
  const auth = req.auth!;

  if (!(await verifyPassword(parsed.data.currentPassword, auth.user.password_hash))) {
    return res.status(403).json({ error: 'Your current password is not correct.' });
  }
  const problem = passwordProblem(parsed.data.newPassword);
  if (problem) return res.status(400).json({ error: problem });

  // This drops every session for the user, including this one, so issue a fresh
  // one — otherwise changing your password silently signs you out.
  await setUserPassword(auth.user.id, parsed.data.newPassword);
  const token = createSession(auth.user.id, auth.accountId, String(req.headers['user-agent'] ?? ''));
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Invite redemption. Public by necessity — the whole point is that the redeemer
// may not have an account yet.
// ---------------------------------------------------------------------------

/** Describes an invite without requiring a session, so the page can render. */
authRouter.get('/invite/:token', (req, res) => {
  const invite = inviteFromToken(req.params.token);
  const problem = inviteProblem(invite);
  if (problem || !invite) return res.status(400).json({ error: problem ?? 'Invalid invite.' });

  const account = db.prepare('SELECT name FROM accounts WHERE id = ?').get(invite.account_id) as
    | { name: string }
    | undefined;
  res.json({
    email: invite.email,
    role: invite.role,
    accountName: account?.name ?? 'an account',
    /** Tells the UI whether to ask for a new password or an existing one. */
    userExists: Boolean(findUserByEmail(invite.email)),
  });
});

const acceptInput = z.object({
  password: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
});

authRouter.post('/invite/:token/accept', async (req, res) => {
  const parsed = acceptInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A password is required.' });

  const invite = inviteFromToken(req.params.token);
  const problem = inviteProblem(invite);
  if (problem || !invite) return res.status(400).json({ error: problem ?? 'Invalid invite.' });

  const existing = findUserByEmail(invite.email);
  let userId: string;

  if (existing) {
    // Known address: prove it is really them before attaching a new account.
    if (!(await verifyPassword(parsed.data.password, existing.password_hash))) {
      return res.status(403).json({ error: 'That password is not correct for this email.' });
    }
    if (!existing.active) return res.status(403).json({ error: 'This user is disabled.' });
    userId = existing.id;
  } else {
    const weak = passwordProblem(parsed.data.password);
    if (weak) return res.status(400).json({ error: weak });
    const created = await createUser({
      email: invite.email,
      password: parsed.data.password,
      name: parsed.data.name ?? '',
    });
    userId = created.id;
  }

  addMembership(userId, invite.account_id, invite.role, invite.invited_by);
  markInviteAccepted(invite.id, userId);

  const token = createSession(userId, invite.account_id, String(req.headers['user-agent'] ?? ''));
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.status(201).json(sessionPayload(userId, invite.account_id));
});

/**
 * The shape the client keeps in memory: the person, the account they are in,
 * and everywhere else they could go.
 */
function sessionPayload(userId: string, accountId: string | null) {
  const user = db
    .prepare('SELECT id, email, name, is_site_admin FROM users WHERE id = ?')
    .get(userId) as { id: string; email: string; name: string; is_site_admin: number };

  const memberships = accountsForUser(userId);
  // A site admin can reach accounts it has no membership in; those still need
  // to appear in the switcher or the capability is unusable.
  const reachable = user.is_site_admin
    ? (allAccounts() as { id: string; name: string; slug: string; active: number }[])
        .filter((a) => a.active)
        .map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          role: memberships.find((m) => m.id === a.id)?.role ?? null,
        }))
    : memberships.map((a) => ({ id: a.id, name: a.name, slug: a.slug, role: a.role }));

  const active = accountId ? reachable.find((a) => a.id === accountId) ?? null : null;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isSiteAdmin: Boolean(user.is_site_admin),
    },
    accountId,
    account: active,
    role: active?.role ?? null,
    accounts: reachable,
  };
}

export { sessionPayload };
