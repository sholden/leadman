import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db, migrate, newId } from '../src/server/db/index.js';
import { createApp } from '../src/server/app.js';
import {
  hashPassword,
  verifyPassword,
  passwordProblem,
  MIN_PASSWORD_LENGTH,
} from '../src/server/lib/password.js';
import {
  makeAccount,
  makeUser,
  primaryAccountId,
  resetAll,
  signIn,
  signedInOwner,
  useAccount,
} from './helpers.js';

migrate();
useAccount();
const app = createApp();

beforeEach(() => resetAll());

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-batterz', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same-password-here')).not.toBe(await hashPassword('same-password-here'));
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash).not.toContain('correct-horse-battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$a$b')).toBe(false);
  });

  it('requires a password long enough to matter', () => {
    // Asserted against the constant so the rule and its message cannot drift.
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH}`),
    );
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('a'.repeat(201))).toMatch(/at most/);
  });
});

describe('login', () => {
  it('sets an httpOnly session cookie on success', async () => {
    await makeUser({ email: 'owner@example.test' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.test', password: 'correct-horse-battery' })
      .expect(200);

    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/leadman_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(res.body.user.email).toBe('owner@example.test');
    expect(res.body.accountId).toBeTruthy();
  });

  it('is case-insensitive about the email', async () => {
    await makeUser({ email: 'owner@example.test' });
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'OWNER@Example.TEST', password: 'correct-horse-battery' })
      .expect(200);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    await makeUser({ email: 'owner@example.test' });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.test', password: 'nope' })
      .expect(401);
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'nope' })
      .expect(401);
    // Identical messages, so login cannot be used to enumerate accounts.
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it('refuses a disabled user', async () => {
    const user = await makeUser({ email: 'gone@example.test' });
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'gone@example.test', password: 'correct-horse-battery' })
      .expect(401);
  });

  it('ends the session on logout', async () => {
    await makeUser({ email: 'owner@example.test' });
    const agent = await signIn(app, 'owner@example.test');
    await agent.get('/api/profiles').expect(200);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/profiles').expect(401);
  });

  it('reports a user who belongs to no account, rather than 500ing', async () => {
    await makeUser({ email: 'nowhere@example.test', noMembership: true });
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: 'nowhere@example.test', password: 'correct-horse-battery' })
      .expect(200);
    const res = await agent.get('/api/profiles').expect(403);
    expect(res.body.code).toBe('no_account');
  });
});

describe('changing a password', () => {
  it('requires the current one, and revokes other sessions', async () => {
    await makeUser({ email: 'owner@example.test' });
    const first = await signIn(app, 'owner@example.test');
    const second = await signIn(app, 'owner@example.test');

    await first
      .post('/api/auth/password')
      .send({ currentPassword: 'wrong', newPassword: 'a-brand-new-password' })
      .expect(403);

    await first
      .post('/api/auth/password')
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' })
      .expect(204);

    // The session that made the change keeps working...
    await first.get('/api/profiles').expect(200);
    // ...every other one is revoked.
    await second.get('/api/profiles').expect(401);
  });

  it('refuses a new password that is too weak', async () => {
    await makeUser({ email: 'owner@example.test' });
    const agent = await signIn(app, 'owner@example.test');
    await agent
      .post('/api/auth/password')
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'short' })
      .expect(400);
  });
});

describe('account isolation', () => {
  it('hides one account’s profiles from another', async () => {
    const other = makeAccount('Other Firm');
    const a = await signedInOwner(app, { email: 'a@example.test' });
    const b = await signedInOwner(app, { email: 'b@example.test', accountId: other });

    const created = await a.agent
      .post('/api/profiles')
      .send({
        name: 'Capital Region',
        description: 'A firm that does public institutional work in Baton Rouge.',
        center_label: 'Baton Rouge',
        center_lat: 30.45,
        center_lng: -91.19,
        radius_miles: 60,
      })
      .expect(201);

    expect((await a.agent.get('/api/profiles').expect(200)).body).toHaveLength(1);
    expect((await b.agent.get('/api/profiles').expect(200)).body).toHaveLength(0);

    // Knowing the id is not enough: it reads as missing, not forbidden.
    await b.agent.patch(`/api/profiles/${created.body.id}`).send({ radius_miles: 5 }).expect(404);
    await b.agent.post(`/api/profiles/${created.body.id}/discover`).expect(404);

    // ...and a delete aimed at it must not take effect.
    await b.agent.delete(`/api/profiles/${created.body.id}`).expect(204);
    expect((await a.agent.get('/api/profiles').expect(200)).body).toHaveLength(1);
  });

  it('refuses to attach a source to another account’s profile', async () => {
    const other = makeAccount('Other Firm');
    const a = await signedInOwner(app, { email: 'a@example.test' });
    const b = await signedInOwner(app, { email: 'b@example.test', accountId: other });

    const { body: profile } = await a.agent
      .post('/api/profiles')
      .send({
        name: 'Capital Region',
        description: 'A firm that does public institutional work in Baton Rouge.',
        center_label: 'Baton Rouge',
        center_lat: 30.45,
        center_lng: -91.19,
        radius_miles: 60,
      })
      .expect(201);

    await b.agent
      .post('/api/sources')
      .send({ profile_id: profile.id, name: 'Sneaky', url: 'https://example.invalid/x' })
      .expect(404);
  });

  it('keeps settings and spend separate', async () => {
    const other = makeAccount('Other Firm');
    const a = await signedInOwner(app, { email: 'a@example.test' });
    const b = await signedInOwner(app, { email: 'b@example.test', accountId: other });

    await a.agent.put('/api/settings').send({ perRunBudgetUsd: '9' }).expect(200);
    expect((await a.agent.get('/api/settings')).body.settings.perRunBudgetUsd).toBe('9');
    expect((await b.agent.get('/api/settings')).body.settings.perRunBudgetUsd).not.toBe('9');
  });

  it('does not leak an artifact to another account', async () => {
    const other = makeAccount('Other Firm');
    const a = await signedInOwner(app, { email: 'a@example.test' });
    const b = await signedInOwner(app, { email: 'b@example.test', accountId: other });

    const artifactId = newId();
    db.prepare(
      `INSERT INTO artifacts (id, account_id, url, title, content_text, content_hash, byte_size, fetched_at)
       VALUES (?, ?, 'https://example.invalid/doc', 'Doc', 'secret', 'h', 6, datetime('now'))`,
    ).run(artifactId, primaryAccountId());

    await a.agent.get(`/api/projects/artifacts/${artifactId}`).expect(200);
    await b.agent.get(`/api/projects/artifacts/${artifactId}`).expect(404);
  });
});

describe('switching accounts', () => {
  it('moves a member between the accounts they belong to', async () => {
    const other = makeAccount('Other Firm');
    const user = await makeUser({ email: 'both@example.test' });
    const { addMembership } = await import('../src/server/auth/store.js');
    addMembership(user.id, other, 'member');

    const agent = await signIn(app, 'both@example.test');
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.accounts).toHaveLength(2);

    const switched = await agent.post('/api/auth/switch-account').send({ accountId: other }).expect(200);
    expect(switched.body.accountId).toBe(other);
    expect(switched.body.role).toBe('member');
  });

  it('refuses an account the user does not belong to', async () => {
    const other = makeAccount('Other Firm');
    await makeUser({ email: 'one@example.test' });
    const agent = await signIn(app, 'one@example.test');
    await agent.post('/api/auth/switch-account').send({ accountId: other }).expect(403);
  });

  it('lets a site admin enter an account they are not a member of, and logs it', async () => {
    const other = makeAccount('Other Firm');
    await makeUser({ email: 'admin@example.test', isSiteAdmin: true });
    const agent = await signIn(app, 'admin@example.test');

    await agent.post('/api/auth/switch-account').send({ accountId: other }).expect(200);
    await agent.get('/api/profiles').expect(200);

    const log = await agent.get('/api/admin/access-log').expect(200);
    expect(log.body.some((r: { account_name: string }) => r.account_name === 'Other Firm')).toBe(true);
  });
});

describe('roles', () => {
  it('stops a member from inviting or changing membership', async () => {
    const owner = await makeUser({ email: 'owner@example.test', role: 'owner' });
    await makeUser({ email: 'member@example.test', role: 'member' });
    const memberAgent = await signIn(app, 'member@example.test');

    await memberAgent.get('/api/account/invites').expect(403);
    await memberAgent.post('/api/account/invites').send({ email: 'x@example.test' }).expect(403);
    await memberAgent.patch(`/api/account/members/${owner.id}`).send({ role: 'member' }).expect(403);
    await memberAgent.delete(`/api/account/members/${owner.id}`).expect(403);
    // ...but ordinary data access is unaffected.
    await memberAgent.get('/api/profiles').expect(200);
  });

  it('protects the last owner from demotion and removal', async () => {
    const owner = await makeUser({ email: 'owner@example.test', role: 'owner' });
    const agent = await signIn(app, 'owner@example.test');

    const demote = await agent.patch(`/api/account/members/${owner.id}`).send({ role: 'member' }).expect(409);
    expect(demote.body.error).toMatch(/last owner/i);
    await agent.delete(`/api/account/members/${owner.id}`).expect(409);
  });

  it('allows demotion once a second owner exists', async () => {
    const first = await makeUser({ email: 'first@example.test', role: 'owner' });
    const second = await makeUser({ email: 'second@example.test', role: 'owner' });
    const agent = await signIn(app, 'second@example.test');
    await agent.patch(`/api/account/members/${first.id}`).send({ role: 'member' }).expect(200);
  });

  it('keeps site-admin routes closed to an account owner', async () => {
    await makeUser({ email: 'owner@example.test', role: 'owner' });
    const agent = await signIn(app, 'owner@example.test');
    await agent.get('/api/admin/accounts').expect(403);
    await agent.post('/api/admin/accounts').send({ name: 'Mine' }).expect(403);
  });
});

describe('invites', () => {
  async function ownerAgent() {
    await makeUser({ email: 'owner@example.test', role: 'owner' });
    return signIn(app, 'owner@example.test');
  }

  it('creates a link, which a new user redeems by setting a password', async () => {
    const agent = await ownerAgent();
    const created = await agent
      .post('/api/account/invites')
      .send({ email: 'newbie@example.test' })
      .expect(201);

    const token = created.body.url.split('/invite/')[1];
    const preview = await request(app).get(`/api/auth/invite/${token}`).expect(200);
    expect(preview.body.email).toBe('newbie@example.test');
    expect(preview.body.userExists).toBe(false);

    const accepted = await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'a-perfectly-fine-password' })
      .expect(201);
    expect(accepted.body.role).toBe('member');
    expect(accepted.body.accountId).toBe(primaryAccountId());
  });

  it('cannot be redeemed twice', async () => {
    const agent = await ownerAgent();
    const { body } = await agent.post('/api/account/invites').send({ email: 'newbie@example.test' });
    const token = body.url.split('/invite/')[1];

    await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'a-perfectly-fine-password' })
      .expect(201);
    await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'a-perfectly-fine-password' })
      .expect(400);
  });

  it('requires the existing password when the address is already a user', async () => {
    const other = makeAccount('Other Firm');
    await makeUser({ email: 'existing@example.test', accountId: other });
    const agent = await ownerAgent();
    const { body } = await agent.post('/api/account/invites').send({ email: 'existing@example.test' });
    const token = body.url.split('/invite/')[1];

    expect((await request(app).get(`/api/auth/invite/${token}`)).body.userExists).toBe(true);
    await request(app).post(`/api/auth/invite/${token}/accept`).send({ password: 'guess' }).expect(403);
    await request(app)
      .post(`/api/auth/invite/${token}/accept`)
      .send({ password: 'correct-horse-battery' })
      .expect(201);
  });

  it('rejects an unknown or revoked token', async () => {
    const agent = await ownerAgent();
    await request(app).get('/api/auth/invite/nonsense').expect(400);

    const { body } = await agent.post('/api/account/invites').send({ email: 'newbie@example.test' });
    const token = body.url.split('/invite/')[1];
    await agent.delete(`/api/account/invites/${body.id}`).expect(204);
    await request(app).get(`/api/auth/invite/${token}`).expect(400);
  });

  it('refuses to invite someone already in the account', async () => {
    const agent = await ownerAgent();
    await agent.post('/api/account/invites').send({ email: 'owner@example.test' }).expect(409);
  });

  it('stores only a hash of the token', async () => {
    const agent = await ownerAgent();
    const { body } = await agent.post('/api/account/invites').send({ email: 'newbie@example.test' });
    const token = body.url.split('/invite/')[1];
    const rows = db.prepare('SELECT token_hash FROM invites').all() as { token_hash: string }[];
    expect(rows[0].token_hash).not.toBe(token);
  });
});

describe('site administration', () => {
  async function adminAgent() {
    await makeUser({ email: 'admin@example.test', isSiteAdmin: true });
    return signIn(app, 'admin@example.test');
  }

  it('creates an account with an invite for its first owner', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/api/admin/accounts')
      .send({ name: 'Third Firm', ownerEmail: 'boss@example.test' })
      .expect(201);
    expect(res.body.account.name).toBe('Third Firm');
    expect(res.body.invite.url).toMatch(/#\/invite\//);
  });

  it('gives a new account its own copy of the default settings', async () => {
    const agent = await adminAgent();
    const { body } = await agent.post('/api/admin/accounts').send({ name: 'Fresh Firm' }).expect(201);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM settings WHERE account_id = ?')
      .get(body.account.id) as { n: number };
    expect(rows.n).toBeGreaterThan(0);
  });

  it('will not delete an account without the name typed back', async () => {
    const agent = await adminAgent();
    const { body } = await agent.post('/api/admin/accounts').send({ name: 'Doomed' }).expect(201);
    await agent.delete(`/api/admin/accounts/${body.account.id}`).expect(400);
    await agent.delete(`/api/admin/accounts/${body.account.id}?confirm=Doomed`).expect(204);
  });

  it('stops an admin from locking themselves out', async () => {
    await makeUser({ email: 'admin@example.test', isSiteAdmin: true });
    const agent = await signIn(app, 'admin@example.test');
    const me = await agent.get('/api/auth/me').expect(200);
    await agent.patch(`/api/admin/users/${me.body.user.id}`).send({ isSiteAdmin: false }).expect(409);
    await agent.patch(`/api/admin/users/${me.body.user.id}`).send({ active: false }).expect(409);
  });

  it('drops the sessions of a user it disables', async () => {
    const victim = await makeUser({ email: 'victim@example.test' });
    const victimAgent = await signIn(app, 'victim@example.test');
    await victimAgent.get('/api/profiles').expect(200);

    const agent = await adminAgent();
    await agent.patch(`/api/admin/users/${victim.id}`).send({ active: false }).expect(200);
    await victimAgent.get('/api/profiles').expect(401);
  });
});
