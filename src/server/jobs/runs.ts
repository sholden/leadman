import { db, newId, nowIso } from '../db/index.js';
import { BudgetGuard, BudgetExceededError } from '../ai/budget.js';

export interface RunContext {
  runId: string;
  budget: BudgetGuard;
  log: (line: string) => void;
  lines: string[];
}

export function startRun(opts: {
  kind: 'tick' | 'discovery' | 'assessment' | 'scan' | 'research';
  profileId?: string | null;
  trigger?: 'schedule' | 'manual';
  label?: string;
}): RunContext {
  const runId = newId();
  db.prepare(
    `INSERT INTO runs (id, profile_id, kind, trigger, status, label, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  ).run(runId, opts.profileId ?? null, opts.kind, opts.trigger ?? 'schedule', opts.label ?? '', nowIso());

  const lines: string[] = [];
  return {
    runId,
    budget: new BudgetGuard(runId),
    lines,
    log: (line: string) => {
      lines.push(line);
      console.log(`[run ${runId.slice(0, 8)}] ${line}`);
    },
  };
}

export function finishRun(ctx: RunContext, status: 'ok' | 'error' | 'budget_stopped', error = '') {
  db.prepare(
    `UPDATE runs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(status, ctx.lines.join('\n'), error, nowIso(), ctx.runId);
}

/** Wraps a job body so budget stops are recorded as such rather than as errors. */
export async function withRun<T>(
  opts: Parameters<typeof startRun>[0],
  body: (ctx: RunContext) => Promise<T>,
): Promise<{ runId: string; result: T | null; status: string; error: string }> {
  const ctx = startRun(opts);
  try {
    const result = await body(ctx);
    finishRun(ctx, 'ok');
    return { runId: ctx.runId, result, status: 'ok', error: '' };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      ctx.log(`stopped: ${err.message}`);
      finishRun(ctx, 'budget_stopped', err.message);
      return { runId: ctx.runId, result: null, status: 'budget_stopped', error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`error: ${message}`);
    finishRun(ctx, 'error', message);
    return { runId: ctx.runId, result: null, status: 'error', error: message };
  }
}
