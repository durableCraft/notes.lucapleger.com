// Notizzettel – Server
// Schritt 1: statische Auslieferung des Frontend-Prototyps.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

const port = Number(process.env.PORT) || 3100;
const host = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use(express.static(publicDir, { index: false }));

// App-Routen liefern immer die App-Shell aus.
const appRoutes = ['/', '/papierkorb', '/login'];
app.get(appRoutes, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => res.status(404).type('text').send('Nicht gefunden'));

app.listen(port, host, () => {
  console.log(`Notizzettel läuft auf http://${host}:${port}`);
});
