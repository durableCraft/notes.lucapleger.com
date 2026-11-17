// Zusammenbau des Servers

import path from 'node:path';
import express from 'express';
import { loadConfig, rootDir } from './config.js';
import { openDb, getDb } from './db.js';
import { securityHeaders, csrfGuard, noStore, errorHandler, notFound } from './http.js';
import { initSessions, loadSession } from './session.js';
import { initSetup } from './setup.js';
import { startJobs } from './jobs.js';
import { authRoutes, initAuthRoutes } from './routes/auth.js';
import { adminRoutes, initAdminRoutes } from './routes/admin.js';
import { notesRoutes } from './routes/notes.js';
import { passkeyRoutes, initPasskeyRoutes } from './routes/passkeys.js';

const publicDir = path.join(rootDir, 'public');

// Pfade, die die App-Shell ausliefern (Routing im Browser)
const APP_ROUTES = ['/', '/papierkorb', '/login', '/setup', '/konto', '/admin',
  '/einladung/:token', '/passwort/:token'];

export function createApp(cfg) {
  initAuthRoutes(cfg);
  initAdminRoutes(cfg);
  initPasskeyRoutes(cfg);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  app.use(securityHeaders);

  const api = express.Router();
  api.use(noStore, express.json({ limit: '1mb' }), csrfGuard(cfg.baseUrl), loadSession);
  api.use(authRoutes);
  api.use(notesRoutes);
  api.use(adminRoutes);
  api.use(passkeyRoutes);
  api.use((req, res, next) => next(notFound()));
  app.use('/api', api);

  app.use(express.static(publicDir, { index: false }));

  app.get(APP_ROUTES, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((req, res) => res.status(404).type('text').send('Nicht gefunden'));
  app.use(errorHandler);
  return app;
}

export function start() {
  const cfg = loadConfig();
  openDb();
  initSessions(cfg);
  initSetup(cfg);
  startJobs();

  const app = createApp(cfg);
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`Notizzettel läuft auf http://${cfg.host}:${cfg.port} (öffentlich: ${cfg.baseUrl})`);
  });
  server.on('error', (err) => {
    console.error(`Server konnte nicht starten: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`${signal} empfangen, beende …`);
    server.close(() => {
      try { getDb().close(); } catch { /* schon zu */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
