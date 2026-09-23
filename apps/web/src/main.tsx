import { render } from 'preact';
import { App } from './App.js';
import { bootApp } from './io/app-boot.js';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html.');

// Storage first (DD-08 §9): which document opens, and its stored last-good
// SVG to paint before fonts or the worker are ready (§5). IndexedDB answers in
// milliseconds; `bootApp` never rejects for a storage problem (it falls back
// to memory), so the shell always mounts.
void bootApp().then((boot) => render(<App boot={boot} />, root));
