import { db, nowIso } from '../db/index.js';
import crypto from 'node:crypto';

/**
 * A single-holder lease over scheduled work.
 *
 * Kamal starts the replacement container and waits for it to pass a healthcheck
 * *before* stopping the old one, so for a few seconds two processes share the
 * same SQLite volume. Two schedulers ticking at once would run the same
 * discovery and scan jobs twice — duplicate work against a paid API, and
 * needless write contention.
 *
 * The lease is held in the database rather than in memory precisely because the
 * competing process is a different container. It expires on its own, so a
 * process that is killed mid-tick cannot deadlock the scheduler forever.
 */
const LEASE_KEY = 'scheduler';

/** Identifies this process. Hostname is the container id under Docker. */
export const HOLDER_ID = `${process.env.HOSTNAME ?? 'local'}-${crypto.randomUUID().slice(0, 8)}`;

export interface LeaseRow {
  key: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

/**
 * Tries to take the lease for `ttlMs`. Returns false when another live process
 * holds it. Re-entrant for the same holder, which renews rather than blocks.
 */
export function acquireLease(ttlMs: number, key = LEASE_KEY): boolean {
  const now = Date.now();
  const expires = new Date(now + ttlMs).toISOString();

  const claim = db.transaction(() => {
    const current = db.prepare('SELECT * FROM leases WHERE key = ?').get(key) as
      | LeaseRow
      | undefined;

    const heldByOther =
      current && current.holder !== HOLDER_ID && Date.parse(current.expires_at) > now;
    if (heldByOther) return false;

    db.prepare(
      `INSERT INTO leases (key, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET holder = excluded.holder,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
    ).run(key, HOLDER_ID, nowIso(), expires);
    return true;
  });

  return claim();
}

/** Extends a lease we already hold. No-op if someone else took it. */
export function renewLease(ttlMs: number, key = LEASE_KEY): boolean {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const info = db
    .prepare('UPDATE leases SET expires_at = ? WHERE key = ? AND holder = ?')
    .run(expires, key, HOLDER_ID);
  return info.changes > 0;
}

/** Releases early so a redeployed container can pick up work immediately. */
export function releaseLease(key = LEASE_KEY): void {
  db.prepare('DELETE FROM leases WHERE key = ? AND holder = ?').run(key, HOLDER_ID);
}

export function currentLease(key = LEASE_KEY): LeaseRow | undefined {
  return db.prepare('SELECT * FROM leases WHERE key = ?').get(key) as LeaseRow | undefined;
}
