import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test file gets its own throwaway database.
 *
 * `src/server/db/index.ts` opens the connection at import time from
 * `config.dbPath`, so this must run before any application module is imported —
 * which is what `setupFiles` guarantees. Without it, tests would read and write
 * the developer's real `data/leadman.db`.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadman-test-'));
process.env.LEADMAN_DB = path.join(dir, 'test.db');

// Keep tests hermetic: no scheduler, no inherited credentials, no .env bleed.
process.env.LEADMAN_SCHEDULER = 'off';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.LEADMAN_CONTACT = 'leadman-tests';

// Fail loudly if a test reaches the network by accident. Individual tests that
// need fetch stub it themselves with vi.stubGlobal.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(
    `Unexpected network call to ${String(input)} — tests must stub fetch. ` +
      `If this is intentional, restore it explicitly in the test.`,
  );
}) as typeof fetch;

/** Escape hatch for a test that genuinely wants the real thing. */
export const unmockedFetch = realFetch;

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
