import { db, getNumberSetting, getSetting, newId, nowIso } from '../db/index.js';
import { priceFor, WEB_SEARCH_COST_PER_REQUEST } from '../config.js';

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly scope: 'run' | 'month',
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** Local-time YYYY-MM, so the monthly cap lines up with a human calendar month. */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface UsageShape {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export function estimateCost(model: string, usage: UsageShape): number {
  const p = priceFor(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (input / 1_000_000) * p.input +
    (output / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.input * 0.1 +
    (cacheWrite / 1_000_000) * p.input * 1.25 +
    searches * WEB_SEARCH_COST_PER_REQUEST
  );
}

export function monthToDateSpend(key = monthKey()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE month_key = ?')
    .get(key) as { total: number };
  return row.total;
}

export function budgetStatus() {
  const monthlyCap = getNumberSetting('monthlyBudgetUsd');
  const spent = monthToDateSpend();
  return {
    month: monthKey(),
    monthlyCapUsd: monthlyCap,
    monthToDateUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, monthlyCap - spent).toFixed(4)),
    perRunCapUsd: getNumberSetting('perRunBudgetUsd'),
    exhausted: spent >= monthlyCap,
  };
}

/**
 * Tracks spend for one run and refuses to let it start another model call once
 * either the per-run or the month-to-date ceiling is reached. The check happens
 * *before* each call, so a run can overshoot by at most one call.
 */
export class BudgetGuard {
  private runSpend = 0;

  constructor(
    readonly runId: string | null,
    private readonly perRunCap = getNumberSetting('perRunBudgetUsd'),
    private readonly monthlyCap = getNumberSetting('monthlyBudgetUsd'),
  ) {}

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
    const mtd = monthToDateSpend();
    if (mtd >= this.monthlyCap) {
      throw new BudgetExceededError(
        `Monthly budget of $${this.monthlyCap.toFixed(2)} reached (spent $${mtd.toFixed(2)} this month).`,
        'month',
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
    const p = priceFor(getSetting('model'));
    // Observed mix on real scans is roughly 40:1 input:output, so blend accordingly.
    const blendedPerMillion = p.input * 0.95 + p.output * 0.05;
    const headroomUsd = Math.max(
      0,
      Math.min(this.perRunCap - this.runSpend, this.monthlyCap - monthToDateSpend()),
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

  record(purpose: string, model: string, usage: UsageShape): number {
    const cost = estimateCost(model, usage);
    this.runSpend += cost;
    db.prepare(
      `INSERT INTO usage_ledger
         (id, run_id, purpose, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, web_search_requests,
          cost_usd, created_at, month_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      this.runId,
      purpose,
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      usage.server_tool_use?.web_search_requests ?? 0,
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
