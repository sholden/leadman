import { db, getNumberSetting, nowIso } from '../db/index.js';
import { runStructured } from '../ai/client.js';
import { assessmentSchema, assessmentValidator, type AssessmentResult } from '../ai/schemas.js';
import { boundingBox } from '../lib/geo.js';
import type { ProfileRow, SourceRow } from '../lib/models.js';
import type { RunContext } from './runs.js';
import { discoverSources } from './discoverSources.js';
import { coverageByWorkType, leastCoveredWorkType } from './workTypes.js';

const SYSTEM = `You audit the lead-source coverage of an architecture firm's project-finding system.

You are given the firm's profile, its search geography, and every source currently
monitored with its measured yield. Judge whether the source set is adequate:

- "adequate" — the important jurisdictions and source types in range are covered,
  and the productive sources are still producing.
- "needs_more_sources" — there are real gaps: a jurisdiction with no coverage, a
  source type (procurement portal, school board, permits) missing, or too few
  sources overall to see the market.
- "needs_pruning" — coverage is broad but several sources are dead weight.

Be concrete. A gap is "no coverage of West Baton Rouge Parish school board agendas",
not "could use more sources". Use web_search sparingly, only to confirm which
jurisdictions exist in the area if you are unsure.

Only recommend retiring a source when the evidence supports it: many scans with no
finds, or repeated errors. A brand-new source with zero scans is not dead weight.`;

export async function assessCoverage(
  ctx: RunContext,
  profile: ProfileRow,
): Promise<AssessmentResult> {
  const sources = db
    .prepare(
      `SELECT * FROM sources WHERE profile_id = ? AND status IN ('active','candidate','paused')
       ORDER BY score DESC`,
    )
    .all(profile.id) as SourceRow[];

  const box = boundingBox(profile.center_lat, profile.center_lng, profile.radius_miles);
  const projectCount = (
    db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE profile_id = ?')
      .get(profile.id) as { n: number }
  ).n;

  const coverage = coverageByWorkType(profile.id);
  const coverageBlock = coverage.length
    ? [
        `# Coverage per work type (this is the thing to judge)`,
        ...coverage.map(
          (c) =>
            `- ${c.workType.key} — "${c.workType.name}": ${c.activeSources} active source(s), ` +
            `${c.projectsFound} project(s) found to date.` +
            (c.workType.source_strategy
              ? `\n    expected to surface via: ${c.workType.source_strategy.replace(/\s+/g, ' ').trim().slice(0, 300)}`
              : ''),
        ),
        '',
        `A work type with few or no sources is the most important gap, even if the`,
        `profile overall looks well covered. Say which work type each gap belongs to.`,
        '',
      ].join('\n')
    : '';

  const sourceLines = sources.length
    ? sources
        .map(
          (s) =>
            `- id=${s.id} | ${s.name} | kind=${s.kind} | jurisdiction=${s.jurisdiction || '?'} | ` +
            `status=${s.status} | scans=${s.total_scans} | projects_found=${s.total_projects_found} | ` +
            `empty_streak=${s.consecutive_empty_scans} | last_error=${s.last_error ? s.last_error.slice(0, 120) : 'none'} | ${s.url}`,
        )
        .join('\n')
    : '(no sources configured yet)';

  const prompt = [
    `# Firm profile`,
    profile.description.trim(),
    '',
    `# Search area`,
    `Center: ${profile.center_label} (${profile.center_lat.toFixed(4)}, ${profile.center_lng.toFixed(4)}), radius ${profile.radius_miles} miles.`,
    `Bounding box: N ${box.north.toFixed(3)}, S ${box.south.toFixed(3)}, E ${box.east.toFixed(3)}, W ${box.west.toFixed(3)}.`,
    '',
    coverageBlock,
    `# Current sources (${sources.length})`,
    sourceLines,
    '',
    `# Outcomes so far`,
    `${projectCount} project(s) discovered to date across all sources.`,
    '',
    `# Task`,
    `Assess coverage and call submit_assessment. Include the refined keyword list and the full`,
    `list of jurisdictions inside the radius — both are reused elsewhere in the system.`,
  ].join('\n');

  ctx.step(`Reviewing coverage across ${sources.length} source(s)`);

  const result = await runStructured({
    purpose: 'assess_coverage',
    system: SYSTEM,
    prompt,
    toolName: 'submit_assessment',
    toolDescription: 'Report your coverage assessment.',
    inputSchema: assessmentSchema,
    validator: assessmentValidator,
    budget: ctx.budget,
    research: true,
    effort: 'medium',
  });

  const now = nowIso();
  db.prepare(
    `UPDATE profiles SET keywords = ?, jurisdictions = ?, last_assessed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    JSON.stringify(result.keywords),
    JSON.stringify(result.jurisdictions),
    now,
    now,
    profile.id,
  );

  const validIds = new Set(sources.map((s) => s.id));
  let retired = 0;
  for (const r of result.sources_to_retire) {
    if (!validIds.has(r.source_id)) continue;
    db.prepare(
      `UPDATE sources SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ? AND origin = 'ai'`,
    ).run(`retired by assessment: ${r.reason}`.slice(0, 400), now, r.source_id);
    retired++;
  }

  ctx.result(
    `Coverage verdict: ${result.verdict.replace(/_/g, ' ')} — ${result.coverage_gaps.length} gap(s) found` +
      (retired ? `, ${retired} source(s) retired` : ''),
    { detail: `${result.reasoning}\n\nGaps:\n${result.coverage_gaps.map((g) => `- ${g}`).join('\n')}` },
  );

  // Close the loop: if the audit says we are short on sources, go find them now.
  const activeCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sources WHERE profile_id = ? AND status = 'active'`)
      .get(profile.id) as { n: number }
  ).n;
  const target = getNumberSetting('targetActiveSources');

  if (
    (result.verdict === 'needs_more_sources' || activeCount < target) &&
    ctx.budget.canSpend()
  ) {
    const refreshed = {
      ...profile,
      keywords: JSON.stringify(result.keywords),
      jurisdictions: JSON.stringify(result.jurisdictions),
    };
    const hints = [...result.coverage_gaps, ...result.suggested_searches].slice(0, 12);

    // With specializations configured, aim the pass at the one that is starved
    // rather than adding more of whatever is already well covered.
    const perTypeTarget = coverage.length
      ? Math.max(3, Math.ceil(target / coverage.length))
      : target;
    const starved = leastCoveredWorkType(profile.id, perTypeTarget);
    ctx.log(
      starved
        ? `Gaps found — hunting for sources to cover "${starved.name}"`
        : 'Gaps found — hunting for more sources',
      { workTypeId: starved?.id ?? null },
    );

    await discoverSources(ctx, refreshed, {
      hints,
      workType: starved,
      limit: Math.max(4, Math.min(15, target - activeCount + 4)),
    });
  }

  return result;
}
