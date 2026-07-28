import { beforeEach, describe, expect, it } from 'vitest';
import { db, migrate, setSetting } from '../src/server/db/index.js';
import { BudgetGuard, BudgetExceededError, budgetStatus, monthToDateSpend } from '../src/server/ai/budget.js';
import type { NormalizedUsage } from '../src/server/ai/providers/types.js';

migrate();

const usage = (inputTokens: number): NormalizedUsage => ({
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearchRequests: 0,
});

beforeEach(() => {
  db.exec('DELETE FROM usage_ledger');
  setSetting('model', 'claude-opus-5');
  setSetting('monthlyBudgetUsd', '40');
  setSetting('perRunBudgetUsd', '4');
});

describe('per-run cap', () => {
  it('allows calls while there is headroom', () => {
    const guard = new BudgetGuard(null, 4, 40);
    expect(guard.canSpend()).toBe(true);
    guard.record('test', 'claude-opus-5', usage(200_000)); // $1
    expect(guard.canSpend()).toBe(true);
  });

  it('refuses the next call once the run cap is reached', () => {
    const guard = new BudgetGuard(null, 4, 40);
    guard.record('test', 'claude-opus-5', usage(1_000_000)); // $5, over the $4 cap
    expect(guard.canSpend()).toBe(false);
    expect(() => guard.assertCanSpend()).toThrow(BudgetExceededError);
  });

  it('reports the scope so callers can tell run from month', () => {
    const guard = new BudgetGuard(null, 1, 40);
    guard.record('test', 'claude-opus-5', usage(1_000_000));
    try {
      guard.assertCanSpend();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as BudgetExceededError).scope).toBe('run');
    }
  });
});

describe('monthly cap', () => {
  it('blocks a fresh run when the month is already spent', () => {
    // Spend the month on one guard, then start a brand new one.
    new BudgetGuard(null, 100, 10).record('test', 'claude-opus-5', usage(4_000_000)); // $20
    const fresh = new BudgetGuard(null, 100, 10);
    expect(fresh.canSpend()).toBe(false);
    try {
      fresh.assertCanSpend();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as BudgetExceededError).scope).toBe('month');
    }
  });

  it('tracks month-to-date across guards', () => {
    new BudgetGuard(null, 100, 100).record('a', 'claude-opus-5', usage(1_000_000)); // $5
    new BudgetGuard(null, 100, 100).record('b', 'claude-opus-5', usage(1_000_000)); // $5
    expect(monthToDateSpend()).toBeCloseTo(10, 5);
  });
});

describe('ledger', () => {
  it('writes one row per call with the model recorded', () => {
    const guard = new BudgetGuard(null, 100, 100);
    guard.record('scan', 'gpt-5.6-luna', usage(1_000_000));
    const rows = db.prepare('SELECT * FROM usage_ledger').all() as { model: string; purpose: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('gpt-5.6-luna');
    expect(rows[0].purpose).toBe('scan');
  });

  it('accumulates run spend across calls', () => {
    const guard = new BudgetGuard(null, 100, 100);
    guard.record('a', 'claude-opus-5', usage(200_000));
    guard.record('b', 'claude-opus-5', usage(200_000));
    expect(guard.spentUsd).toBeCloseTo(2, 5);
  });
});

describe('task budget allowance', () => {
  it('shrinks as the run spends', () => {
    const guard = new BudgetGuard(null, 4, 40);
    const before = guard.remainingTokenAllowance();
    guard.record('test', 'claude-opus-5', usage(400_000)); // $2
    expect(guard.remainingTokenAllowance()).toBeLessThan(before);
  });

  it('never drops below the API minimum of 20,000', () => {
    const guard = new BudgetGuard(null, 0.001, 0.001);
    expect(guard.remainingTokenAllowance()).toBe(20_000);
  });

  it('is capped so a huge budget cannot produce an absurd request', () => {
    const guard = new BudgetGuard(null, 1e9, 1e9);
    expect(guard.remainingTokenAllowance()).toBeLessThanOrEqual(2_000_000);
  });

  it('is discounted below the naive dollars-to-tokens figure', () => {
    // A task budget is advisory and overshoots; the allowance deliberately
    // under-asks so the overshoot lands nearer the real cap.
    const guard = new BudgetGuard(null, 4, 40);
    const blendedPerMillion = 5 * 0.95 + 25 * 0.05;
    const naive = (4 / blendedPerMillion) * 1_000_000;
    expect(guard.remainingTokenAllowance()).toBeLessThan(naive);
  });
});

describe('budgetStatus', () => {
  it('reports exhaustion once the month cap is hit', () => {
    setSetting('monthlyBudgetUsd', '5');
    expect(budgetStatus().exhausted).toBe(false);
    new BudgetGuard(null, 100, 100).record('x', 'claude-opus-5', usage(2_000_000)); // $10
    expect(budgetStatus().exhausted).toBe(true);
    expect(budgetStatus().remainingUsd).toBe(0);
  });
});
