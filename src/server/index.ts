import { config, shadowedEnvVars } from './config.js';
import { migrate } from './db/index.js';
import { credentialStatus, verifyCredentials } from './ai/credentials.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { reconcileOrphanedRuns } from './jobs/runs.js';

migrate();
// A run left 'running' by a crash would otherwise show as active forever.
reconcileOrphanedRuns();

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
  const { state, detail } = credentialStatus();
  if (state === 'ok') console.log('  API key verified.\n');
  else console.warn(`  WARNING: ${detail}\n  Discovery, scanning, and research will fail.\n`);

  if (config.schedulerEnabled) startScheduler();
  else console.log('  Scheduler disabled (LEADMAN_SCHEDULER=off)\n');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopScheduler();
    server.close(() => process.exit(0));
  });
}
