import type { NextFunction, Request, Response } from 'express';
import {
  SESSION_COOKIE,
  findUser,
  logAdminAccess,
  membershipRole,
  sessionFromToken,
  setSessionAccount,
  touchSession,
  accountsForUser,
  type Role,
  type SessionRow,
  type UserRow,
} from './store.js';
import { db } from '../db/index.js';
import { runInScope } from '../lib/context.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user: UserRow;
        session: SessionRow;
        accountId: string;
        /** Role in the active account. Null when a site admin is visiting. */
        role: Role | null;
        viaSiteAdmin: boolean;
      };
    }
  }
}

/**
 * Express can set cookies but not read them, and one cookie does not justify a
 * dependency. Values are percent-encoded by `res.cookie`, hence the decode.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Resolves the session and the account it is acting in, then runs the rest of
 * the request inside that account's scope.
 *
 * Site admins may act in any account, but only through the same
 * `active_account_id` field a normal member uses — there is no unscoped query
 * path anywhere in the app. That keeps one code path for every read and makes
 * the admin's reach auditable rather than ambient.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  const session = sessionFromToken(token);
  if (!session) return res.status(401).json({ error: 'Your session has expired.' });

  const user = findUser(session.user_id);
  if (!user || !user.active) return res.status(401).json({ error: 'Your account is disabled.' });

  const accountId = resolveActiveAccount(session, user);
  if (!accountId) {
    return res.status(403).json({
      error: 'You are not a member of any account yet. Ask an owner for an invite.',
      code: 'no_account',
    });
  }

  const role = membershipRole(user.id, accountId);
  const viaSiteAdmin = role === null;
  if (viaSiteAdmin) {
    if (!user.is_site_admin) return res.status(403).json({ error: 'No access to this account.' });
    logAdminAccess(user.id, accountId);
  }

  touchSession(session.id);
  req.auth = { user, session, accountId, role, viaSiteAdmin };

  runInScope({ accountId, userId: user.id, viaSiteAdmin }, () => next());
}

/**
 * The account this session is acting in. Falls back to the user's first
 * membership so a fresh login lands somewhere sensible, and repairs a session
 * pointing at an account that was deleted or that the user was removed from.
 */
function resolveActiveAccount(session: SessionRow, user: UserRow): string | null {
  const stillValid = (accountId: string | null): boolean => {
    if (!accountId) return false;
    const account = db
      .prepare('SELECT active FROM accounts WHERE id = ?')
      .get(accountId) as { active: number } | undefined;
    if (!account || !account.active) return false;
    return user.is_site_admin === 1 || membershipRole(user.id, accountId) !== null;
  };

  if (stillValid(session.active_account_id)) return session.active_account_id;

  const fallback = accountsForUser(user.id)[0]?.id ?? null;
  if (fallback) setSessionAccount(session.id, fallback);
  return fallback;
}

/** Blocks members from owner-only actions: membership changes and invites. */
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  const auth = req.auth;
  if (!auth) return res.status(401).json({ error: 'Not signed in.' });
  if (auth.role === 'owner' || auth.user.is_site_admin) return next();
  return res.status(403).json({ error: 'Only an account owner can do that.' });
}

/** Blocks everyone but site admins: account creation, installation settings. */
export function requireSiteAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.auth;
  if (!auth) return res.status(401).json({ error: 'Not signed in.' });
  if (auth.user.is_site_admin) return next();
  return res.status(403).json({ error: 'Site administrator access required.' });
}
