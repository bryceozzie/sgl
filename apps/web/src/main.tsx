import { render } from 'preact';
import { App } from './App.js';
import { bootApp, bootFallback } from './io/app-boot.js';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html.');

// Storage first (DD-08 §9): which document opens, and its stored last-good
// SVG to paint before fonts or the worker are ready (§5). IndexedDB answers in
// milliseconds. `bootApp` is written never to reject — storage failures fall
// back to memory, anything else to `bootFallback()` — but the shell must
// mount whatever happens (fix round 1, item 8: a rejection here used to
// leave a blank page), so a rejection gets the same fallback: the example,
// in memory, with a toast.
void bootApp()
  .catch((err: unknown) => {
    console.error('[SGL] boot failed; opening the example in memory.', err);
    return bootFallback();
  })
  .then((boot) => render(<App boot={boot} />, root));
