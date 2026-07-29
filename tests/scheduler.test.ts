import { afterEach, describe, expect, it } from 'vitest';
import { db, migrate, getSiteSetting, setSiteSetting } from '../src/server/db/index.js';
import { runTick, startScheduler, stopScheduler } from '../src/server/jobs/scheduler.js';
import { setAmbientAccount } from '../src/server/lib/context.js';
import { makeAccount, primaryAccountId, useAccount } from './helpers.js';

migrate();
useAccount();

/**
 * The scheduler at boot, when nothing has established an account scope.
 *
 * This is the one code path the rest of the suite cannot reach: `tests/setup.ts`
 * sets LEADMAN_SCHEDULER=off, so `startScheduler()` never ran in a test, and it
 * read a per-account setting with no account in scope. That threw inside the
 * `app.listen` callback, became an unhandled rejection, killed the process, and
 * served 502s from a server that was otherwise completely healthy.
 *
 * Each test here clears the ambient account first, because leaving it set would
 * paper over exactly the condition being tested.
 */
afterEach(() => {
  stopScheduler();
  setAmbientAccount(primaryAccountId());
});

describe('starting the scheduler', () => {
  it('starts with no account scope at all', () => {
    setAmbientAccount(null);
    // Boot order: nothing has run a request or a job yet.
    expect(() => startScheduler()).not.toThrow();
  });

  it('reads its cadence from installation settings, not an account', () => {
    setAmbientAccount(null);
    setSiteSetting('tickIntervalMinutes', '17');
    expect(() => startScheduler()).not.toThrow();
    expect(getSiteSetting('tickIntervalMinutes')).toBe('17');
    // Nothing per-account should carry this key any more; there is one loop.
    const strays = db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'tickIntervalMinutes'")
      .get() as { n: number };
    expect(strays.n).toBe(0);
  });

  it('does not schedule anything once stopped', () => {
    setAmbientAccount(null);
    startScheduler();
    expect(() => stopScheduler()).not.toThrow();
  });
});

describe('running a tick', () => {
  it('runs with no ambient scope, establishing one per account', async () => {
    setAmbientAccount(null);
    const other = makeAccount('Tick Co');

    // No profiles anywhere, so every account short-circuits without spending.
    const outcome = await runTick('manual');
    expect(outcome).toBeTruthy();

    // One run row per active account, each attributed to that account.
    const runs = db
      .prepare("SELECT account_id, kind FROM runs WHERE kind = 'tick'")
      .all() as { account_id: string; kind: string }[];
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => Boolean(r.account_id))).toBe(true);
    expect(runs.some((r) => r.account_id === other)).toBe(true);
  });

  it('works one account when given one, leaving the others alone', async () => {
    setAmbientAccount(null);
    db.exec("DELETE FROM runs WHERE kind = 'tick'");
    const other = makeAccount('Solo Co');

    await runTick('manual', other);

    const runs = db
      .prepare("SELECT DISTINCT account_id FROM runs WHERE kind = 'tick'")
      .all() as { account_id: string }[];
    expect(runs).toEqual([{ account_id: other }]);
  });

  it('skips everything when the installation ceiling is spent', async () => {
    setAmbientAccount(null);
    db.exec("DELETE FROM runs WHERE kind = 'tick'");
    const previous = getSiteSetting('globalMonthlyBudgetUsd');
    setSiteSetting('globalMonthlyBudgetUsd', '0');
    try {
      const outcome = await runTick('manual');
      expect(outcome).toEqual({ skipped: 'budget' });
      // Nothing should have been started, not even a run row.
      const runs = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'tick'").get() as {
        n: number;
      };
      expect(runs.n).toBe(0);
    } finally {
      setSiteSetting('globalMonthlyBudgetUsd', previous);
    }
  });
});
