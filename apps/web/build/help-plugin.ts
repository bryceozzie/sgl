import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import { fixedDescriptor, gridDescriptor } from '@sgl/layout-std/descriptor';
import type { Plugin } from 'vite';
import { referenceIds } from '../src/help/join.js';
import type { HelpContent } from '../src/help/content.js';
import { buildReference } from '../src/reference/build.js';
import { compileHelp, type HelpFile } from './help-content.js';

/**
 * The `virtual:sgl-help-content` module (DD-13 P13): the help Markdown in
 * `apps/web/help/`, compiled at build time by `compileHelp` and served as one
 * default-exported `HelpContent`. Only the lazy help chunks import it (help
 * branch 4); until then nothing does, so it emits no chunk and costs the
 * boot bundle nothing (`test/reference-boot.test.ts`).
 *
 * The content is compiled at `buildStart` as well as on load, so a problem
 * in it **fails `vite build`** whether or not anything imports the module yet
 * (DD-13 P12). Links and entries are checked against the reference's own ids,
 * built from the engines the worker registers.
 */

export const HELP_MODULE_ID = 'virtual:sgl-help-content';
const RESOLVED_ID = `\0${HELP_MODULE_ID}`;

export const HELP_DIR = fileURLToPath(new URL('../help/', import.meta.url));

/** The engines the worker registers (`layout.worker.ts`), by descriptor: the
 *  build cannot import `io/app-boot.ts`'s `REGISTERED_ENGINES` (it imports a
 *  `?raw` example), so `help-examples.test.ts` holds this list to it. */
export const HELP_ENGINES = [elkDescriptor, gridDescriptor, fixedDescriptor] as const;

/** Every `.md` file under `dir`, as `compileHelp` takes them: the quick start
 *  first, then by path, so the order is the same on every machine. */
export function readHelpDir(dir: string = HELP_DIR): HelpFile[] {
  const out: HelpFile[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push({ path: relative(dir, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  const rank = (p: string): number => (p === 'quickstart.md' ? 0 : 1);
  return out.sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The help content as the build compiles it: the files in `dir`, checked against the reference's ids. */
export function compileHelpDir(dir: string = HELP_DIR): HelpContent {
  return compileHelp(readHelpDir(dir), { knownIds: referenceIds(buildReference(HELP_ENGINES)) });
}

export function helpContentPlugin(dir: string = HELP_DIR): Plugin {
  return {
    name: 'sgl-help-content',
    buildStart() {
      // Throws `HelpBuildError`, listing every problem: the build fails.
      compileHelpDir(dir);
      for (const f of readHelpDir(dir)) this.addWatchFile(join(dir, f.path));
    },
    resolveId(id) {
      return id === HELP_MODULE_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(compileHelpDir(dir))};\n`;
    },
  };
}
