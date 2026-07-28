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
 * Sets the scope for the remainder of this execution rather than for a callback.
 *
 * Intended for tests and boot-time setup, where there is no natural function to
 * wrap. Request handling and background jobs should use `runInScope` /
 * `runInAccount` instead, so the scope cannot outlive the work it belongs to.
 */
export function enterAccountScope(accountId: string) {
  storage.enterWith({ accountId, userId: null, viaSiteAdmin: false });
}

/**
 * The active account. Throws when nothing established a scope — that is a bug
 * in the caller, and failing here is far safer than guessing.
 */
export function currentAccountId(): string {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error(
      'No account scope is active. Wrap this work in runInAccount()/runInScope() — ' +
        'account-scoped data must never be read without knowing which tenant it belongs to.',
    );
  }
  return scope.accountId;
}

/** The active account, or null when there is no scope. For optional reads only. */
export function maybeAccountId(): string | null {
  return storage.getStore()?.accountId ?? null;
}
