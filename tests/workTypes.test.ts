import { beforeEach, describe, expect, it } from 'vitest';
import { db, migrate, newId, nowIso } from '../src/server/db/index.js';
import {
  workTypeKey,
  uniqueWorkTypeKey,
  activeWorkTypes,
  linkSourceWorkTypes,
  workTypesForSource,
  coverageByWorkType,
  leastCoveredWorkType,
} from '../src/server/jobs/workTypes.js';
import { makeProfile, makeSource, makeWorkType, resetData, useAccount } from './helpers.js';

migrate();
const accountId = useAccount();

beforeEach(() => resetData());

describe('key derivation', () => {
  it('slugifies a name', () => {
    expect(workTypeKey('Roof replacement — large institutional buildings')).toBe(
      'roof-replacement-large-institutional-buildings',
    );
  });

  it('never returns an empty key', () => {
    expect(workTypeKey('!!!')).toBe('work-type');
  });

  it('bounds the length', () => {
    expect(workTypeKey('a'.repeat(200)).length).toBeLessThanOrEqual(48);
  });

  it('disambiguates within a profile but allows reuse across profiles', () => {
    const a = makeProfile();
    const b = makeProfile();
    makeWorkType(a.id, 'roofing');
    expect(uniqueWorkTypeKey(a.id, 'Roofing')).toBe('roofing-2');
    // A different firm can have its own "roofing" without collision.
    expect(uniqueWorkTypeKey(b.id, 'Roofing')).toBe('roofing');
  });

  it('does not count the row being renamed as a collision', () => {
    const p = makeProfile();
    const wt = makeWorkType(p.id, 'roofing');
    expect(uniqueWorkTypeKey(p.id, 'Roofing', wt.id)).toBe('roofing');
  });
});

describe('source tagging', () => {
  it('is many-to-many — one source can serve several specializations', () => {
    const p = makeProfile();
    const s = makeSource(p.id);
    const a = makeWorkType(p.id, 'roofing');
    const b = makeWorkType(p.id, 'carwash');
    linkSourceWorkTypes(s.id, [a.id, b.id]);
    expect(workTypesForSource(s.id).map((t) => t.key).sort()).toEqual(['carwash', 'roofing']);
  });

  it('replaces tags rather than appending', () => {
    const p = makeProfile();
    const s = makeSource(p.id);
    const a = makeWorkType(p.id, 'roofing');
    const b = makeWorkType(p.id, 'carwash');
    linkSourceWorkTypes(s.id, [a.id, b.id]);
    linkSourceWorkTypes(s.id, [a.id]);
    expect(workTypesForSource(s.id).map((t) => t.key)).toEqual(['roofing']);
  });

  it('clears tags when given an empty list', () => {
    const p = makeProfile();
    const s = makeSource(p.id);
    linkSourceWorkTypes(s.id, [makeWorkType(p.id, 'roofing').id]);
    linkSourceWorkTypes(s.id, []);
    expect(workTypesForSource(s.id)).toEqual([]);
  });

  it('drops tags when the source is deleted', () => {
    const p = makeProfile();
    const s = makeSource(p.id);
    linkSourceWorkTypes(s.id, [makeWorkType(p.id, 'roofing').id]);
    db.prepare('DELETE FROM sources WHERE id = ?').run(s.id);
    const n = db.prepare('SELECT COUNT(*) n FROM source_work_types').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('coverage', () => {
  it('counts only active sources', () => {
    const p = makeProfile();
    const wt = makeWorkType(p.id, 'roofing');
    const active = makeSource(p.id, { status: 'active', url: 'https://a.invalid' });
    const dead = makeSource(p.id, { status: 'dead', url: 'https://b.invalid' });
    linkSourceWorkTypes(active.id, [wt.id]);
    linkSourceWorkTypes(dead.id, [wt.id]);

    const [coverage] = coverageByWorkType(p.id);
    expect(coverage.activeSources).toBe(1);
  });

  it('identifies the starved specialization for the next discovery pass', () => {
    const p = makeProfile();
    const rich = makeWorkType(p.id, 'carwash');
    const poor = makeWorkType(p.id, 'roofing');
    for (let i = 0; i < 3; i++) {
      const s = makeSource(p.id, { url: `https://s${i}.invalid` });
      linkSourceWorkTypes(s.id, [rich.id]);
    }
    expect(leastCoveredWorkType(p.id, 3)?.key).toBe('roofing');
  });

  it('returns null when every specialization is adequately covered', () => {
    const p = makeProfile();
    const wt = makeWorkType(p.id, 'roofing');
    const s = makeSource(p.id);
    linkSourceWorkTypes(s.id, [wt.id]);
    expect(leastCoveredWorkType(p.id, 1)).toBeNull();
  });

  it('excludes inactive work types', () => {
    const p = makeProfile();
    const wt = makeWorkType(p.id, 'roofing');
    db.prepare('UPDATE work_types SET active = 0 WHERE id = ?').run(wt.id);
    expect(activeWorkTypes(p.id)).toEqual([]);
    expect(coverageByWorkType(p.id)).toEqual([]);
  });

  it('counts projects but ignores rejected ones', () => {
    const p = makeProfile();
    const wt = makeWorkType(p.id, 'roofing');
    const now = nowIso();
    for (const status of ['discovered', 'tracked', 'rejected']) {
      db.prepare(
        `INSERT INTO projects (id, account_id, profile_id, work_type_id, name, status, first_seen_at, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), accountId, p.id, wt.id, `x-${status}`, status, now, now);
    }
    expect(coverageByWorkType(p.id)[0].projectsFound).toBe(2);
  });
});
