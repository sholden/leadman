import { config, shadowedEnvVars } from './config.js';
import { migrate } from './db/index.js';
import { credentialSummary, verifyCredentials } from './ai/credentials.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { reconcileOrphanedRuns } from './jobs/runs.js';
import { bootstrapSiteAdmin } from './auth/bootstrap.js';
import { purgeExpiredSessions } from './auth/store.js';

migrate();
// A run left 'running' by a crash would otherwise show as active forever.
reconcileOrphanedRuns();
purgeExpiredSessions();
// Must finish before the port opens: an installation with no site admin has no
// way in, and the health endpoint reports on it.
await bootstrapSiteAdmin();

const app = createApp();

const server = app.listen(config.port, async () => {
  console.log(`\n  Leadman → http://localhost:${config.port}\n`);

  if (shadowedEnvVars.length > 0) {
    console.warn(
      `  WARNING: ${shadowedEnvVars.join(', ')} ${shadowedEnvVars.length === 1 ? 'is' : 'are'} set in your shell\n` +
        `  AND in .env, with different values. The shell value wins — .env is being ignored.\n` +
        `  Unset it (unset ${shadowedEnvVars[0]}) or update your shell profile.\n`,
    );
  }

  await verifyCredentials();
  // Report every vendor, since different accounts may be on different ones.
  const configured = credentialSummary().providers.filter((p) => p.configured);
  if (configured.length === 0) {
    console.warn('  WARNING: no provider API key is set.\n  Discovery, scanning, and research will fail.\n');
  } else {
    for (const p of configured) {
      if (p.state === 'ok') console.log(`  ${p.provider} API key verified.`);
      else console.warn(`  WARNING: ${p.provider} — ${p.detail}`);
    }
    console.log('');
  }

  // Background work must not be able to take the site down with it. This runs
  // inside the listen callback, where an uncaught throw becomes an unhandled
  // rejection and kills the process — which is exactly how a scheduler bug
  // turned into a 502 on a server that was otherwise serving fine.
  if (config.schedulerEnabled) {
    try {
      startScheduler();
    } catch (err) {
      console.error(
        '  ERROR: the scheduler failed to start, so no background discovery, scanning\n' +
          '  or research will run. The app is still serving; existing data is unaffected.\n',
        err,
      );
    }
  } else {
    console.log('  Scheduler disabled (LEADMAN_SCHEDULER=off)\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopScheduler();
    server.close(() => process.exit(0));
  });
}
