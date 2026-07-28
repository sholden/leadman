import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, migrate, setSetting } from '../src/server/db/index.js';
import { ingestCandidates } from '../src/server/jobs/scanSource.js';
import type { ProjectRow, WorkTypeRow } from '../src/server/lib/models.js';
import { candidate, fakeCtx, makeProfile, makeSource, makeWorkType, resetData, useAccount } from './helpers.js';

migrate();
useAccount();

// Archiving does a real HTTP fetch; tests must not. Stub it to a no-op.
vi.mock('../src/server/lib/archive.js', () => ({
  archiveUrl: async () => 'stub-artifact-id',
  fetchReadable: async (url: string) => ({ url, title: '', text: '', bytes: 0, contentType: '', ok: false }),
}));

beforeEach(() => {
  resetData();
  setSetting('minRelevance', '40');
});

describe('ingesting scan candidates', () => {
  it('creates a project per distinct candidate', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    const out = await ingestCandidates(fakeCtx(), profile, source, [
      candidate(),
      candidate({ name: 'Zachary High Gymnasium', evidence_url: 'https://example.invalid/agenda/2' }),
    ]);
    expect(out).toEqual({ created: 2, matched: 0 });
  });

  it('matches a reworded duplicate instead of creating a second project', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);

    const out = await ingestCandidates(fakeCtx(), profile, source, [
      candidate({
        name: 'Replacement of Central Fire Station',
        evidence_url: 'https://example.invalid/agenda/later',
      }),
    ]);
    expect(out).toEqual({ created: 0, matched: 1 });
    const count = db.prepare('SELECT COUNT(*) n FROM projects').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('fills blank fields from a later sighting without overwriting known ones', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate({ owner_org: 'Original Owner' })]);
    await ingestCandidates(fakeCtx(), profile, source, [
      candidate({
        name: 'Replacement of Central Fire Station',
        address: '400 Main St',
        estimated_value: '$8.2M',
        owner_org: 'Different Owner',
        evidence_url: 'https://example.invalid/agenda/later',
      }),
    ]);
    const p = db.prepare('SELECT * FROM projects').get() as ProjectRow;
    expect(p.address).toBe('400 Main St'); // was blank, now filled
    expect(p.estimated_value).toBe('$8.2M');
    expect(p.owner_org).toBe('Original Owner'); // already known, left alone
  });

  it('links every document that mentions the project', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);
    await ingestCandidates(fakeCtx(), profile, source, [
      candidate({ name: 'Central Fire Station', evidence_url: 'https://example.invalid/agenda/2' }),
    ]);
    const links = db.prepare('SELECT COUNT(*) n FROM project_sources').get() as { n: number };
    expect(links.n).toBe(2);
  });

  it('does not duplicate a link for the same document seen twice', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);
    const links = db.prepare('SELECT COUNT(*) n FROM project_sources').get() as { n: number };
    expect(links.n).toBe(1);
  });

  it('records a discovery entry on the activity feed', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);
    const updates = db
      .prepare("SELECT * FROM project_updates WHERE kind = 'discovered'")
      .all() as unknown[];
    expect(updates).toHaveLength(1);
  });
});

describe('work type classification', () => {
  it('stores the work type the scan assigned', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    const roofing = makeWorkType(profile.id, 'roofing', 'Roofing');
    const byKey = new Map<string, WorkTypeRow>([['roofing', roofing]]);

    await ingestCandidates(
      fakeCtx(),
      profile,
      source,
      [candidate({ work_type_key: 'roofing' })],
      byKey,
    );
    const p = db.prepare('SELECT * FROM projects').get() as ProjectRow;
    expect(p.work_type_id).toBe(roofing.id);
  });

  it('leaves the work type null when the key is unknown', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate({ work_type_key: 'nope' })], new Map());
    const p = db.prepare('SELECT * FROM projects').get() as ProjectRow;
    expect(p.work_type_id).toBeNull();
  });
});

describe('cascade behaviour', () => {
  it('deleting a profile removes its projects and links', async () => {
    const profile = makeProfile();
    const source = makeSource(profile.id);
    await ingestCandidates(fakeCtx(), profile, source, [candidate()]);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);

    const projects = db.prepare('SELECT COUNT(*) n FROM projects').get() as { n: number };
    const links = db.prepare('SELECT COUNT(*) n FROM project_sources').get() as { n: number };
    expect(projects.n).toBe(0);
    expect(links.n).toBe(0);
  });
});
