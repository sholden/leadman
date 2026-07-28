import { createHash, randomBytes } from 'node:crypto';
import { db, newId, nowIso, createAccount } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/password.js';

export type Role = 'owner' | 'member';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  is_site_admin: number;
  active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  id: string;
  name: string;
  slug: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  active_account_id: string | null;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

/**
 * Session and invite tokens are stored only as hashes. They are already
 * high-entropy random values, so a fast hash is the right tool — unlike a
 * password, there is nothing to brute-force. This means a database leak cannot
 * be replayed as a live session.
 */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const mintToken = () => randomBytes(32).toString('base64url');

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as
    | UserRow
    | undefined;
}

export function findUser(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string;
  isSiteAdmin?: boolean;
}): Promise<UserRow> {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, is_site_admin, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    normalizeEmail(input.email),
    await hashPassword(input.password),
    input.name ?? '',
    input.isSiteAdmin ? 1 : 0,
    now,
    now,
  );
  return findUser(id)!;
}

export async function setUserPassword(userId: string, password: string) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    await hashPassword(password),
    nowIso(),
    userId,
  );
  // A password change is a revocation: every other session for this user dies.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export function membershipRole(userId: string, accountId: string): Role | null {
  const row = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND account_id = ?')
    .get(userId, accountId) as { role: Role } | undefined;
  return row?.role ?? null;
}

export function addMembership(
  userId: string,
  accountId: string,
  role: Role = 'member',
  invitedBy: string | null = null,
) {
  db.prepare(
    `INSERT INTO memberships (user_id, account_id, role, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, account_id) DO UPDATE SET role = excluded.role`,
  ).run(userId, accountId, role, invitedBy, nowIso());
}

export function accountsForUser(userId: string): (AccountRow & { role: Role })[] {
  return db
    .prepare(
      `SELECT a.*, m.role FROM accounts a
       JOIN memberships m ON m.account_id = a.id
       WHERE m.user_id = ? AND a.active = 1
       ORDER BY a.name`,
    )
    .all(userId) as (AccountRow & { role: Role })[];
}

export function membersOfAccount(accountId: string) {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_site_admin, u.active, u.last_login_at,
              m.role, m.created_at AS joined_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.account_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email`,
    )
    .all(accountId);
}

export function ownerCount(accountId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE account_id = ? AND role = 'owner'")
      .get(accountId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'leadman_session';

export function createSession(
  userId: string,
  activeAccountId: string | null,
  userAgent = '',
): string {
  const token = mintToken();
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, active_account_id, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    hashToken(token),
    userId,
    activeAccountId,
    userAgent.slice(0, 300),
    now,
    now,
    new Date(Date.now() + config.sessionTtlDays * 86_400_000).toISOString(),
  );
  return token;
}

export function sessionFromToken(token: string): SessionRow | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
    | SessionRow
    | undefined;
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return undefined;
  }
  return row;
}

export function touchSession(sessionId: string) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), sessionId);
}

export function setSessionAccount(sessionId: string, accountId: string) {
  db.prepare('UPDATE sessions SET active_account_id = ? WHERE id = ?').run(accountId, sessionId);
}

export function destroySession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions() {
  const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  if (res.changes > 0) console.log(`[auth] purged ${res.changes} expired session(s)`);
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface InviteRow {
  id: string;
  account_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

const INVITE_TTL_DAYS = 14;

/** Returns the raw token exactly once — only its hash is persisted. */
export function createInvite(input: {
  accountId: string;
  email: string;
  role: Role;
  invitedBy: string;
}): { invite: InviteRow; token: string } {
  const token = mintToken();
  const id = newId();
  db.prepare(
    `INSERT INTO invites (id, account_id, email, role, token_hash, invited_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    normalizeEmail(input.email),
    input.role,
    hashToken(token),
    input.invitedBy,
    new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
    nowIso(),
  );
  return { invite: db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as InviteRow, token };
}

export function inviteFromToken(token: string): InviteRow | undefined {
  return db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(token)) as
    | InviteRow
    | undefined;
}

/** Why an invite cannot be redeemed right now, or null when it can. */
export function inviteProblem(invite: InviteRow | undefined): string | null {
  if (!invite) return 'This invite link is not valid.';
  if (invite.revoked_at) return 'This invite has been revoked.';
  if (invite.accepted_at) return 'This invite has already been used.';
  if (Date.parse(invite.expires_at) <= Date.now()) return 'This invite has expired.';
  return null;
}

export function markInviteAccepted(inviteId: string, userId: string) {
  db.prepare('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?').run(
    nowIso(),
    userId,
    inviteId,
  );
}

export function invitesForAccount(accountId: string) {
  return db
    .prepare(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
              u.email AS invited_by_email
       FROM invites i LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.account_id = ? ORDER BY i.created_at DESC LIMIT 100`,
    )
    .all(accountId);
}

// ---------------------------------------------------------------------------
// Site admin bookkeeping
// ---------------------------------------------------------------------------

export function siteAdminCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_site_admin = 1').get() as { n: number })
    .n;
}

export function logAdminAccess(userId: string, accountId: string) {
  // One entry per admin/account/day is enough to answer "who went where"
  // without writing a row on every request.
  const today = nowIso().slice(0, 10);
  const seen = db
    .prepare('SELECT 1 FROM admin_access_log WHERE user_id = ? AND account_id = ? AND at >= ?')
    .get(userId, accountId, today);
  if (seen) return;
  db.prepare('INSERT INTO admin_access_log (id, user_id, account_id, at) VALUES (?, ?, ?, ?)').run(
    newId(),
    userId,
    accountId,
    nowIso(),
  );
}

export function allAccounts() {
  return db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM memberships m WHERE m.account_id = a.id) AS member_count,
              (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS profile_count,
              (SELECT COUNT(*) FROM projects pr WHERE pr.account_id = a.id) AS project_count
       FROM accounts a ORDER BY a.created_at`,
    )
    .all();
}

export { createAccount };
