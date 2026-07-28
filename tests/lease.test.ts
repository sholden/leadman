import { beforeEach, describe, expect, it } from 'vitest';
import { db, migrate, nowIso } from '../src/server/db/index.js';
import { acquireLease, renewLease, releaseLease, currentLease, HOLDER_ID } from '../src/server/jobs/lease.js';

migrate();

/** Simulates the other container by writing a lease held by a different holder. */
function foreignLease(expiresInMs: number, key = 'scheduler') {
  db.prepare(
    `INSERT INTO leases (key, holder, acquired_at, expires_at) VALUES (?, 'other-container', ?, ?)
     ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
  ).run(key, nowIso(), new Date(Date.now() + expiresInMs).toISOString());
}

beforeEach(() => db.exec('DELETE FROM leases'));

describe('scheduler lease', () => {
  it('is acquired when free', () => {
    expect(acquireLease(60_000)).toBe(true);
    expect(currentLease()?.holder).toBe(HOLDER_ID);
  });

  it('is refused while another live process holds it', () => {
    // This is the deploy window: the outgoing container is still mid-tick.
    foreignLease(60_000);
    expect(acquireLease(60_000)).toBe(false);
  });

  it('is taken over once the other holder has expired', () => {
    // A container killed mid-tick must not block the scheduler forever.
    foreignLease(-1000);
    expect(acquireLease(60_000)).toBe(true);
    expect(currentLease()?.holder).toBe(HOLDER_ID);
  });

  it('is re-entrant for the same holder', () => {
    expect(acquireLease(60_000)).toBe(true);
    expect(acquireLease(60_000)).toBe(true);
  });

  it('renews only for the holder', () => {
    acquireLease(60_000);
    expect(renewLease(120_000)).toBe(true);

    foreignLease(60_000);
    expect(renewLease(120_000)).toBe(false);
  });

  it('extends the expiry on renewal', () => {
    acquireLease(1_000);
    const before = Date.parse(currentLease()!.expires_at);
    renewLease(600_000);
    expect(Date.parse(currentLease()!.expires_at)).toBeGreaterThan(before);
  });

  it('releases so a redeployed container can start immediately', () => {
    acquireLease(60_000);
    releaseLease();
    expect(currentLease()).toBeUndefined();
    expect(acquireLease(60_000)).toBe(true);
  });

  it('does not let one process release another"s lease', () => {
    foreignLease(60_000);
    releaseLease();
    expect(currentLease()?.holder).toBe('other-container');
  });

  it('keeps separate keys independent', () => {
    foreignLease(60_000, 'scheduler');
    expect(acquireLease(60_000, 'something-else')).toBe(true);
  });
});
