import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, db } from '../src/server/db/index.js';
import { createApp } from '../src/server/app.js';
import { resetData, signedInOwner, useAccount } from './helpers.js';

migrate();
useAccount();
const app = createApp();

/**
 * Every route below the auth boundary is exercised through a real session
 * cookie rather than a forged one, so the login path stays covered by the
 * suite that uses it most.
 */
let agent: Awaited<ReturnType<typeof signedInOwner>>['agent'];
beforeAll(async () => {
  ({ agent } = await signedInOwner(app));
});

const validProfile = {
  name: 'Capital Region',
  description: 'A firm that does public institutional work in the Baton Rouge area.',
  center_label: 'Baton Rouge, Louisiana',
  center_lat: 30.4515,
  center_lng: -91.1871,
  radius_miles: 60,
};

beforeEach(() => resetData());

describe('health', () => {
  it('reports ok without any API key configured, and without a session', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.apiKeyConfigured).toBe(false);
  });
});

describe('the auth boundary', () => {
  it('refuses every data route without a session', async () => {
    for (const path of [
      '/api/profiles',
      '/api/sources',
      '/api/projects',
      '/api/dashboard',
      '/api/settings',
      '/api/activity',
      '/api/budget',
      '/api/runs',
      '/api/geo/search?q=baton%20rouge',
    ]) {
      await request(app).get(path).expect(401);
    }
    await request(app).post('/api/tick').expect(401);
    await request(app).post('/api/profiles').send(validProfile).expect(401);
  });

  it('rejects a forged session cookie', async () => {
    await request(app)
      .get('/api/profiles')
      .set('Cookie', 'leadman_session=not-a-real-token')
      .expect(401);
  });
});

describe('profiles', () => {
  it('creates and lists a profile', async () => {
    const created = await agent.post('/api/profiles').send(validProfile).expect(201);
    expect(created.body.id).toBeTruthy();

    const list = await agent.get('/api/profiles').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].stats).toEqual({
      activeSources: 0,
      totalSources: 0,
      discovered: 0,
      tracked: 0,
    });
  });

  it('rejects a profile missing required fields', async () => {
    await agent.post('/api/profiles').send({ name: 'x' }).expect(400);
  });

  it('rejects an out-of-range latitude', async () => {
    await agent
      .post('/api/profiles')
      .send({ ...validProfile, center_lat: 999 })
      .expect(400);
  });

  it('updates a profile', async () => {
    const { body } = await agent.post('/api/profiles').send(validProfile);
    const res = await agent
      .patch(`/api/profiles/${body.id}`)
      .send({ radius_miles: 25 })
      .expect(200);
    expect(res.body.radius_miles).toBe(25);
  });

  it('404s on an unknown profile', async () => {
    await agent.patch('/api/profiles/nope').send({ radius_miles: 5 }).expect(404);
  });

  it('deletes a profile', async () => {
    const { body } = await agent.post('/api/profiles').send(validProfile);
    await agent.delete(`/api/profiles/${body.id}`).expect(204);
    const list = await agent.get('/api/profiles').expect(200);
    expect(list.body).toHaveLength(0);
  });
});

describe('sources', () => {
  async function profileId() {
    const { body } = await agent.post('/api/profiles').send(validProfile);
    return body.id as string;
  }

  it('adds a manual source as active', async () => {
    const id = await profileId();
    const res = await agent
      .post('/api/sources')
      .send({ profile_id: id, name: 'Council Agendas', url: 'https://example.invalid/agendas' })
      .expect(201);
    expect(res.body.status).toBe('active');
    expect(res.body.origin).toBe('manual');
  });

  it('rejects a duplicate URL on the same profile with a clear message', async () => {
    const id = await profileId();
    const body = { profile_id: id, name: 'A', url: 'https://example.invalid/dupe' };
    await agent.post('/api/sources').send(body).expect(201);
    const res = await agent.post('/api/sources').send({ ...body, name: 'B' }).expect(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('rejects an invalid URL', async () => {
    const id = await profileId();
    await agent
      .post('/api/sources')
      .send({ profile_id: id, name: 'A', url: 'not-a-url' })
      .expect(400);
  });

  it('makes a reactivated source immediately due for scanning', async () => {
    const id = await profileId();
    const { body } = await agent
      .post('/api/sources')
      .send({ profile_id: id, name: 'A', url: 'https://example.invalid/x' });
    await agent.patch(`/api/sources/${body.id}`).send({ status: 'paused' }).expect(200);
    const res = await agent
      .patch(`/api/sources/${body.id}`)
      .send({ status: 'active' })
      .expect(200);
    expect(res.body.next_scan_at).toBeTruthy();
    expect(res.body.consecutive_empty_scans).toBe(0);
  });

  it('filters by profile', async () => {
    const a = await profileId();
    await agent
      .post('/api/sources')
      .send({ profile_id: a, name: 'A', url: 'https://example.invalid/a' });
    const res = await agent.get(`/api/sources?profileId=${a}`).expect(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('work types', () => {
  async function profileId() {
    const { body } = await agent.post('/api/profiles').send(validProfile);
    return body.id as string;
  }

  it('requires a profileId to list', async () => {
    await agent.get('/api/work-types').expect(400);
  });

  it('creates one with a derived key', async () => {
    const id = await profileId();
    const res = await agent
      .post('/api/work-types')
      .send({ profile_id: id, name: 'Roof replacement — schools', description: 'Roofs.' })
      .expect(201);
    expect(res.body.key).toBe('roof-replacement-schools');
    expect(res.body.planned_at).toBeNull();
  });

  it('disambiguates a duplicate name', async () => {
    const id = await profileId();
    const body = { profile_id: id, name: 'Roofing' };
    const a = await agent.post('/api/work-types').send(body).expect(201);
    const b = await agent.post('/api/work-types').send(body).expect(201);
    expect(a.body.key).toBe('roofing');
    expect(b.body.key).toBe('roofing-2');
  });

  it('clears the stored strategy when the description changes', async () => {
    const id = await profileId();
    const { body } = await agent
      .post('/api/work-types')
      .send({ profile_id: id, name: 'Roofing', description: 'original' });
    db.prepare('UPDATE work_types SET planned_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', body.id);

    const res = await agent
      .patch(`/api/work-types/${body.id}`)
      .send({ description: 'changed' })
      .expect(200);
    // The derived hunting strategy no longer matches the definition.
    expect(res.body.planned_at).toBeNull();
  });

  it('keeps the strategy when only the name changes', async () => {
    const id = await profileId();
    const { body } = await agent
      .post('/api/work-types')
      .send({ profile_id: id, name: 'Roofing', description: 'same' });
    db.prepare('UPDATE work_types SET planned_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', body.id);
    const res = await agent
      .patch(`/api/work-types/${body.id}`)
      .send({ name: 'Roof work' })
      .expect(200);
    expect(res.body.planned_at).not.toBeNull();
  });
});

describe('settings', () => {
  it('returns defaults and accepts a known key', async () => {
    const res = await agent.get('/api/settings').expect(200);
    expect(res.body.settings.model).toBeTruthy();

    await agent.put('/api/settings').send({ perRunBudgetUsd: '9' }).expect(200);
    const after = await agent.get('/api/settings').expect(200);
    expect(after.body.settings.perRunBudgetUsd).toBe('9');
  });

  it('ignores keys that are not real settings', async () => {
    await agent.put('/api/settings').send({ nonsense: 'x' }).expect(200);
    const res = await agent.get('/api/settings').expect(200);
    expect(res.body.settings.nonsense).toBeUndefined();
  });
});

describe('activity', () => {
  it('returns an empty but well-formed shape on a fresh install', async () => {
    const res = await agent.get('/api/activity').expect(200);
    expect(res.body.active).toEqual([]);
    expect(res.body.recent).toEqual([]);
    expect(res.body.totals).toBeTruthy();
  });
});

describe('budget', () => {
  it('reports caps and spend', async () => {
    const res = await agent.get('/api/budget').expect(200);
    expect(res.body.monthlyCapUsd).toBeGreaterThan(0);
    expect(res.body.monthToDateUsd).toBe(0);
    expect(Array.isArray(res.body.daily)).toBe(true);
  });
});

describe('models', () => {
  it('reports both providers as unconfigured when no keys are set', async () => {
    const res = await agent.get('/api/models').expect(200);
    expect(res.body).toHaveLength(2);
    for (const p of res.body) {
      expect(p.configured).toBe(false);
      expect(p.models).toEqual([]);
    }
  });
});

describe('geocoding', () => {
  it('rejects a query that is too short without calling out', async () => {
    await agent.get('/api/geo/search?q=ab').expect(400);
  });
});
