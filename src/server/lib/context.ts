import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The account whose data the current unit of work may touch.
 *
 * Carried ambiently rather than threaded through every signature because the
 * deepest readers are in the provider layer — `anthropic.ts` and `openai.ts`
 * read five different settings from nested helpers that have no reason to know
 * about tenancy. Passing an account id down to them would mean changing the
 * shape of every job, every provider call, and every tool definition.
 *
 * The tradeoff of an ambient value is that forgetting to set it is invisible.
 * `currentAccountId()` therefore throws rather than returning a default: an
 * unscoped read fails immediately and loudly, instead of quietly serving one
 * tenant's data to another.
 */
export interface RequestScope {
  accountId: string;
  userId: string | null;
  /** True when the actor is a site admin acting outside their own memberships. */
  viaSiteAdmin: boolean;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Runs `fn` with the given account as the ambient scope. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Convenience for background work, which has an account but no signed-in user. */
export function runInAccount<T>(accountId: string, fn: () => T): T {
  return runInScope({ accountId, userId: null, viaSiteAdmin: false }, fn);
}

export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

/**
 * A fallback account for code with no natural scope boundary to wrap — which in
 * practice means tests, where there is no request and no job to run inside.
 *
 * `AsyncLocalStorage.enterWith()` was the obvious way to do this and is not
 * reliable: a store installed during module evaluation does not propagate into
 * test callbacks scheduled later, so the suite passed on Node 23 and failed on
 * the Node 26 that CI and production actually run.
 *
 * Refused outside the test runner, so the guarantee that production code cannot
 * read tenant data unscoped is not weakened by this existing.
 */
let ambientAccountId: string | null = null;

export function setAmbientAccount(accountId: string | null) {
  if (!process.env.VITEST) {
    throw new Error(
      'setAmbientAccount() is a test-only helper. Production code must establish ' +
        'an explicit scope with runInScope() or runInAccount().',
    );
  }
  ambientAccountId = accountId;
}

/**
 * The active account. Throws when nothing established a scope — that is a bug
 * in the caller, and failing here is far safer than guessing.
 */
export function currentAccountId(): string {
  const scope = storage.getStore();
  if (scope) return scope.accountId;
  if (ambientAccountId) return ambientAccountId;
  throw new Error(
    'No account scope is active. Wrap this work in runInAccount()/runInScope() — ' +
      'account-scoped data must never be read without knowing which tenant it belongs to.',
  );
}

/** The active account, or null when there is no scope. For optional reads only. */
export function maybeAccountId(): string | null {
  return storage.getStore()?.accountId ?? ambientAccountId;
}
