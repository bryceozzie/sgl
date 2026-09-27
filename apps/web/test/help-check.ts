import type { Block, ExampleSpec, HelpContent, HelpEntry, HelpKind, Run } from '../src/help/content.js';
import { runsText } from '../src/help/content.js';
import { joinHelp, referenceFacts } from '../src/help/join.js';
import type { Reference } from '../src/reference/types.js';

/**
 * The no-drift checks (DD-13 §4, P16, P17, P19), as pure functions from the
 * reference and the compiled content to a list of problems, so a test can
 * prove each one fails on content made to break it (`help-drift.test.ts`)
 * and passes on the real content.
 */

/**
 * The generated kinds whose every fact must have a hand-written entry
 * (DD-13 P17 item 1). Help branch 2 writes the keys; branch 3
 * (`feat/help-content-2`) writes the rest and makes this every generated kind
 * but `token` and `hint`, which are listed in their theme or engine entry.
 */
export const ENFORCED_KINDS: readonly HelpKind[] = ['key'];

/**
 * Codes no document can cause (DD-13 P19, HD4): the two coverage gates'
 * allowlists. An engine timeout or failure, invalid engine geometry, a failed
 * chunk load. `SGL5001`, `SGL5002` and `SGL5006` need a theme file, which a
 * document cannot supply. Branch 3 confirms this list when it writes `diag`.
 */
export const NOT_DOCUMENT_REACHABLE: ReadonlySet<string> = new Set(['SGL2027', 'SGL4001', 'SGL4002', 'SGL4003', 'SGL4011', 'SGL5001', 'SGL5002', 'SGL5006', 'SGL6002']);

const SUMMARY_MAX = 200;

/** Where a missing entry belongs (DD-13 P9). */
export function helpFileFor(id: string): string {
  const slash = id.indexOf('/');
  const kind = id.slice(0, slash);
  const name = id.slice(slash + 1);
  switch (kind) {
    case 'key':
      return `keys/${name.split('.')[0]}.md`;
    case 'style':
      return 'styles.md';
    case 'shape':
      return 'shapes.md';
    case 'theme':
    case 'token':
      return 'themes.md';
    case 'engine':
    case 'option':
    case 'hint':
      return `engines/${name.split('.')[0]}.md`;
    case 'diag':
      return `diagnostics/${name.charAt(3)}xxx.md`;
    default:
      return name === 'quickstart' ? 'quickstart.md' : `topics/${name}.md`;
  }
}

/** Every run in an entry's prose, with whether it sits in a `> **Wrong.**` note. */
function eachRun(entry: HelpEntry, fn: (run: Run, wrong: boolean) => void): void {
  const runs = (list: readonly Run[], wrong: boolean): void => {
    for (const r of list) {
      fn(r, wrong);
      if ('link' in r) for (const inner of r.runs) fn(inner, wrong);
    }
  };
  const walk = (blocks: readonly Block[], wrong: boolean): void => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading':
        case 'paragraph':
          runs(b.runs, wrong);
          break;
        case 'list':
          for (const item of b.items) {
            runs(item.runs, wrong);
            for (const sub of item.sub?.items ?? []) runs(sub.runs, wrong);
          }
          break;
        case 'table':
          for (const cell of [...b.head, ...b.rows.flat()]) runs(cell, wrong);
          break;
        case 'note': {
          const first = b.blocks[0];
          const lead = first?.type === 'paragraph' ? first.runs[0] : undefined;
          walk(b.blocks, wrong || (lead !== undefined && !('link' in lead) && lead.strong === true && lead.text === 'Wrong.'));
          break;
        }
        case 'code':
        case 'example':
          break;
      }
    }
  };
  runs(entry.summary, false);
  walk(entry.blocks, false);
}

/** Every example and snippet in an entry, notes included. */
export function examplesOf(entry: HelpEntry): readonly ExampleSpec[] {
  const out: ExampleSpec[] = [];
  const walk = (blocks: readonly Block[]): void => {
    for (const b of blocks) {
      if (b.type === 'example') out.push(b.example);
      else if (b.type === 'note') walk(b.blocks);
    }
  };
  walk(entry.blocks);
  return out;
}

/** A code span that looks like a key: `@name` or `@a.b` (DD-13 P17 item 4). */
const KEY_SPAN = /^@[A-Za-z_][\w-]*(?:\.[\w*-]+)*$/;

/** DD-13 P16, P17 and P19's static half, over `kinds`. Empty when the content is sound. */
export function driftProblems(reference: Reference, content: HelpContent, kinds: readonly HelpKind[] = ENFORCED_KINDS): readonly string[] {
  const problems: string[] = [];
  const table = joinHelp(reference, content);

  // P17 item 1: every fact of an enforced kind has prose.
  for (const f of referenceFacts(reference)) {
    if ((kinds as readonly string[]).includes(f.kind) && table.get(f.fact.id)?.content === undefined) {
      problems.push(`${f.fact.id}: no help entry; write it in apps/web/help/${helpFileFor(f.fact.id)}`);
    }
  }
  // P17 item 2: every hand-written entry of a generated kind names a fact.
  for (const e of table.unmatched) problems.push(`${e.id} (${e.file}): names no fact of this build`);

  const codes = new Set(reference.diagnostics.map((d) => d.code));
  const known = new Set<string>([
    ...reference.keys.map((k) => k.written),
    ...reference.styles.map((s) => s.written),
    ...reference.engines.flatMap((e) => [...e.options, ...e.hints].map((o) => o.written)),
    ...reference.tokens.map((t) => t.written),
  ]);
  const engines = new Set(reference.engines.map((e) => e.bareName));
  const ids = new Set<string>();

  for (const e of content.entries) {
    const at = `${e.id} (${e.file})`;
    // P17 item 5.
    if (ids.has(e.id)) problems.push(`${at}: a second entry with this id`);
    ids.add(e.id);
    const summary = runsText(e.summary);
    if (summary.length > SUMMARY_MAX) problems.push(`${at}: the summary is ${summary.length} characters; at most ${SUMMARY_MAX}`);
    // P17 item 3: links, See also and Diagnostics name what exists.
    for (const target of e.seeAlso) if (table.get(target) === undefined) problems.push(`${at}: See also names no entry \`${target}\``);
    for (const code of e.diagnostics) if (!codes.has(code)) problems.push(`${at}: Diagnostics names no code \`${code}\``);
    eachRun(e, (r, wrong) => {
      if ('link' in r) {
        if (table.get(r.link) === undefined) problems.push(`${at}: a link to no entry \`${r.link}\``);
      } else if (r.code === true && !wrong && KEY_SPAN.test(r.text) && !known.has(r.text)) {
        // P17 item 4: `@name` in prose is a real key, style, option or token.
        problems.push(`${at}: \`${r.text}\` is not a key, style property, engine option or token of this build`);
      }
    });
    // P16: the facts panel shows the values; prose never repeats them in a table.
    if (e.kind === 'key') {
      for (const b of e.blocks) {
        if (b.type === 'table' && /^values?$/i.test(runsText(b.head[0] ?? []).trim())) problems.push(`${at}: a "Values" table repeats the facts panel (DD-13 P16)`);
      }
    }
    const examples = examplesOf(e);
    for (const x of examples) {
      if (x.engine !== undefined && !engines.has(x.engine)) problems.push(`${x.id}: engine=${x.engine} is not a registered engine`);
    }
    // P19, strictly: each code the entry lists is proved by one of its own
    // examples, whose `expect` `help-examples.test.ts` then holds to the pipeline.
    for (const code of e.diagnostics) {
      if (!examples.some((x) => x.mode === 'example' && x.expect.includes(code))) problems.push(`${at}: lists ${code}, but none of its examples expects it`);
    }
  }
  return problems;
}

/**
 * HD4 (DD-13 P19): every `diag` entry for a code a document can cause has an
 * example proved to cause it. Applies once `diag` is an enforced kind.
 */
export function diagProofProblems(content: HelpContent, kinds: readonly HelpKind[] = ENFORCED_KINDS, unreachable: ReadonlySet<string> = NOT_DOCUMENT_REACHABLE): readonly string[] {
  if (!kinds.includes('diag')) return [];
  const problems: string[] = [];
  for (const e of content.entries) {
    if (e.kind !== 'diag' || unreachable.has(e.name)) continue;
    if (!examplesOf(e).some((x) => x.mode === 'example' && x.expect.includes(e.name))) problems.push(`${e.id} (${e.file}): no example proves a document can cause ${e.name}`);
  }
  return problems;
}
