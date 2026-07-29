import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { credentialSummary } from './ai/credentials.js';
import { authRouter } from './routes/auth.js';
import { accountRouter } from './routes/account.js';
import { adminRouter } from './routes/admin.js';
import { profilesRouter } from './routes/profiles.js';
import { sourcesRouter } from './routes/sources.js';
import { workTypesRouter } from './routes/workTypes.js';
import { projectsRouter } from './routes/projects.js';
import { systemRouter } from './routes/system.js';
import { geoRouter } from './routes/geo.js';
import { requireAuth } from './auth/middleware.js';
import { siteAdminCount } from './auth/store.js';

/**
 * Builds the express app without binding a port, so tests can drive it directly
 * and the entry point stays responsible only for listening and scheduling.
 */
export function createApp() {
  const app = express();
  // Behind Kamal's proxy, so trust its forwarding headers — otherwise every
  // request looks like plain HTTP from localhost and Secure cookies break.
  app.set('trust proxy', 1);
  // Credentials must be allowed for the session cookie to survive a
  // cross-origin dev setup (Vite on :5173 talking to the API on :8787).
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  // Declared before the routers below, because `app.use('/api', requireAuth, …)`
  // applies to every path under /api — including this one, if it came after.
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      apiKeyConfigured: Boolean(config.apiKey),
      credentials: credentialSummary(),
      // Surfaced unauthenticated so the login page can explain an installation
      // that nobody can sign in to yet. Reveals no data.
      needsBootstrap: siteAdminCount() === 0,
    }),
  );

  // Public: signing in, and redeeming an invite (whose whole point is that the
  // redeemer has no session yet).
  app.use('/api/auth', authRouter);

  // Everything below is account-scoped. `requireAuth` resolves the session,
  // establishes the account context, and every handler reads from it — there is
  // no route in the app that queries tenant data without one.
  app.use('/api/account', accountRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/profiles', requireAuth, profilesRouter);
  app.use('/api/sources', requireAuth, sourcesRouter);
  app.use('/api/work-types', requireAuth, workTypesRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/geo', requireAuth, geoRouter);
  app.use('/api', requireAuth, systemRouter);

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
