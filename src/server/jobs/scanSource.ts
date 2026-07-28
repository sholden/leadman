import { db, getNumberSetting, newId, nowIso } from '../db/index.js';
import { runStructured } from '../ai/client.js';
import {
  scanSchema,
  scanValidator,
  matchSchema,
  matchValidator,
  type ScanResult,
} from '../ai/schemas.js';
import { matchKey, similarity, normalizeUrl } from '../lib/text.js';
import { archiveUrl } from '../lib/archive.js';
import { parseJsonArray, type ProfileRow, type ProjectRow, type SourceRow, type WorkTypeRow } from '../lib/models.js';
import { activeWorkTypes, workTypesForSource } from './workTypes.js';
import type { RunContext } from './runs.js';

const SCAN_SYSTEM = `You scan one web page for a design or construction firm and extract upcoming or
in-progress work from it.

Method:
1. Fetch the given source URL with web_fetch.
2. If it is an index/listing page, follow the most recent items (typically the last
   60-90 days, up to ~8 documents) and read those too.
3. Extract every distinct opportunity that matches one of the firm's work types.
   Include planning-stage items — early is the point.

Rules:
- Only report projects you can point to a quote for. Never infer a project that is
  not described on a page you actually read.
- One entry per project, not one per mention. Merge duplicates across documents.
- **Classify every project into exactly one work type** using the keys given below,
  and set work_type_key to that key. The work types define what this firm cares
  about: a roofing specialist does not want a new-gymnasium lead, and a firm tracking
  a restaurant chain's rollout does not want a school project.
- If something is clearly construction work but matches none of the listed work
  types, set work_type_key to "" and score relevance low. Do not stretch a project
  to fit a work type it does not belong to.
- Respect each work type's stated exclusions.
- Score relevance against the matched work type and the firm profile honestly.
- If the page will not load or is not what it claims to be, say so via source_health
  and return an empty projects array.`;

const MATCH_SYSTEM = `You decide whether newly-found project candidates are the same project as any
already in the database.

Two entries are the same project when they describe the same physical work by the
same owner at the same site, even if the names differ ("New Central Fire Station"
vs "Fire Station No. 3 Replacement"). Different phases of one program are the SAME
project only if they describe the same scope; distinct phases with distinct scopes
are different projects.

When unsure, treat it as new — a duplicate is easier to merge later than a wrongly
merged pair is to split.`;

export interface ScanOutcome {
  scanId: string;
  candidates: number;
  created: number;
  matched: number;
  health: ScanResult['source_health'];
}

export async function scanSource(
  ctx: RunContext,
  profile: ProfileRow,
  source: SourceRow,
): Promise<ScanOutcome> {
  const scanId = newId();
  const startedAt = nowIso();
  db.prepare(
    `INSERT INTO source_scans (id, source_id, run_id, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
  ).run(scanId, source.id, ctx.runId, startedAt);

  const allTypes = activeWorkTypes(profile.id);
  const servedTypes = workTypesForSource(source.id);
  // Prefer the specializations this source was chosen for; fall back to all of them.
  const relevantTypes = servedTypes.length > 0 ? servedTypes : allTypes;

  const workTypeBlock = relevantTypes.length
    ? [
        `# Work types to classify against`,
        ...relevantTypes.map((t) => {
          const lines = [`- key: ${t.key}`, `  name: ${t.name}`];
          if (t.description) lines.push(`  what counts: ${t.description.replace(/\s+/g, ' ').trim()}`);
          const signals = parseJsonArray(t.lead_signals);
          if (signals.length) lines.push(`  early signals: ${signals.slice(0, 6).join('; ')}`);
          const kw = parseJsonArray(t.keywords);
          if (kw.length) lines.push(`  keywords: ${kw.slice(0, 20).join(', ')}`);
          if (t.exclusions) lines.push(`  does NOT include: ${t.exclusions.replace(/\s+/g, ' ').trim()}`);
          return lines.join('\n');
        }),
        servedTypes.length > 0 && servedTypes.length < allTypes.length
          ? `\nThis source was selected to cover the work types above. If you find something matching a different specialization, still report it with work_type_key "".`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const keywords = parseJsonArray(profile.keywords);
  const lastScan = source.last_scanned_at
    ? `This source was last scanned on ${source.last_scanned_at}. Focus on items published since then.`
    : `This source has not been scanned before. Cover roughly the last 90 days.`;

  const known = db
    .prepare(
      `SELECT p.name FROM projects p
       JOIN project_sources ps ON ps.project_id = p.id
       WHERE ps.source_id = ? ORDER BY p.last_updated_at DESC LIMIT 40`,
    )
    .all(source.id) as { name: string }[];

  const prompt = [
    `# Firm profile`,
    profile.description.trim(),
    keywords.length ? `\nKeywords: ${keywords.join(', ')}` : '',
    `\nSearch area: within ${profile.radius_miles} miles of ${profile.center_label}.`,
    '',
    workTypeBlock,
    '',
    `# Source to scan`,
    `Name: ${source.name}`,
    `URL: ${source.url}`,
    `Type: ${source.kind}`,
    source.jurisdiction ? `Jurisdiction: ${source.jurisdiction}` : '',
    source.description ? `Notes: ${source.description}` : '',
    '',
    lastScan,
    '',
    known.length
      ? `# Projects already recorded from this source\n${known.map((k) => `- ${k.name}`).join('\n')}\n\nStill report these if they appear with new information, but prefer surfacing items not on this list.`
      : '',
    '',
    `# Task`,
    `Read the source, extract the projects, then call submit_scan.`,
  ]
    .filter(Boolean)
    .join('\n');

  ctx.step(`Scanning ${source.name}`);

  let result: ScanResult;
  try {
    result = await runStructured({
      purpose: `scan:${source.kind}`,
      system: SCAN_SYSTEM,
      prompt,
      toolName: 'submit_scan',
      toolDescription: 'Report what this scan found.',
      inputSchema: scanSchema,
      validator: scanValidator,
      budget: ctx.budget,
      research: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE source_scans SET status = 'error', finished_at = ?, notes = ? WHERE id = ?`,
    ).run(nowIso(), message.slice(0, 500), scanId);
    db.prepare(`UPDATE sources SET last_error = ?, updated_at = ? WHERE id = ?`).run(
      message.slice(0, 400),
      nowIso(),
      source.id,
    );
    throw err;
  }

  const minRelevance = getNumberSetting('minRelevance');
  const typeByKey = new Map(allTypes.map((t) => [t.key, t]));

  let unclassified = 0;
  const candidates = result.projects.filter((p) => {
    if (p.name.trim().length <= 2) return false;
    if (p.relevance < minRelevance || p.confidence < 40) return false;
    // Once the firm has declared its specializations, anything matching none of
    // them is out of scope by definition — that is the whole point of work types.
    if (allTypes.length > 0 && !typeByKey.has(p.work_type_key)) {
      unclassified++;
      return false;
    }
    return true;
  });

  const { created, matched } = await ingestCandidates(ctx, profile, source, candidates, typeByKey);

  const note = unclassified
    ? `${result.notes} [${unclassified} project(s) dropped: matched no configured work type]`
    : result.notes;
  finalizeScan(scanId, source, { ...result, notes: note }, candidates.length, created, matched);

  ctx.count({ sources_scanned: 1, projects_found: created });
  ctx.log(
    `Scanned ${source.name}: ${result.projects.length} item(s) found, ` +
      `${candidates.length} in scope${unclassified ? `, ${unclassified} off-specialization` : ''} ` +
      `→ ${created} new, ${matched} already known`,
    { sourceId: source.id, detail: result.notes },
  );

  return {
    scanId,
    candidates: candidates.length,
    created,
    matched,
    health: result.source_health,
  };
}

/* ------------------------------------------------------------------ */

/** Exported for testing; called by scanSource above. */
export async function ingestCandidates(
  ctx: RunContext,
  profile: ProfileRow,
  source: SourceRow,
  candidates: ScanResult['projects'],
  typeByKey: Map<string, WorkTypeRow> = new Map(),
): Promise<{ created: number; matched: number }> {
  if (candidates.length === 0) return { created: 0, matched: 0 };

  const existing = db
    .prepare(
      `SELECT id, name, summary, jurisdiction, address, project_type, status
       FROM projects WHERE profile_id = ? AND status != 'rejected'`,
    )
    .all(profile.id) as Pick<
    ProjectRow,
    'id' | 'name' | 'summary' | 'jurisdiction' | 'address' | 'project_type' | 'status'
  >[];

  // Cheap shortlist first so we only pay for a match call when it's genuinely ambiguous.
  const shortlists = candidates.map((c) =>
    existing
      .map((e) => ({ e, score: scoreOverlap(c, e) }))
      .filter((x) => x.score >= 0.28)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => x.e),
  );

  const resolved = new Map<number, string>(); // candidate index -> existing project id
  const ambiguous = candidates
    .map((_, i) => i)
    .filter((i) => shortlists[i].length > 0);

  if (ambiguous.length > 0 && ctx.budget.canSpend()) {
    const lines = ambiguous.map((i) => {
      const c = candidates[i];
      const opts = shortlists[i]
        .map(
          (e) =>
            `    * id=${e.id} | ${e.name} | ${e.project_type || '?'} | ${e.jurisdiction || '?'} | ${e.address || '?'} | ${e.summary.slice(0, 180)}`,
        )
        .join('\n');
      return [
        `- candidate_index=${i}`,
        `  name: ${c.name}`,
        `  type: ${c.project_type || '?'} | jurisdiction: ${c.jurisdiction || '?'} | address: ${c.address || '?'} | owner: ${c.owner_org || '?'}`,
        `  summary: ${c.summary.slice(0, 300)}`,
        `  possible existing matches:`,
        opts,
      ].join('\n');
    });

    try {
      const match = await runStructured({
        purpose: 'match_projects',
        system: MATCH_SYSTEM,
        prompt: [
          `Decide, for each candidate below, whether it duplicates one of its listed existing projects.`,
          `Return exactly one entry per candidate_index shown. Use "" for existing_project_id when new.`,
          '',
          lines.join('\n\n'),
        ].join('\n'),
        toolName: 'submit_matches',
        toolDescription: 'Report the duplicate decisions.',
        inputSchema: matchSchema,
        validator: matchValidator,
        budget: ctx.budget,
        research: false,
        effort: 'low',
        maxTokens: 16_000,
      });

      const validIds = new Set(existing.map((e) => e.id));
      for (const m of match.matches) {
        if (m.existing_project_id && validIds.has(m.existing_project_id)) {
          resolved.set(m.candidate_index, m.existing_project_id);
        }
      }
    } catch (err) {
      // Matching is an optimization; if it fails, fall back to exact-key dedupe below.
      ctx.log(`match step failed, falling back to key dedupe: ${err instanceof Error ? err.message : err}`);
    }
  }

  let created = 0;
  let matched = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let projectId = resolved.get(i);

    if (!projectId) {
      // Exact normalized-name collision is a duplicate regardless of the model.
      const key = matchKey(c.name);
      const hit = existing.find((e) => matchKey(e.name) === key && key.length > 0);
      if (hit) projectId = hit.id;
    }

    if (projectId) {
      matched += (await attachToProject(ctx, projectId, source, c)) ? 1 : 0;
    } else {
      projectId = await createProject(ctx, profile, source, c, typeByKey.get(c.work_type_key) ?? null);
      existing.push({
        id: projectId,
        name: c.name,
        summary: c.summary,
        jurisdiction: c.jurisdiction,
        address: c.address,
        project_type: c.project_type,
        status: 'discovered',
      });
      created++;
    }
  }

  return { created, matched };
}

function scoreOverlap(
  c: ScanResult['projects'][number],
  e: { name: string; jurisdiction: string; address: string },
): number {
  let s = similarity(c.name, e.name);
  if (c.address && e.address && c.address.toLowerCase() === e.address.toLowerCase()) s += 0.4;
  if (c.jurisdiction && e.jurisdiction && c.jurisdiction.toLowerCase() === e.jurisdiction.toLowerCase()) {
    s += 0.1;
  }
  return s;
}

async function createProject(
  ctx: RunContext,
  profile: ProfileRow,
  source: SourceRow,
  c: ScanResult['projects'][number],
  workType: WorkTypeRow | null,
): Promise<string> {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO projects
       (id, account_id, profile_id, work_type_id, name, match_key, status, summary, project_type, stage, address,
        jurisdiction, owner_org, estimated_value, timeline_note, relevance, confidence,
        first_seen_at, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ctx.accountId,
    profile.id,
    workType?.id ?? null,
    c.name.slice(0, 300),
    matchKey(c.name),
    c.summary,
    c.project_type,
    c.stage,
    c.address,
    c.jurisdiction || source.jurisdiction,
    c.owner_org,
    c.estimated_value,
    c.timeline_note,
    c.relevance,
    c.confidence,
    now,
    now,
  );

  await linkSource(id, source.id, c, 'origin');

  db.prepare(
    `INSERT INTO project_updates (id, project_id, run_id, kind, summary, detail, created_at)
     VALUES (?, ?, ?, 'discovered', ?, ?, ?)`,
  ).run(
    newId(),
    id,
    ctx.runId,
    workType
      ? `Discovered via ${source.name} — ${workType.name}`
      : `Discovered via ${source.name}`,
    c.summary.slice(0, 800),
    now,
  );

  ctx.result(`New lead: ${c.name}`, {
    projectId: id,
    sourceId: source.id,
    workTypeId: workType?.id ?? null,
    detail:
      `${c.summary}\n\n${c.relevance}% fit · ${c.confidence}% confidence` +
      `${workType ? ` · ${workType.name}` : ''}\nEvidence: ${c.evidence_url}`,
  });

  return id;
}

/** Returns true if this attach actually added something new. */
async function attachToProject(
  ctx: RunContext,
  projectId: string,
  source: SourceRow,
  c: ScanResult['projects'][number],
): Promise<boolean> {
  const added = await linkSource(projectId, source.id, c, 'origin');
  const now = nowIso();

  // Fill in blanks on the existing record without overwriting known values.
  db.prepare(
    `UPDATE projects SET
       stage           = CASE WHEN stage = ''           AND ? != '' THEN ? ELSE stage END,
       address         = CASE WHEN address = ''         AND ? != '' THEN ? ELSE address END,
       jurisdiction    = CASE WHEN jurisdiction = ''    AND ? != '' THEN ? ELSE jurisdiction END,
       owner_org       = CASE WHEN owner_org = ''       AND ? != '' THEN ? ELSE owner_org END,
       estimated_value = CASE WHEN estimated_value = '' AND ? != '' THEN ? ELSE estimated_value END,
       timeline_note   = CASE WHEN timeline_note = ''   AND ? != '' THEN ? ELSE timeline_note END,
       last_updated_at = ?
     WHERE id = ?`,
  ).run(
    c.stage, c.stage,
    c.address, c.address,
    c.jurisdiction, c.jurisdiction,
    c.owner_org, c.owner_org,
    c.estimated_value, c.estimated_value,
    c.timeline_note, c.timeline_note,
    now,
    projectId,
  );

  if (added) {
    db.prepare(
      `INSERT INTO project_updates (id, project_id, run_id, kind, summary, detail, created_at)
       VALUES (?, ?, ?, 'new_source', ?, ?, ?)`,
    ).run(
      newId(),
      projectId,
      ctx.runId,
      `Also reported by ${source.name}`,
      c.evidence_quote.slice(0, 800),
      now,
    );
  }
  return added;
}

async function linkSource(
  projectId: string,
  sourceId: string | null,
  c: Pick<ScanResult['projects'][number], 'evidence_url' | 'name' | 'evidence_quote'>,
  kind: 'origin' | 'research',
): Promise<boolean> {
  const url = normalizeUrl(c.evidence_url || '');
  if (!url) return false;

  const psId = newId();
  const info = db
    .prepare(
      `INSERT INTO project_sources (id, project_id, source_id, url, title, excerpt, kind, found_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, url) DO NOTHING`,
    )
    .run(psId, projectId, sourceId, url, c.name.slice(0, 300), c.evidence_quote.slice(0, 2000), kind, nowIso());

  if (info.changes === 0) return false;

  await archiveUrl({
    url,
    projectId,
    projectSourceId: psId,
    sourceId,
    fallbackTitle: c.name,
    fallbackText: c.evidence_quote,
  });
  return true;
}

/* ------------------------------------------------------------------ */

function finalizeScan(
  scanId: string,
  source: SourceRow,
  result: ScanResult,
  candidates: number,
  created: number,
  matched: number,
) {
  const now = nowIso();
  db.prepare(
    `UPDATE source_scans SET status = 'ok', finished_at = ?, candidates_found = ?,
       new_projects = ?, matched_projects = ?, notes = ? WHERE id = ?`,
  ).run(now, candidates, created, matched, result.notes.slice(0, 1000), scanId);

  const productive = created > 0;
  const emptyStreak = productive ? 0 : source.consecutive_empty_scans + 1;

  // Back off sources that keep coming up empty; speed up ones that produce.
  // Bounded between 6 hours and 30 days.
  let interval = source.scan_interval_hours;
  if (productive) interval = Math.max(6, interval * 0.6);
  else if (result.source_health === 'ok') interval = Math.min(720, interval * 1.6);
  else interval = Math.min(720, interval * 2.2);

  // Score is a smoothed hit rate, nudged by whether the page even worked.
  const healthPenalty =
    result.source_health === 'ok' ? 0 : result.source_health === 'empty' ? 5 : 25;
  const target = productive ? 90 : result.source_health === 'ok' ? 45 : 15;
  const score = Math.max(0, Math.min(100, source.score * 0.7 + target * 0.3 - healthPenalty));

  // Give up on a source that never works or has produced nothing in a long while.
  const status =
    result.source_health === 'unreachable' && source.consecutive_empty_scans >= 4
      ? 'dead'
      : emptyStreak >= 12
        ? 'paused'
        : source.status;

  const nextScan = new Date(Date.now() + interval * 3_600_000).toISOString();

  db.prepare(
    `UPDATE sources SET
       status = ?, score = ?, scan_interval_hours = ?, consecutive_empty_scans = ?,
       total_scans = total_scans + 1, total_projects_found = total_projects_found + ?,
       last_scanned_at = ?, next_scan_at = ?,
       last_found_at = CASE WHEN ? > 0 THEN ? ELSE last_found_at END,
       last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    score,
    interval,
    emptyStreak,
    created,
    now,
    nextScan,
    created,
    now,
    result.source_health === 'ok' ? '' : `last scan reported: ${result.source_health}`,
    now,
    source.id,
  );
}
