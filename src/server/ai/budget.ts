import { db, getNumberSetting, getSetting, getSiteNumberSetting, newId, nowIso } from '../db/index.js';
import type { NormalizedUsage } from './providers/types.js';
import { priceFor } from '../config.js';
import { currentAccountId } from '../lib/context.js';

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly scope: 'run' | 'month' | 'installation',
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** Local-time YYYY-MM, so the monthly cap lines up with a human calendar month. */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function estimateCost(model: string, usage: NormalizedUsage): number {
  const p = priceFor(model);
  return (
    (usage.inputTokens / 1_000_000) * p.input +
    (usage.outputTokens / 1_000_000) * p.output +
    (usage.cacheReadTokens / 1_000_000) * p.input * 0.1 +
    (usage.cacheWriteTokens / 1_000_000) * p.input * 1.25 +
    usage.webSearchRequests * (p.searchPerRequest ?? 0)
  );
}

/** Month-to-date spend for one account. */
export function monthToDateSpend(accountId = currentAccountId(), key = monthKey()): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE account_id = ? AND month_key = ?',
    )
    .get(accountId, key) as { total: number };
  return row.total;
}

/**
 * Month-to-date spend across every account.
 *
 * Per-account caps bound a tenant but cannot bound the operator: every account
 * bills to the same provider API key, so ten accounts each under their own cap
 * still add up. This is what the installation ceiling is measured against.
 */
export function installationMonthToDateSpend(key = monthKey()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE month_key = ?')
    .get(key) as { total: number };
  return row.total;
}

export function budgetStatus(accountId = currentAccountId()) {
  const monthlyCap = getNumberSetting('monthlyBudgetUsd', accountId);
  const spent = monthToDateSpend(accountId);
  const globalCap = getSiteNumberSetting('globalMonthlyBudgetUsd');
  const globalSpent = installationMonthToDateSpend();
  return {
    month: monthKey(),
    monthlyCapUsd: monthlyCap,
    monthToDateUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, monthlyCap - spent).toFixed(4)),
    perRunCapUsd: getNumberSetting('perRunBudgetUsd', accountId),
    installationCapUsd: globalCap,
    installationMonthToDateUsd: Number(globalSpent.toFixed(4)),
    /** True when this account cannot spend, for either reason. */
    exhausted: spent >= monthlyCap || globalSpent >= globalCap,
    /** Distinguishes "you are out" from "the installation is out". */
    installationExhausted: globalSpent >= globalCap,
  };
}

/**
 * Budget as shown to one account.
 *
 * A tenant needs to know *that* the installation ceiling has stopped their work,
 * but the aggregate spend across every other account is the operator's business,
 * not theirs — so the figures are withheld from anyone but a site admin.
 */
export function visibleBudgetStatus(accountId: string, isSiteAdmin: boolean) {
  const status = budgetStatus(accountId);
  if (isSiteAdmin) return status;
  const { installationCapUsd: _cap, installationMonthToDateUsd: _spent, ...rest } = status;
  return rest;
}

/**
 * Tracks spend for one run and refuses to let it start another model call once
 * either the per-run or the month-to-date ceiling is reached. The check happens
 * *before* each call, so a run can overshoot by at most one call.
 */
export class BudgetGuard {
  private runSpend = 0;
  readonly accountId: string;

  constructor(
    readonly runId: string | null,
    accountId = currentAccountId(),
    private readonly perRunCap = getNumberSetting('perRunBudgetUsd', accountId),
    private readonly monthlyCap = getNumberSetting('monthlyBudgetUsd', accountId),
  ) {
    this.accountId = accountId;
  }

  get spentUsd() {
    return this.runSpend;
  }

  /** Throws if another model call would be over budget. */
  assertCanSpend() {
    if (this.runSpend >= this.perRunCap) {
      throw new BudgetExceededError(
        `Per-run budget of $${this.perRunCap.toFixed(2)} reached (spent $${this.runSpend.toFixed(2)}).`,
        'run',
      );
    }
    const mtd = monthToDateSpend(this.accountId);
    if (mtd >= this.monthlyCap) {
      throw new BudgetExceededError(
        `Monthly budget of $${this.monthlyCap.toFixed(2)} reached (spent $${mtd.toFixed(2)} this month).`,
        'month',
      );
    }
    // Checked last so the more specific message wins when both are hit.
    const globalCap = getSiteNumberSetting('globalMonthlyBudgetUsd');
    const globalSpent = installationMonthToDateSpend();
    if (globalSpent >= globalCap) {
      throw new BudgetExceededError(
        `Installation-wide budget of $${globalCap.toFixed(2)} reached ` +
          `(all accounts have spent $${globalSpent.toFixed(2)} this month).`,
        'installation',
      );
    }
  }

  /**
   * Token allowance to hand the model as a task budget, derived from whatever
   * run/month budget is left. Uses a blended per-token rate because agentic
   * turns are input-dominated (web_fetch pulls whole documents into context).
   * The API requires a minimum of 20,000.
   */
  remainingTokenAllowance(): number {
    const p = priceFor(getSetting('model', this.accountId));
    // Observed mix on real scans is roughly 40:1 input:output, so blend accordingly.
    const blendedPerMillion = p.input * 0.95 + p.output * 0.05;
    const headroomUsd = Math.max(
      0,
      Math.min(
        this.perRunCap - this.runSpend,
        this.monthlyCap - monthToDateSpend(this.accountId),
        getSiteNumberSetting('globalMonthlyBudgetUsd') - installationMonthToDateSpend(),
      ),
    );
    // A task budget is a ceiling the model paces itself against, not an enforced
    // cap — it can and does overshoot. Measured: a 666k-token budget on a discovery
    // run drew ~900k tokens in a single turn, because server-side web_fetch keeps
    // pulling documents into the same request. Discount to absorb that.
    const OVERSHOOT_ALLOWANCE = 0.65;
    const tokens = Math.floor((headroomUsd / blendedPerMillion) * 1_000_000 * OVERSHOOT_ALLOWANCE);
    return Math.max(20_000, Math.min(tokens, 2_000_000));
  }

  /** Returns true when there is headroom, without throwing. */
  canSpend(): boolean {
    try {
      this.assertCanSpend();
      return true;
    } catch {
      return false;
    }
  }

  record(purpose: string, model: string, usage: NormalizedUsage): number {
    const cost = estimateCost(model, usage);
    this.runSpend += cost;
    db.prepare(
      `INSERT INTO usage_ledger
         (id, account_id, run_id, purpose, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, web_search_requests,
          cost_usd, created_at, month_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      this.accountId,
      this.runId,
      purpose,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.webSearchRequests,
      cost,
      nowIso(),
      monthKey(),
    );
    if (this.runId) {
      db.prepare('UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?').run(cost, this.runId);
    }
    return cost;
  }
}
