// node:sqlite meldet unter Node 22 bei jedem Start eine ExperimentalWarning.
// Nur diese eine Warnung wird ausgeblendet, damit Journal und Konsole sauber bleiben.
// Muss geladen werden, BEVOR node:sqlite importiert wird (daher dynamische Imports
// in server.js und cli.js).

const emitWarning = process.emitWarning;
process.emitWarning = function filteredWarning(warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const name = warning?.name || type;
  const message = typeof warning === 'string' ? warning : warning?.message;
  if (name === 'ExperimentalWarning' && /SQLite/i.test(message || '')) return;
  return emitWarning.call(this, warning, ...args);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Notizzettel braucht Node.js 22.13 oder neuer (gefunden: ${process.versions.node}).`);
  process.exit(1);
}
