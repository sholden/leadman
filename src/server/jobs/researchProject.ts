import { db, newId, nowIso } from '../db/index.js';
import { runStructured } from '../ai/client.js';
import { researchSchema, researchValidator, type ResearchResult } from '../ai/schemas.js';
import { factKey, normalizeUrl } from '../lib/text.js';
import { archiveUrl } from '../lib/archive.js';
import type { ProfileRow, ProjectRow } from '../lib/models.js';
import type { RunContext } from './runs.js';

const SYSTEM = `You are a researcher for an architecture firm that is actively pursuing a specific
building project. Your job is to find everything useful about it that the firm does
not already know.

Go looking beyond the source it was originally found in:
  - the owner's own website, board packets, and capital plans
  - state/local procurement portals for the matching solicitation
  - local news and business press
  - permit records
  - the owner's meeting agendas and minutes

Prioritise, in order:
  1. Timeline — RFQ/RFP dates, submission deadlines, board votes, bid opening,
     notice to proceed, target completion.
  2. Budget — appropriated amount, bond source, construction vs. total project cost.
  3. Involved companies — owner's rep, program manager, engineers, CM/GC, and any
     architect already selected (that last one matters a great deal: it tells the
     firm whether the job is still available).
  4. Named contacts — owner project manager, procurement officer, facilities
     director, with title and public contact details where published.
  5. Project details — square footage, site, scope, delivery method.

Rules:
- Every fact must have a source_url you actually read. No inference presented as fact.
- Do not repeat facts already listed as known unless the value has CHANGED — if it
  changed, report the new value and say so in the detail field.
- Only report public professional contact information published by the organization.
  Never report personal addresses, personal phone numbers, or private details.
- If you find nothing new, set no_new_information to true and return empty arrays.
  That is a perfectly good outcome; do not pad.`;

export interface ResearchOutcome {
  factsAdded: number;
  documentsArchived: number;
  changed: boolean;
}

export async function researchProject(
  ctx: RunContext,
  profile: ProfileRow,
  project: ProjectRow,
): Promise<ResearchOutcome> {
  const knownFacts = db
    .prepare(
      `SELECT category, label, value FROM project_facts
       WHERE project_id = ? AND superseded = 0 ORDER BY category, label`,
    )
    .all(project.id) as { category: string; label: string; value: string }[];

  const knownSources = db
    .prepare('SELECT url, title FROM project_sources WHERE project_id = ? ORDER BY found_at')
    .all(project.id) as { url: string; title: string }[];

  const prompt = [
    `# Project under investigation`,
    `Name: ${project.name}`,
    project.project_type ? `Type: ${project.project_type}` : '',
    project.jurisdiction ? `Jurisdiction: ${project.jurisdiction}` : '',
    project.address ? `Address: ${project.address}` : '',
    project.owner_org ? `Owner: ${project.owner_org}` : '',
    project.stage ? `Known stage: ${project.stage}` : '',
    project.estimated_value ? `Known value: ${project.estimated_value}` : '',
    project.timeline_note ? `Known timeline: ${project.timeline_note}` : '',
    '',
    `Summary so far: ${project.summary || '(none)'}`,
    '',
    `# Geography`,
    `The firm works within ${profile.radius_miles} miles of ${profile.center_label}.`,
    '',
    `# Already known — do not re-report unchanged`,
    knownFacts.length
      ? knownFacts.map((f) => `- [${f.category}] ${f.label}: ${f.value}`).join('\n')
      : '(nothing recorded yet)',
    '',
    `# Documents already reviewed`,
    knownSources.length
      ? knownSources.map((s) => `- ${s.title || '(untitled)'} — ${s.url}`).join('\n')
      : '(none)',
    '',
    `# Task`,
    `Research this project and call submit_research with what is genuinely new.`,
  ]
    .filter(Boolean)
    .join('\n');

  ctx.step(`Researching ${project.name}`);

  const result = await runStructured({
    purpose: 'research_project',
    system: SYSTEM,
    prompt,
    toolName: 'submit_research',
    toolDescription: 'Report new findings about this project.',
    inputSchema: researchSchema,
    validator: researchValidator,
    budget: ctx.budget,
    research: true,
  });

  return applyResearch(ctx, project, result);
}

/** Exported for testing; called by researchProject above. */
export async function applyResearch(
  ctx: RunContext,
  project: ProjectRow,
  result: ResearchResult,
): Promise<ResearchOutcome> {
  const now = nowIso();
  const changedFields: string[] = [];

  const setIfBetter = (
    column: keyof ProjectRow,
    incoming: string,
    current: string,
    label: string,
  ) => {
    const v = incoming.trim();
    if (!v || v === current) return;
    db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(v, project.id);
    changedFields.push(current ? `${label}: "${current}" → "${v}"` : `${label}: ${v}`);
  };

  setIfBetter('stage', result.stage, project.stage, 'Stage');
  setIfBetter('estimated_value', result.estimated_value, project.estimated_value, 'Value');
  setIfBetter('timeline_note', result.timeline_note, project.timeline_note, 'Timeline');
  setIfBetter('owner_org', result.owner_org, project.owner_org, 'Owner');
  setIfBetter('address', result.address, project.address, 'Address');
  if (result.summary_update.trim() && result.summary_update.trim() !== project.summary) {
    db.prepare('UPDATE projects SET summary = ? WHERE id = ?').run(
      result.summary_update.trim(),
      project.id,
    );
  }

  // Archive documents first so facts can point at a stored artifact.
  const artifactByUrl = new Map<string, string>();
  let documentsArchived = 0;
  for (const doc of result.documents.slice(0, 20)) {
    const url = normalizeUrl(doc.url);
    if (!url) continue;
    const psId = newId();
    const ins = db
      .prepare(
        `INSERT INTO project_sources (id, project_id, source_id, url, title, excerpt, kind, found_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'research', ?)
         ON CONFLICT (project_id, url) DO NOTHING`,
      )
      .run(psId, project.id, url, doc.title.slice(0, 300), doc.excerpt.slice(0, 2000), now);

    const artifactId = await archiveUrl({
      url,
      projectId: project.id,
      projectSourceId: ins.changes > 0 ? psId : null,
      fallbackTitle: doc.title,
      fallbackText: doc.excerpt,
    });
    if (artifactId) artifactByUrl.set(url, artifactId);
    if (ins.changes > 0) documentsArchived++;
  }

  const insertFact = db.prepare(
    `INSERT INTO project_facts
       (id, project_id, category, label, value, detail, source_url, artifact_id,
        confidence, fact_key, superseded, found_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  const supersede = db.prepare(
    `UPDATE project_facts SET superseded = 1
     WHERE project_id = ? AND fact_key = ? AND superseded = 0 AND value != ?`,
  );
  const existingSame = db.prepare(
    `SELECT id FROM project_facts
     WHERE project_id = ? AND fact_key = ? AND value = ? AND superseded = 0`,
  );

  let factsAdded = 0;
  const newFactLines: string[] = [];

  const applyFacts = db.transaction((facts: ResearchResult['facts']) => {
    for (const f of facts) {
      const key = factKey(f.category, f.label);
      if (existingSame.get(project.id, key, f.value)) continue; // already known, unchanged
      supersede.run(project.id, key, f.value);
      insertFact.run(
        newId(),
        project.id,
        f.category,
        f.label.slice(0, 200),
        f.value.slice(0, 1000),
        f.detail.slice(0, 2000),
        normalizeUrl(f.source_url),
        artifactByUrl.get(normalizeUrl(f.source_url)) ?? null,
        f.confidence,
        key,
        now,
      );
      factsAdded++;
      newFactLines.push(`[${f.category}] ${f.label}: ${f.value}`);
    }
  });
  applyFacts(result.facts.filter((f) => f.confidence >= 40));

  const changed = factsAdded > 0 || documentsArchived > 0 || changedFields.length > 0;

  if (changed) {
    const parts = [
      factsAdded ? `${factsAdded} new fact${factsAdded === 1 ? '' : 's'}` : '',
      documentsArchived ? `${documentsArchived} new document${documentsArchived === 1 ? '' : 's'}` : '',
      changedFields.length ? `${changedFields.length} field update${changedFields.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    db.prepare(
      `INSERT INTO project_updates (id, project_id, run_id, kind, summary, detail, created_at)
       VALUES (?, ?, ?, 'new_facts', ?, ?, ?)`,
    ).run(
      newId(),
      project.id,
      ctx.runId,
      `Research found ${parts.join(', ')}`,
      [...changedFields, ...newFactLines].join('\n').slice(0, 4000),
      now,
    );
  }

  // Research more often while a project is actively moving, less often when quiet.
  const interval = changed
    ? Math.max(24, project.research_interval_hours * 0.7)
    : Math.min(336, project.research_interval_hours * 1.5);

  db.prepare(
    `UPDATE projects SET last_researched_at = ?, next_research_at = ?,
       research_interval_hours = ?, last_updated_at = ? WHERE id = ?`,
  ).run(
    now,
    new Date(Date.now() + interval * 3_600_000).toISOString(),
    interval,
    changed ? now : project.last_updated_at,
    project.id,
  );

  ctx.count({ facts_added: factsAdded });
  if (changed) {
    ctx.result(
      `${project.name}: ${factsAdded} new fact(s), ${documentsArchived} document(s) archived` +
        (changedFields.length ? `, ${changedFields.length} field update(s)` : ''),
      { projectId: project.id, detail: [...changedFields, ...newFactLines].join('\n') },
    );
  } else {
    ctx.log(`${project.name}: nothing new found this pass`, { projectId: project.id });
  }

  return { factsAdded, documentsArchived, changed };
}
