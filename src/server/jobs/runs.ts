import { db, newId, nowIso } from '../db/index.js';
import { BudgetGuard, BudgetExceededError } from '../ai/budget.js';
import { reportRuntimeFailure } from '../ai/credentials.js';

export type RunKind = 'tick' | 'discovery' | 'assessment' | 'scan' | 'research' | 'plan';

export interface EventRefs {
  sourceId?: string | null;
  projectId?: string | null;
  workTypeId?: string | null;
  detail?: string;
}

export interface RunContext {
  runId: string;
  budget: BudgetGuard;
  /** Append a timestamped line to the run's timeline. Written immediately. */
  log: (message: string, refs?: EventRefs) => void;
  /** Record something the run produced — highlighted in the activity view. */
  result: (message: string, refs?: EventRefs) => void;
  /** Set what the run is doing right now, visible while it is still running. */
  step: (message: string) => void;
  /** Increment the run's outcome counters. */
  count: (counts: Partial<Record<'sources_added' | 'sources_scanned' | 'projects_found' | 'facts_added', number>>) => void;
  lines: string[];
}

const insertEvent = () =>
  db.prepare(
    `INSERT INTO run_events (id, run_id, seq, at, level, message, detail, source_id, project_id, work_type_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

export function startRun(opts: {
  kind: RunKind;
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
  let seq = 0;
  const stmt = insertEvent();

  const emit = (level: 'info' | 'result' | 'warn' | 'error', message: string, refs?: EventRefs) => {
    lines.push(message);
    // Written straight through rather than buffered, so a run in progress is
    // visible in the UI instead of appearing only once it finishes.
    stmt.run(
      newId(),
      runId,
      seq++,
      nowIso(),
      level,
      message.slice(0, 2000),
      (refs?.detail ?? '').slice(0, 8000),
      refs?.sourceId ?? null,
      refs?.projectId ?? null,
      refs?.workTypeId ?? null,
    );
    const tag = level === 'result' ? '✓' : level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
    console.log(`[run ${runId.slice(0, 8)}] ${tag} ${message}`);
  };

  return {
    runId,
    budget: new BudgetGuard(runId),
    lines,
    log: (message, refs) => emit('info', message, refs),
    result: (message, refs) => emit('result', message, refs),
    step: (message) => {
      db.prepare('UPDATE runs SET current_step = ? WHERE id = ?').run(message.slice(0, 300), runId);
      emit('info', message);
    },
    count: (counts) => {
      const sets = Object.entries(counts)
        .filter(([, v]) => typeof v === 'number' && v !== 0)
        .map(([k, v]) => `${k} = ${k} + ${Number(v)}`);
      if (sets.length) db.exec(`UPDATE runs SET ${sets.join(', ')} WHERE id = '${runId}'`);
    },
  };
}

export function finishRun(ctx: RunContext, status: 'ok' | 'error' | 'budget_stopped', error = '') {
  db.prepare(
    `UPDATE runs SET status = ?, summary = ?, error = ?, current_step = '', finished_at = ? WHERE id = ?`,
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
    // Surface billing/auth failures on the dashboard rather than burying them in
    // a run log — they block everything and only the user can fix them.
    reportRuntimeFailure(err);
    ctx.log(`error: ${message}`);
    finishRun(ctx, 'error', message);
    return { runId: ctx.runId, result: null, status: 'error', error: message };
  }
}

/** Clears runs left 'running' by a crash or restart, so the view isn't misleading. */
export function reconcileOrphanedRuns() {
  const orphans = db
    .prepare("SELECT id FROM runs WHERE status = 'running'")
    .all() as { id: string }[];
  if (orphans.length === 0) return;
  db.prepare(
    `UPDATE runs SET status = 'error', error = 'Interrupted — the server restarted while this run was in progress.',
       current_step = '', finished_at = ? WHERE status = 'running'`,
  ).run(nowIso());
  console.log(`[runs] marked ${orphans.length} interrupted run(s) from a previous process`);
}
