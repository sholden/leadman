import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, migrate } from '../src/server/db/index.js';
import { applyResearch } from '../src/server/jobs/researchProject.js';
import type { ResearchResult } from '../src/server/ai/schemas.js';
import type { ProjectRow } from '../src/server/lib/models.js';
import { fakeCtx, makeProfile, resetData } from './helpers.js';
import { newId, nowIso } from '../src/server/db/index.js';

migrate();

vi.mock('../src/server/lib/archive.js', () => ({
  archiveUrl: async () => 'stub-artifact-id',
  fetchReadable: async (url: string) => ({ url, title: '', text: '', bytes: 0, contentType: '', ok: false }),
}));

function makeProject(profileId: string): ProjectRow {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO projects (id, profile_id, name, status, first_seen_at, last_updated_at)
     VALUES (?, ?, 'Test Library', 'tracked', ?, ?)`,
  ).run(id, profileId, now, now);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
}

const research = (over: Partial<ResearchResult> = {}): ResearchResult => ({
  summary_update: '',
  stage: '',
  estimated_value: '',
  timeline_note: '',
  owner_org: '',
  address: '',
  facts: [],
  documents: [],
  no_new_information: false,
  ...over,
});

const fact = (over: Partial<ResearchResult['facts'][number]> = {}) => ({
  category: 'timeline' as const,
  label: 'SOQ deadline',
  value: 'May 12, 2026',
  detail: '',
  source_url: 'https://example.invalid/rfq',
  confidence: 90,
  ...over,
});

beforeEach(() => resetData());

describe('applying research findings', () => {
  it('records new facts and reports the count', async () => {
    const project = makeProject(makeProfile().id);
    const out = await applyResearch(fakeCtx(), project, research({ facts: [fact()] }));
    expect(out.factsAdded).toBe(1);
    expect(out.changed).toBe(true);
  });

  it('updates project fields that were previously blank', async () => {
    const project = makeProject(makeProfile().id);
    await applyResearch(
      fakeCtx(),
      project,
      research({ stage: 'RFQ issued', estimated_value: '$8.6M' }),
    );
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    expect(p.stage).toBe('RFQ issued');
    expect(p.estimated_value).toBe('$8.6M');
  });

  it('does not re-add a fact whose value has not changed', async () => {
    const project = makeProject(makeProfile().id);
    await applyResearch(fakeCtx(), project, research({ facts: [fact()] }));
    const reread = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    const out = await applyResearch(fakeCtx(), reread, research({ facts: [fact()] }));
    expect(out.factsAdded).toBe(0);
    expect(out.changed).toBe(false);
  });

  it('supersedes the old value when a fact changes, keeping the history', async () => {
    const project = makeProject(makeProfile().id);
    await applyResearch(fakeCtx(), project, research({ facts: [fact()] }));
    const reread = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    await applyResearch(
      fakeCtx(),
      reread,
      research({ facts: [fact({ value: 'May 26, 2026 (extended)' })] }),
    );

    const live = db
      .prepare('SELECT value FROM project_facts WHERE superseded = 0')
      .all() as { value: string }[];
    const old = db
      .prepare('SELECT value FROM project_facts WHERE superseded = 1')
      .all() as { value: string }[];
    expect(live).toHaveLength(1);
    expect(live[0].value).toBe('May 26, 2026 (extended)');
    expect(old).toHaveLength(1);
    expect(old[0].value).toBe('May 12, 2026');
  });

  it('drops low-confidence facts', async () => {
    const project = makeProject(makeProfile().id);
    const out = await applyResearch(
      fakeCtx(),
      project,
      research({ facts: [fact({ confidence: 10 })] }),
    );
    expect(out.factsAdded).toBe(0);
  });

  it('records an activity entry when something changed', async () => {
    const project = makeProject(makeProfile().id);
    await applyResearch(fakeCtx(), project, research({ facts: [fact()] }));
    const updates = db
      .prepare("SELECT * FROM project_updates WHERE kind = 'new_facts'")
      .all() as unknown[];
    expect(updates).toHaveLength(1);
  });

  it('records nothing on the feed when the pass found nothing', async () => {
    const project = makeProject(makeProfile().id);
    const out = await applyResearch(fakeCtx(), project, research({ no_new_information: true }));
    expect(out.changed).toBe(false);
    const updates = db.prepare('SELECT COUNT(*) n FROM project_updates').get() as { n: number };
    expect(updates.n).toBe(0);
  });
});

describe('research scheduling', () => {
  it('backs off when a pass finds nothing', async () => {
    const project = makeProject(makeProfile().id);
    const before = project.research_interval_hours;
    await applyResearch(fakeCtx(), project, research({ no_new_information: true }));
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    expect(p.research_interval_hours).toBeGreaterThan(before);
  });

  it('speeds up when a pass finds something', async () => {
    const project = makeProject(makeProfile().id);
    const before = project.research_interval_hours;
    await applyResearch(fakeCtx(), project, research({ facts: [fact()] }));
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    expect(p.research_interval_hours).toBeLessThan(before);
  });

  it('always schedules the next pass', async () => {
    const project = makeProject(makeProfile().id);
    await applyResearch(fakeCtx(), project, research());
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
    expect(p.next_research_at).toBeTruthy();
    expect(Date.parse(p.next_research_at!)).toBeGreaterThan(Date.now());
  });
});
