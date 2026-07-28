import request from 'supertest';
import type { Express } from 'express';
import { db, newId, nowIso, createAccount } from '../src/server/db/index.js';
import { enterAccountScope } from '../src/server/lib/context.js';
import { addMembership, createUser, type Role } from '../src/server/auth/store.js';
import type { RunContext } from '../src/server/jobs/runs.js';
import type { ProfileRow, SourceRow, WorkTypeRow } from '../src/server/lib/models.js';

/**
 * The account every fixture belongs to.
 *
 * `migrate()` always leaves exactly one account behind — the one that adopts
 * pre-tenancy data — so tests reuse it rather than inventing another.
 */
export function primaryAccountId(): string {
  return (db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as { id: string })
    .id;
}

/**
 * Puts the rest of this test file inside an account scope.
 *
 * Account-scoped reads throw without one, by design — call this once after
 * `migrate()` in any test that touches settings, budgets, or jobs.
 */
export function useAccount(accountId = primaryAccountId()): string {
  enterAccountScope(accountId);
  return accountId;
}

/** A second tenant, for proving that scoping actually holds. */
export function makeAccount(name = 'Other Firm'): string {
  return createAccount(name);
}

/**
 * A run context that records what a job logged but spends nothing.
 *
 * `canSpend: false` also makes the optional AI duplicate-matching step skip
 * itself, so ingest tests exercise the deterministic key-dedupe fallback.
 */
export function fakeCtx(
  opts: { canSpend?: boolean; accountId?: string } = {},
): RunContext & { events: string[] } {
  const events: string[] = [];
  return {
    runId: null as unknown as string,
    accountId: opts.accountId ?? primaryAccountId(),
    budget: {
      canSpend: () => opts.canSpend ?? false,
      assertCanSpend: () => {},
      record: () => 0,
      remainingTokenAllowance: () => 20_000,
      spentUsd: 0,
    } as never,
    lines: events,
    events,
    log: (m: string) => events.push(m),
    result: (m: string) => events.push(`result:${m}`),
    step: (m: string) => events.push(`step:${m}`),
    count: () => {},
  };
}

export function makeProfile(over: Partial<ProfileRow> & { account_id?: string } = {}): ProfileRow {
  const id = over.id ?? newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO profiles (id, account_id, name, description, center_label, center_lat, center_lng, radius_miles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    over.account_id ?? primaryAccountId(),
    over.name ?? 'test profile',
    over.description ?? 'a test firm',
    over.center_label ?? 'Baton Rouge',
    over.center_lat ?? 30.45,
    over.center_lng ?? -91.19,
    over.radius_miles ?? 60,
    now,
    now,
  );
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow;
}

export function makeSource(profileId: string, over: Partial<SourceRow> = {}): SourceRow {
  const id = over.id ?? newId();
  const now = nowIso();
  const accountId =
    (db.prepare('SELECT account_id FROM profiles WHERE id = ?').get(profileId) as
      | { account_id: string }
      | undefined)?.account_id ?? primaryAccountId();
  db.prepare(
    `INSERT INTO sources (id, account_id, profile_id, name, url, kind, jurisdiction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    profileId,
    over.name ?? 'Test Agendas',
    over.url ?? `https://example.invalid/${id}`,
    over.kind ?? 'meeting_minutes',
    over.jurisdiction ?? 'Test Parish',
    over.status ?? 'active',
    now,
    now,
  );
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow;
}

export function makeWorkType(profileId: string, key: string, name = key): WorkTypeRow {
  const id = newId();
  const now = nowIso();
  const accountId =
    (db.prepare('SELECT account_id FROM profiles WHERE id = ?').get(profileId) as
      | { account_id: string }
      | undefined)?.account_id ?? primaryAccountId();
  db.prepare(
    `INSERT INTO work_types (id, account_id, profile_id, key, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(id, accountId, profileId, key, name, now, now);
  return db.prepare('SELECT * FROM work_types WHERE id = ?').get(id) as WorkTypeRow;
}

// ---------------------------------------------------------------------------
// Auth fixtures
// ---------------------------------------------------------------------------

const TEST_PASSWORD = 'correct-horse-battery';

export async function makeUser(opts: {
  email: string;
  password?: string;
  accountId?: string;
  role?: Role;
  isSiteAdmin?: boolean;
  /** Omit the membership entirely, to test a user with nowhere to go. */
  noMembership?: boolean;
}) {
  const user = await createUser({
    email: opts.email,
    password: opts.password ?? TEST_PASSWORD,
    isSiteAdmin: opts.isSiteAdmin,
  });
  if (!opts.noMembership) {
    addMembership(user.id, opts.accountId ?? primaryAccountId(), opts.role ?? 'owner');
  }
  return user;
}

/**
 * A supertest agent carrying a real session cookie.
 *
 * Tests authenticate through the actual login route rather than forging a
 * session, so the cookie handling stays covered by every test that uses one.
 */
export async function signIn(
  app: Express,
  email: string,
  password = TEST_PASSWORD,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return agent;
}

/** Creates an owner and returns a signed-in agent for them, in one step. */
export async function signedInOwner(
  app: Express,
  opts: { email?: string; accountId?: string; isSiteAdmin?: boolean } = {},
) {
  const email = opts.email ?? `owner-${newId().slice(0, 8)}@example.test`;
  const user = await makeUser({
    email,
    accountId: opts.accountId,
    role: 'owner',
    isSiteAdmin: opts.isSiteAdmin,
  });
  return { user, agent: await signIn(app, email) };
}

/** A scan candidate with sensible defaults, overridable per test. */
export function candidate(over: Record<string, unknown> = {}) {
  return {
    name: 'Central Fire Station Replacement',
    summary: 'Replacement of the central fire station.',
    project_type: 'fire station',
    stage: 'planning',
    address: '',
    jurisdiction: 'Test Parish',
    owner_org: 'Test Parish Government',
    estimated_value: '',
    timeline_note: '',
    evidence_url: 'https://example.invalid/agenda/1',
    evidence_quote: 'Council authorized design funding.',
    work_type_key: '',
    relevance: 80,
    confidence: 80,
    ...over,
  } as never;
}

/**
 * Clears tenant data but keeps accounts and users, so a signed-in agent stays
 * signed in across tests.
 */
export function resetData() {
  // profiles cascade to sources, projects, work types and their children.
  db.exec('DELETE FROM profiles; DELETE FROM runs; DELETE FROM usage_ledger; DELETE FROM artifacts;');
}

/** Removes accounts and identities too. For tests that assert on a bare install. */
export function resetAll() {
  resetData();
  db.exec('DELETE FROM sessions; DELETE FROM invites; DELETE FROM memberships; DELETE FROM users;');
}
