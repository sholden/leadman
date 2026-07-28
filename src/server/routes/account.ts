import { Router } from 'express';
import { z } from 'zod';
import { db, nowIso } from '../db/index.js';
import { requireAuth, requireOwner } from '../auth/middleware.js';
import {
  addMembership,
  createInvite,
  invitesForAccount,
  membersOfAccount,
  membershipRole,
  normalizeEmail,
  findUserByEmail,
  ownerCount,
} from '../auth/store.js';

/** Membership and invites for the account the session is currently acting in. */
export const accountRouter = Router();

accountRouter.use(requireAuth);

accountRouter.get('/', (req, res) => {
  const auth = req.auth!;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(auth.accountId);
  res.json({ account, role: auth.role, viaSiteAdmin: auth.viaSiteAdmin });
});

const renameInput = z.object({ name: z.string().min(1).max(200) });

accountRouter.patch('/', requireOwner, (req, res) => {
  const parsed = renameInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  db.prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?').run(
    parsed.data.name,
    nowIso(),
    req.auth!.accountId,
  );
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.auth!.accountId));
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

accountRouter.get('/members', (req, res) => {
  res.json(membersOfAccount(req.auth!.accountId));
});

const roleInput = z.object({ role: z.enum(['owner', 'member']) });

accountRouter.patch('/members/:userId', requireOwner, (req, res) => {
  const parsed = roleInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { accountId } = req.auth!;
  const target = req.params.userId;

  const current = membershipRole(target, accountId);
  if (!current) return res.status(404).json({ error: 'That user is not a member of this account.' });

  // Demoting the only owner would leave the account with nobody who can manage
  // membership or invite a replacement.
  if (current === 'owner' && parsed.data.role !== 'owner' && ownerCount(accountId) === 1) {
    return res.status(409).json({ error: 'This is the account’s last owner. Promote someone else first.' });
  }

  addMembership(target, accountId, parsed.data.role);
  res.json(membersOfAccount(accountId));
});

accountRouter.delete('/members/:userId', requireOwner, (req, res) => {
  const { accountId, user } = req.auth!;
  const target = req.params.userId;

  const current = membershipRole(target, accountId);
  if (!current) return res.status(404).json({ error: 'That user is not a member of this account.' });
  if (current === 'owner' && ownerCount(accountId) === 1) {
    return res.status(409).json({ error: 'This is the account’s last owner and cannot be removed.' });
  }
  if (target === user.id && ownerCount(accountId) === 1) {
    return res.status(409).json({ error: 'You are the last owner. Promote someone else first.' });
  }

  db.prepare('DELETE FROM memberships WHERE user_id = ? AND account_id = ?').run(target, accountId);
  // Any session parked on this account must stop acting in it immediately.
  db.prepare('UPDATE sessions SET active_account_id = NULL WHERE user_id = ? AND active_account_id = ?').run(
    target,
    accountId,
  );
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Invites
//
// Nothing here sends email, so creating an invite returns a link the owner
// copies and delivers themselves. The raw token is shown exactly once.
// ---------------------------------------------------------------------------

accountRouter.get('/invites', requireOwner, (req, res) => {
  res.json(invitesForAccount(req.auth!.accountId));
});

const inviteInput = z.object({
  email: z.string().email().max(320),
  role: z.enum(['owner', 'member']).optional(),
});

accountRouter.post('/invites', requireOwner, (req, res) => {
  const parsed = inviteInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A valid email address is required.' });
  const { accountId, user } = req.auth!;
  const email = normalizeEmail(parsed.data.email);

  const existing = findUserByEmail(email);
  if (existing && membershipRole(existing.id, accountId)) {
    return res.status(409).json({ error: 'That person is already a member of this account.' });
  }

  const { invite, token } = createInvite({
    accountId,
    email,
    role: parsed.data.role ?? 'member',
    invitedBy: user.id,
  });

  res.status(201).json({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expires_at: invite.expires_at,
    /** Shown once. Only the hash is stored, so this cannot be recovered later. */
    url: `${baseUrl(req)}/#/invite/${token}`,
  });
});

accountRouter.delete('/invites/:id', requireOwner, (req, res) => {
  db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND account_id = ? AND accepted_at IS NULL').run(
    nowIso(),
    req.params.id,
    req.auth!.accountId,
  );
  res.status(204).end();
});

/** Origin the invite link should point at, honouring a terminating proxy. */
function baseUrl(req: { headers: Record<string, unknown>; protocol: string }): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0];
  return `${proto}://${host}`;
}
