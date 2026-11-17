// Notizzettel – Einstiegspunkt. Start: node server.js

import './src/warnings.js';

const { start } = await import('./src/app.js');
start();
