import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { credentialStatus } from './ai/credentials.js';
import { profilesRouter } from './routes/profiles.js';
import { sourcesRouter } from './routes/sources.js';
import { workTypesRouter } from './routes/workTypes.js';
import { projectsRouter } from './routes/projects.js';
import { systemRouter } from './routes/system.js';
import { geoRouter } from './routes/geo.js';

/**
 * Builds the express app without binding a port, so tests can drive it directly
 * and the entry point stays responsible only for listening and scheduling.
 */
export function createApp() {
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

  return app;
}
