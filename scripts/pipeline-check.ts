/**
 * Exercises the ingest and research-apply pipelines with fixture data — the real
 * code paths, minus the model calls. Run with: npx tsx scratch/pipeline-check.ts
 */
import { db, migrate, newId, nowIso } from '../src/server/db/index.js';
import { ingestCandidates } from '../src/server/jobs/scanSource.js';
import { applyResearch } from '../src/server/jobs/researchProject.js';
import type { ProfileRow, ProjectRow, SourceRow } from '../src/server/lib/models.js';
import type { ScanResult, ResearchResult } from '../src/server/ai/schemas.js';

migrate();

const check = (label: string, ok: boolean, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`);

// A budget that reports "no headroom" so the optional AI match step is skipped and
// we exercise the deterministic key-dedupe fallback.
const ctx = {
  runId: null as unknown as string,
  budget: { canSpend: () => false, assertCanSpend: () => {}, record: () => 0, spentUsd: 0 } as never,
  lines: [] as string[],
  log: (l: string) => ctx.lines.push(l),
};

const now = nowIso();
const profileId = newId();
db.prepare(
  `INSERT INTO profiles (id, name, description, center_label, center_lat, center_lng, radius_miles, created_at, updated_at)
   VALUES (?, 'fixture', 'fixture profile', 'Baton Rouge', 30.45, -91.19, 60, ?, ?)`,
).run(profileId, now, now);

const sourceId = newId();
db.prepare(
  `INSERT INTO sources (id, profile_id, name, url, kind, jurisdiction, status, created_at, updated_at)
   VALUES (?, ?, 'Fixture Agendas', 'https://example.invalid/agendas', 'meeting_minutes', 'Test Parish', 'active', ?, ?)`,
).run(sourceId, profileId, now, now);

const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as ProfileRow;
const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as SourceRow;

const candidate = (over: Partial<ScanResult['projects'][number]>): ScanResult['projects'][number] => ({
  name: 'Central Fire Station Replacement',
  summary: 'Replacement of the aging central fire station with a three-bay facility.',
  project_type: 'fire station',
  stage: 'planning',
  address: '',
  jurisdiction: 'Test Parish',
  owner_org: 'Test Parish Government',
  estimated_value: '',
  timeline_note: '',
  evidence_url: 'https://example.invalid/agendas/2026-03',
  evidence_quote: 'Council authorized design funding for the central fire station replacement.',
  relevance: 80,
  confidence: 80,
  ...over,
});

// --- 1. First scan creates the project -------------------------------------
const first = await ingestCandidates(ctx as never, profile, source, [
  candidate({}),
  candidate({ name: 'Zachary High School Gymnasium', project_type: 'K-12 school', evidence_url: 'https://example.invalid/agendas/2026-03#b' }),
]);
check('first scan creates both projects', first.created === 2 && first.matched === 0, JSON.stringify(first));

// --- 2. Same project, different wording, from the same source ---------------
const second = await ingestCandidates(ctx as never, profile, source, [
  candidate({
    name: 'Replacement of Central Fire Station',           // reordered wording
    address: '400 Main St',                                 // new detail
    estimated_value: '$8.2M',                               // new detail
    evidence_url: 'https://example.invalid/agendas/2026-04', // new document
  }),
]);
check('reworded duplicate is matched, not re-created', second.created === 0 && second.matched === 1, JSON.stringify(second));

const fire = db
  .prepare("SELECT * FROM projects WHERE profile_id = ? AND name LIKE '%Fire Station%'")
  .get(profileId) as ProjectRow;
check('blank fields get filled from the later scan', fire.address === '400 Main St' && fire.estimated_value === '$8.2M', `${fire.address} / ${fire.estimated_value}`);

const links = db.prepare('SELECT COUNT(*) n FROM project_sources WHERE project_id = ?').get(fire.id) as { n: number };
check('both documents linked to the one project', links.n === 2, `${links.n} links`);

const totalProjects = db.prepare('SELECT COUNT(*) n FROM projects WHERE profile_id = ?').get(profileId) as { n: number };
check('no duplicate project row created', totalProjects.n === 2, `${totalProjects.n} projects`);

// --- 3. Research applies facts and updates fields ---------------------------
const research = (over: Partial<ResearchResult> = {}): ResearchResult => ({
  summary_update: '',
  stage: 'RFQ issued',
  estimated_value: '$8.6M',
  timeline_note: 'Statements of qualification due May 12, 2026.',
  owner_org: '',
  address: '',
  facts: [
    { category: 'timeline', label: 'SOQ deadline', value: 'May 12, 2026', detail: '', source_url: 'https://example.invalid/rfq', confidence: 90 },
    { category: 'contact', label: 'Procurement officer', value: 'A. Example', detail: 'Purchasing Dept', source_url: 'https://example.invalid/rfq', confidence: 80 },
    { category: 'budget', label: 'Appropriated', value: '$8.6M', detail: '2026 bond', source_url: 'https://example.invalid/budget', confidence: 85 },
  ],
  documents: [],
  no_new_information: false,
  ...over,
});

const r1 = await applyResearch(ctx as never, fire, research());
check('research records facts', r1.factsAdded === 3 && r1.changed, JSON.stringify(r1));

const afterStage = db.prepare('SELECT stage, estimated_value FROM projects WHERE id = ?').get(fire.id) as ProjectRow;
check('research updates stage and value', afterStage.stage === 'RFQ issued' && afterStage.estimated_value === '$8.6M', `${afterStage.stage} / ${afterStage.estimated_value}`);

// --- 4. Re-running with identical facts adds nothing ------------------------
const reread = db.prepare('SELECT * FROM projects WHERE id = ?').get(fire.id) as ProjectRow;
const r2 = await applyResearch(ctx as never, reread, research({ stage: '', estimated_value: '', timeline_note: '' }));
check('unchanged facts are not duplicated', r2.factsAdded === 0, JSON.stringify(r2));

// --- 5. A changed value supersedes the old one ------------------------------
const reread2 = db.prepare('SELECT * FROM projects WHERE id = ?').get(fire.id) as ProjectRow;
const moved = research({ stage: '', estimated_value: '', timeline_note: '' });
moved.facts = [{ ...moved.facts[0], value: 'May 26, 2026 (extended)' }];
const r3 = await applyResearch(ctx as never, reread2, moved);
const live = db.prepare("SELECT value FROM project_facts WHERE project_id = ? AND fact_key = 'timeline:soq-deadline' AND superseded = 0").all(fire.id) as { value: string }[];
const old = db.prepare("SELECT value FROM project_facts WHERE project_id = ? AND fact_key = 'timeline:soq-deadline' AND superseded = 1").all(fire.id) as { value: string }[];
check('changed date supersedes the old one', r3.factsAdded === 1 && live.length === 1 && old.length === 1, `live="${live[0]?.value}" superseded="${old[0]?.value}"`);

// --- 6. Dashboard + detail queries return it --------------------------------
db.prepare("UPDATE projects SET status = 'tracked' WHERE id = ?").run(fire.id);
const updates = db.prepare('SELECT COUNT(*) n FROM project_updates WHERE project_id = ?').get(fire.id) as { n: number };
check('activity feed recorded the changes', updates.n >= 3, `${updates.n} updates`);

// Clean up the fixture so it doesn't pollute the real database.
db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
const leftover = db.prepare('SELECT COUNT(*) n FROM projects WHERE profile_id = ?').get(profileId) as { n: number };
check('deleting a profile cascades to its projects', leftover.n === 0, `${leftover.n} left`);
