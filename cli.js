// Notizzettel – Werkzeuge für die Kommandozeile
//
//   node cli.js backup [ziel.db]           konsistente Kopie der Datenbank (auch im laufenden Betrieb)
//   node cli.js reset-password <email>     neues Passwort setzen (wird ausgegeben)
//   node cli.js users                      Benutzer auflisten
//   node cli.js help
//
// Auf dem Server als Dienst-Benutzer ausführen, z. B.:
//   runuser -u notizzettel -- node cli.js backup

import './src/warnings.js';

const { runCli } = await import('./src/cli.js');
process.exitCode = await runCli(process.argv.slice(2));
