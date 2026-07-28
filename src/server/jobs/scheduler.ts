import { db, getNumberSetting, getSiteNumberSetting, nowIso } from '../db/index.js';
import { budgetStatus, BudgetExceededError, installationMonthToDateSpend } from '../ai/budget.js';
import { runInAccount } from '../lib/context.js';
import { withRun, type RunContext } from './runs.js';
import { assessCoverage } from './assessCoverage.js';
import { discoverSources } from './discoverSources.js';
import { scanSource } from './scanSource.js';
import { researchProject } from './researchProject.js';
import type { ProfileRow, ProjectRow, SourceRow } from '../lib/models.js';
import { acquireLease, releaseLease, renewLease, currentLease } from './lease.js';

let running = false;
let timer: NodeJS.Timeout | null = null;

export function isTickRunning() {
  return running;
}

/**
 * One scheduler pass. For each active profile it will, in priority order:
 *   1. assess coverage (and discover sources if the assessment says to)
 *   2. scan sources that are due
 *   3. research tracked projects that are due
 * Every step is gated on remaining budget, so a tick degrades gracefully rather
 * than failing when the cap is hit mid-pass.
 */
/** How long a tick may hold the scheduler lease before it is considered dead. */
const LEASE_TTL_MS = 30 * 60_000;

/**
 * One scheduler pass.
 *
 * Each account is worked separately, inside its own scope and against its own
 * budget, so one tenant exhausting its cap does not stop the others and no run
 * ever spans two accounts. Pass `onlyAccountId` to work a single tenant, which
 * is what a manual tick from the UI does.
 */
export async function runTick(
  trigger: 'schedule' | 'manual' = 'schedule',
  onlyAccountId?: string,
) {
  if (running) return { skipped: 'already running' as const };

  // Another container — typically the outgoing one mid-deploy — may still be
  // working. Running concurrently would duplicate paid API calls.
  if (!acquireLease(LEASE_TTL_MS)) {
    const held = currentLease();
    console.log(`[scheduler] skipping tick: another process holds the lease (${held?.holder})`);
    return { skipped: 'locked' as const };
  }

  // The installation ceiling is checked once up front: it bounds every account
  // at once, so there is no point starting any of them.
  const globalCap = getSiteNumberSetting('globalMonthlyBudgetUsd');
  const globalSpent = installationMonthToDateSpend();
  if (globalSpent >= globalCap) {
    releaseLease();
    console.log(
      `[scheduler] skipping tick: installation budget exhausted ($${globalSpent.toFixed(2)} / $${globalCap.toFixed(2)})`,
    );
    return { skipped: 'budget' as const };
  }

  const accounts = (
    onlyAccountId
      ? db.prepare('SELECT id, name FROM accounts WHERE id = ? AND active = 1').all(onlyAccountId)
      : db.prepare('SELECT id, name FROM accounts WHERE active = 1 ORDER BY created_at').all()
  ) as { id: string; name: string }[];

  if (accounts.length === 0) {
    releaseLease();
    return { skipped: 'no accounts' as const };
  }

  running = true;
  // A long pass must not let the lease lapse and invite a second scheduler in.
  const renewal = setInterval(() => renewLease(LEASE_TTL_MS), 60_000);
  try {
    const outcomes = [];
    for (const account of accounts) {
      if (installationMonthToDateSpend() >= globalCap) {
        console.log('[scheduler] installation budget reached; stopping this tick');
        break;
      }
      outcomes.push(await runTickForAccount(account, trigger));
    }
    return { accounts: outcomes.length, outcomes };
  } finally {
    clearInterval(renewal);
    releaseLease();
    running = false;
  }
}

async function runTickForAccount(account: { id: string; name: string }, trigger: 'schedule' | 'manual') {
  return runInAccount(account.id, async () => {
    const status = budgetStatus(account.id);
    if (status.exhausted) {
      console.log(
        `[scheduler] skipping ${account.name}: monthly budget exhausted ` +
          `($${status.monthToDateUsd} / $${status.monthlyCapUsd})`,
      );
      return { accountId: account.id, skipped: 'budget' as const };
    }

    return withRun({ kind: 'tick', trigger, label: 'scheduled pass' }, async (ctx) => {
      const profiles = db
        .prepare('SELECT * FROM profiles WHERE account_id = ? AND active = 1 ORDER BY created_at')
        .all(account.id) as ProfileRow[];

      if (profiles.length === 0) {
        ctx.log('no active profiles; nothing to do');
        return { profiles: 0 };
      }

      for (const profile of profiles) {
        if (!ctx.budget.canSpend()) {
          ctx.log('budget reached; stopping this tick');
          break;
        }
        await processProfile(ctx, profile);
      }
      return { profiles: profiles.length };
    });
  });
}

async function processProfile(ctx: RunContext, profile: ProfileRow) {
  ctx.log(`Working on profile: ${profile.name}`);

  // 1. Coverage assessment
  const assessIntervalHours = getNumberSetting('assessIntervalHours');
  const dueForAssessment =
    !profile.last_assessed_at ||
    Date.now() - Date.parse(profile.last_assessed_at) > assessIntervalHours * 3_600_000;

  const sourceCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sources WHERE profile_id = ? AND status = 'active'`)
      .get(profile.id) as { n: number }
  ).n;

  try {
    if (sourceCount === 0 && !profile.last_assessed_at) {
      // Cold start: go straight to discovery so the first tick produces something.
      ctx.log('First pass for this profile — finding initial sources');
      await discoverSources(ctx, profile, { limit: 14 });
      db.prepare('UPDATE profiles SET last_assessed_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso(),
        nowIso(),
        profile.id,
      );
    } else if (dueForAssessment) {
      await assessCoverage(ctx, profile);
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    ctx.log(`assessment/discovery failed: ${err instanceof Error ? err.message : err}`);
  }

  // Re-read: assessment may have rewritten keywords/jurisdictions.
  const fresh =
    (db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id) as ProfileRow) ?? profile;

  // 2. Scan due sources, best-scoring first.
  const maxSources = getNumberSetting('maxSourcesPerTick');
  const dueSources = db
    .prepare(
      `SELECT * FROM sources
       WHERE profile_id = ? AND status = 'active'
         AND (next_scan_at IS NULL OR next_scan_at <= ?)
       ORDER BY score DESC, IFNULL(last_scanned_at, '') ASC
       LIMIT ?`,
    )
    .all(fresh.id, nowIso(), maxSources) as SourceRow[];

  for (const source of dueSources) {
    if (!ctx.budget.canSpend()) {
      ctx.log('budget reached; skipping remaining sources');
      break;
    }
    try {
      await scanSource(ctx, fresh, source);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      ctx.log(`scan failed for ${source.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Research tracked projects that are due.
  const maxResearch = getNumberSetting('maxResearchPerTick');
  const dueProjects = db
    .prepare(
      `SELECT * FROM projects
       WHERE profile_id = ? AND status = 'tracked'
         AND (next_research_at IS NULL OR next_research_at <= ?)
       ORDER BY IFNULL(last_researched_at, '') ASC, relevance DESC
       LIMIT ?`,
    )
    .all(fresh.id, nowIso(), maxResearch) as ProjectRow[];

  for (const project of dueProjects) {
    if (!ctx.budget.canSpend()) {
      ctx.log('budget reached; skipping remaining research');
      break;
    }
    try {
      await researchProject(ctx, fresh, project);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      ctx.log(`research failed for ${project.name}: ${err instanceof Error ? err.message : err}`);
      // Don't retry a broken project immediately.
      db.prepare(
        `UPDATE projects SET next_research_at = ?, last_researched_at = ? WHERE id = ?`,
      ).run(new Date(Date.now() + 12 * 3_600_000).toISOString(), nowIso(), project.id);
    }
  }
}

export function startScheduler() {
  const minutes = getNumberSetting('tickIntervalMinutes');
  const ms = Math.max(5, minutes) * 60_000;
  console.log(`[scheduler] running every ${minutes} minute(s)`);

  const loop = () => {
    runTick('schedule').catch((err) => console.error('[scheduler] tick threw', err));
  };
  // First pass shortly after boot so a fresh install shows life quickly.
  timer = setTimeout(() => {
    loop();
    timer = setInterval(loop, ms);
  }, 15_000);
}

export function stopScheduler() {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}
