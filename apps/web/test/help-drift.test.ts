import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { compileHelp, HelpBuildError } from '../build/help-content.js';
import { compileHelpDir, HELP_ENGINES, HELP_MODULE_ID, helpContentPlugin, readHelpDir } from '../build/help-plugin.js';
import type { HelpContent } from '../src/help/content.js';
import { joinHelp, QUICKSTART_ID, referenceIds } from '../src/help/join.js';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { buildReference } from '../src/reference/build.js';
import viteConfig from '../vite.config.js';
import { diagProofProblems, driftProblems, ENFORCED_KINDS, helpFileFor } from './help-check.js';

/**
 * DD-13 §4 (help branch 2): the join and the no-drift guarantee. The checks
 * are `help-check.ts`'s; each is shown failing on content made to break it,
 * then passing on the real content, compiled exactly as the build compiles
 * it (`compileHelpDir`) and joined exactly as the app joins it (`joinHelp`).
 */

const reference = buildReference(REGISTERED_ENGINES);
const md = (...files: readonly [string, string][]): HelpContent => compileHelp(files.map(([path, text]) => ({ path, text })));

describe('joinHelp (DD-13 P15)', () => {
  const content = md(
    ['topics/a.md', '# A topic {#topic/a}\n\nA.\n'],
    ['quickstart.md', '# Quick start {#topic/quickstart}\n\nQ.\n'],
    ['keys/pin.md', '# Pin {#key/pin}\n\nPins.\n'],
    ['keys/icon.md', '# Icon {#key/icon}\n\nNot a key.\n'],
  );
  const table = joinHelp(reference, content);

  it('the quick start first, then the other topics, then every fact in the reference\'s order', () => {
    const ids = table.entries.map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual([QUICKSTART_ID, 'topic/a']);
    expect(ids.slice(2, 2 + reference.keys.length)).toEqual(reference.keys.map((k) => k.id));
    expect(ids).toContain('style/fill');
    expect(ids).toContain('hint/grid.span');
    expect(ids[ids.length - 1]).toBe(reference.diagnostics[reference.diagnostics.length - 1]!.id);
  });

  it('both: a fact with its prose; generated only: the written form as its title', () => {
    expect(table.get('key/pin')).toMatchObject({ kind: 'key', title: 'Pin', fact: { kind: 'key', fact: { written: '@pin' } }, content: { summary: [{ text: 'Pins.' }] } });
    const size = table.get('key/size.maxWidth')!;
    expect(size.title).toBe('@size.maxWidth');
    expect(size.content).toBeUndefined();
    expect(table.get('diag/SGL2010')!.title).toBe('SGL2010');
  });

  it('hand-written only: a topic; an entry naming no fact is unmatched, not an entry', () => {
    expect(table.get('topic/a')).toMatchObject({ kind: 'topic', title: 'A topic' });
    expect(table.get('topic/a')!.fact).toBeUndefined();
    expect(table.unmatched.map((e) => e.id)).toEqual(['key/icon']);
    expect(table.get('key/icon')).toBeUndefined();
  });

  it('key/style.fill is the entry style/fill under a second id (help branch 1\'s alias)', () => {
    const fill = table.get('key/style.fill');
    expect(fill).toBe(table.get('style/fill'));
    expect(fill!.aliases).toEqual(['key/style.fill']);
    expect(referenceIds(reference)).toContain('key/style.fill');
    expect(table.entries.filter((e) => e.id === 'key/style.fill')).toEqual([]);
  });
});

describe('the drift checks fail on content made to break them (DD-13 P16, P17, P19)', () => {
  const keyOnly = (text: string): readonly string[] => driftProblems(reference, md(['keys/pin.md', text]), []);

  it('P17.1: a fact of an enforced kind with no entry, naming the file it belongs in', () => {
    const problems = driftProblems(reference, md(['keys/pin.md', '# Pin {#key/pin}\n\nS.\n']), ['key']);
    expect(problems).toContain('key/size.maxWidth: no help entry; write it in apps/web/help/keys/size.md');
    expect(problems.some((p) => p.startsWith('key/pin:'))).toBe(false);
    expect(helpFileFor('diag/SGL2010')).toBe('diagnostics/2xxx.md');
    expect(helpFileFor('option/elk.direction')).toBe('engines/elk.md');
  });

  it('P17.2: an entry naming a fact that does not exist', () => {
    expect(keyOnly('# Icon {#key/icon}\n\nS.\n')).toEqual(['key/icon (keys/pin.md): names no fact of this build']);
  });

  it('P17.3: a link, See also or Diagnostics naming nothing', () => {
    expect(keyOnly('# Pin {#key/pin}\n\nSee [x](#help/key/nope).\n')).toEqual(['key/pin (keys/pin.md): a link to no entry `key/nope`']);
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\nSee also: [x](#help/style/nope)\n')).toEqual(['key/pin (keys/pin.md): See also names no entry `style/nope`']);
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\nDiagnostics: SGL2999\n')).toContain('key/pin (keys/pin.md): Diagnostics names no code `SGL2999`');
  });

  it('P17.4: `@name` in prose that is no key, style, option or token; not inside a Wrong note', () => {
    expect(keyOnly('# Pin {#key/pin}\n\nUse `@icon` here.\n')).toEqual(['key/pin (keys/pin.md): `@icon` is not a key, style property, engine option or token of this build']);
    expect(keyOnly('# Pin {#key/pin}\n\nUse `@pin`, `@size.maxWidth`, `@style.fill`, `@layout.direction`, `@layout.*` and `@surface.sunken`.\n')).toEqual([]);
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\n> **Wrong.** `@icon` is not a key.\n')).toEqual([]);
  });

  it('P17.5: a summary over 200 characters', () => {
    expect(keyOnly(`# Pin {#key/pin}\n\n${'x'.repeat(201)}\n`)).toEqual(['key/pin (keys/pin.md): the summary is 201 characters; at most 200']);
  });

  it('P16: a key entry repeating its values in a table', () => {
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\n| Values | Meaning |\n|---|---|\n| a | b |\n')).toEqual(['key/pin (keys/pin.md): a "Values" table repeats the facts panel (DD-13 P16)']);
  });

  it('P19: a listed diagnostic none of the entry\'s examples expects; an unregistered engine', () => {
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\nDiagnostics: SGL4021\n\n```sgl example title="T"\na\n```\n')).toEqual(['key/pin (keys/pin.md): lists SGL4021, but none of its examples expects it']);
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\nDiagnostics: SGL4021\n\n```sgl example title="T" expect=SGL4021\na: { @pin: { x: 0, y: 0 } }\n```\n')).toEqual([]);
    expect(keyOnly('# Pin {#key/pin}\n\nS.\n\n```sgl example title="T" engine=force\na\n```\n')).toEqual(['key/pin#1: engine=force is not a registered engine']);
  });

  it('HD4: once diag is enforced, a document-reachable code with no example proving it', () => {
    const content = md(['diagnostics/2xxx.md', '# Unknown key {#diag/SGL2010}\n\nS.\n\n# Load failed {#diag/SGL2027}\n\nS.\n']);
    expect(diagProofProblems(content, ['key'])).toEqual([]);
    expect(diagProofProblems(content, ['key', 'diag'])).toEqual(['diag/SGL2010 (diagnostics/2xxx.md): no example proves a document can cause SGL2010']);
    const proved = md(['diagnostics/2xxx.md', '# Unknown key {#diag/SGL2010}\n\nS.\n\n```sgl example title="T" expect=SGL2010\na: { @nope: 1 }\n```\n']);
    expect(diagProofProblems(proved, ['key', 'diag'])).toEqual([]);
  });
});

describe('the real help content has no drift (DD-13 §4)', () => {
  const content = compileHelpDir();

  it('this branch enforces the keys (DD-13 §13 branch 2); branch 3 extends the list', () => {
    expect(ENFORCED_KINDS).toEqual(['key']);
  });

  it('every check passes', () => {
    expect(driftProblems(reference, content)).toEqual([]);
    expect(diagProofProblems(content)).toEqual([]);
  });

  it('every key has an entry of its own, and the quick start exists', () => {
    const table = joinHelp(reference, content);
    for (const k of reference.keys) expect(table.get(k.id)?.content?.id, k.id).toBe(k.id);
    expect(table.entries[0]!.id).toBe(QUICKSTART_ID);
  });
});

describe('the virtual:sgl-help-content plugin (DD-13 P13)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const tempHelp = (files: Readonly<Record<string, string>>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sgl-help-'));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  type Hook = (this: { addWatchFile(f: string): void }, id?: string) => unknown;
  const hook = (p: Plugin, name: 'buildStart' | 'resolveId' | 'load'): Hook => p[name] as unknown as Hook;
  const ctx = { addWatchFile: () => undefined };

  it('is in the app\'s build, and the engines it checks against are the ones the app registers', () => {
    const plugins = (viteConfig as { plugins: unknown[] }).plugins.flat() as Plugin[];
    expect(plugins.some((p) => p?.name === 'sgl-help-content')).toBe(true);
    expect(HELP_ENGINES.map((e) => e.id)).toEqual(REGISTERED_ENGINES.map((e) => e.id));
  });

  it('serves the compiled content as the virtual module\'s default export', () => {
    const plugin = helpContentPlugin();
    expect(hook(plugin, 'resolveId').call(ctx, HELP_MODULE_ID)).toBe(`\0${HELP_MODULE_ID}`);
    expect(hook(plugin, 'resolveId').call(ctx, 'other')).toBeUndefined();
    const code = hook(plugin, 'load').call(ctx, `\0${HELP_MODULE_ID}`) as string;
    expect(code.startsWith('export default ')).toBe(true);
    expect(JSON.parse(code.slice('export default '.length).replace(/;\n$/, ''))).toEqual(compileHelpDir());
  });

  it('reads the quick start first, then files by path', () => {
    const dir = tempHelp({ 'topics/b.md': '# B {#topic/b}\n\nB.\n', 'keys/a.md': '# A {#key/pin}\n\nA.\n', 'quickstart.md': '# Q {#topic/quickstart}\n\nQ.\n' });
    expect(readHelpDir(dir).map((f) => f.path)).toEqual(['quickstart.md', 'keys/a.md', 'topics/b.md']);
  });

  it('fails the build at buildStart for bad content, even with nothing importing the module', () => {
    const good = tempHelp({ 'quickstart.md': '# Q {#topic/quickstart}\n\nSee [pin](#help/key/pin).\n' });
    expect(() => hook(helpContentPlugin(good), 'buildStart').call(ctx)).not.toThrow();
    for (const bad of ['Some <b>HTML</b>.', 'An ![image](#help/key/pin).', 'A [link](https://example.com).', 'A [link](#help/key/nope).']) {
      const dir = tempHelp({ 'quickstart.md': `# Q {#topic/quickstart}\n\n${bad}\n` });
      expect(() => hook(helpContentPlugin(dir), 'buildStart').call(ctx), bad).toThrow(HelpBuildError);
    }
    const icon = tempHelp({ 'keys/icon.md': '# Icon {#key/icon}\n\nS.\n' });
    expect(() => hook(helpContentPlugin(icon), 'buildStart').call(ctx)).toThrow(/`key\/icon` names no fact/);
  });
});
