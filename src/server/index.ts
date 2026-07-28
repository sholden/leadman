import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config, shadowedEnvVars } from './config.js';
import { migrate } from './db/index.js';
import { credentialStatus, verifyCredentials } from './ai/credentials.js';
import { profilesRouter } from './routes/profiles.js';
import { sourcesRouter } from './routes/sources.js';
import { workTypesRouter } from './routes/workTypes.js';
import { projectsRouter } from './routes/projects.js';
import { systemRouter } from './routes/system.js';
import { geoRouter } from './routes/geo.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

migrate();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/profiles', profilesRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/work-types', workTypesRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/geo', geoRouter);
app.use('/api', systemRouter);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, apiKeyConfigured: Boolean(config.apiKey), credentials: credentialStatus() }),
);

// Serve the built SPA when it exists (npm start). In dev, Vite serves it instead.
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

// Any unhandled error in a route lands here rather than killing the process.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[api] unhandled error', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  },
);

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
