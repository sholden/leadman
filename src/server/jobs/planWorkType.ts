import { db, nowIso } from '../db/index.js';
import { runStructured } from '../ai/client.js';
import { workTypePlanSchema, workTypePlanValidator, type WorkTypePlan } from '../ai/schemas.js';
import type { ProfileRow, WorkTypeRow } from '../lib/models.js';
import type { RunContext } from './runs.js';

const SYSTEM = `You work out how to hunt for one specific kind of construction or design work.

Different specializations surface in completely different places, and getting this
right is the whole game:

- Public capital work (a new school, a courthouse) appears in board agendas, capital
  outlay bills, bond programs, and formal RFQ/RFP portals.
- Public *repair and replacement* work (roofing, HVAC, envelope) usually appears far
  later and in different documents: deferred-maintenance schedules, facility condition
  assessments, insurance/FEMA claims, emergency board resolutions, and small-purchase
  bid boards. It often never gets a press release.
- Private multi-site rollout (a restaurant chain, a car wash chain, a clinic group)
  almost never appears in a procurement portal at all. It surfaces as zoning and
  conditional-use applications, site plan review agendas, building permits, liquor or
  health licence applications, franchise disclosure documents, brokerage and
  build-to-suit announcements, investor calls, and local business press.

Given one work type, describe concretely where its earliest public signals appear and
what those signals look like. Be specific to the work type — generic advice is useless.
Name document types, filing types, and site categories rather than "government websites".

Do not use web search. This is a planning step; reason from what you know.`;

export async function planWorkType(
  ctx: RunContext,
  profile: ProfileRow,
  workType: WorkTypeRow,
): Promise<WorkTypePlan> {
  const prompt = [
    `# Firm context`,
    profile.description.trim(),
    `\nOperating area: within ${profile.radius_miles} miles of ${profile.center_label}.`,
    '',
    `# The work type to plan for`,
    `Name: ${workType.name}`,
    workType.description
      ? `Description from the firm:\n${workType.description}`
      : '(no further description given — infer from the name)',
    '',
    `# Task`,
    `Work out how to find leads for this specific kind of work as early as possible,`,
    `then call submit_plan.`,
  ].join('\n');

  const plan = await runStructured({
    purpose: 'plan_work_type',
    system: SYSTEM,
    prompt,
    toolName: 'submit_plan',
    toolDescription: 'Report how to hunt for this kind of work.',
    inputSchema: workTypePlanSchema,
    validator: workTypePlanValidator,
    budget: ctx.budget,
    research: false, // planning only — no web tools, keeps this cheap
    effort: 'medium',
    // Thinking counts against max_tokens. At 8000 this truncated mid-tool-call on a
    // detailed plan, forcing a validation retry that cost more than the headroom saved.
    maxTokens: 24_000,
  });

  const now = nowIso();
  db.prepare(
    `UPDATE work_types SET keywords = ?, lead_signals = ?, source_strategy = ?,
       exclusions = ?, planned_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    JSON.stringify(plan.keywords),
    JSON.stringify(plan.lead_signals),
    plan.source_strategy,
    plan.exclusions,
    now,
    now,
    workType.id,
  );

  ctx.log(`planned work type "${workType.name}": ${plan.keywords.length} keyword(s), ${plan.lead_signals.length} signal(s)`);
  return plan;
}
