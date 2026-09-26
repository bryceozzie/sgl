import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The generated parser is committed (DD-10 §3), so this runs without the generator.
import { parser } from '../src/grammar/sgl.parser.js';
import { CATALOGUE } from '../src/diagnostics.js';
import { matchesWildcard, type WildcardStep } from '../src/ast.js';

/** Count the error nodes Lezer's recovery left behind. */
function errorCount(source: string): number {
  const cursor = parser.parse(source).cursor();
  let n = 0;
  do {
    if (cursor.type.isError) n += 1;
  } while (cursor.next());
  return n;
}

/** The node type names in document order, for asserting on tokenisation. */
function nodeNames(source: string): string[] {
  const cursor = parser.parse(source).cursor();
  const names: string[] = [];
  do {
    names.push(cursor.type.name);
  } while (cursor.next());
  return names;
}

const corpus = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../corpus/${name}`, import.meta.url)), 'utf8');

describe('wildcard endpoints', () => {
  it.each([
    ['fan-out over children', 'lane1.* -> switch'],
    ['reversed', 'switch -> lane1.*'],
    ['descendants', 'lane1.** -> switch'],
    ['both sides — cross product', 'lane1.* -> lane2.*'],
    ['root-absolute', '/platform.* -> switch'],
    ['parent-relative', '../lane1.* -> switch'],
    ['quoted prefix', '"order lane".* -> switch'],
    ['with a port', 'lane1.*[out] -> switch'],
    ['with a label', 'lane1.* -> switch: "joins"'],
    ['in a chain', 'a.* -> b -> c.*'],
  ])('parses %s', (_name, source) => {
    expect(errorCount(source)).toBe(0);
  });

  it('lexes ** as one token, not two', () => {
    const names = nodeNames('lane1.** -> switch');
    expect(names.filter((n) => n === 'Wildcard')).toHaveLength(1);
  });

  it.each([
    ['prefix', 'lane1.cam* -> switch'],
    ['prefix ending in a dash', 'lane1.order-* -> switch'],
    ['suffix', 'lane1.*-db -> switch'],
    ['both ends', 'lane1.cam*hd -> switch'],
    ['globs on both sides', 'lane1.cam* -> lane2.rec*'],
    ['glob with a port', 'lane1.cam*[out] -> switch'],
    ['glob in a chain', 'a.cam* -> b -> c.rec*'],
  ])('parses a %s glob', (_name, source) => {
    expect(errorCount(source)).toBe(0);
  });

  // The token has to reach its star without swallowing the dash of a following
  // arrow. An earlier draft that allowed a bare trailing `-` did exactly that.
  it.each([
    ['lane1.*->switch', ['Wildcard', 'EdgeOp']],
    ['lane1.**->switch', ['Wildcard', 'EdgeOp']],
    ['lane1.cam*->switch', ['Wildcard', 'EdgeOp']],
    ['lane1.order-*->switch', ['Wildcard', 'EdgeOp']],
    ['a-b->c', ['Identifier', 'EdgeOp']],
  ])('keeps the arrow intact with no spaces in %s', (source, expected) => {
    expect(errorCount(source)).toBe(0);
    const names = nodeNames(source);
    for (const type of expected) expect(names).toContain(type);
  });

  it('captures the glob text in the token', () => {
    const tree = parser.parse('lane1.order-* -> switch');
    const cursor = tree.cursor();
    let text = '';
    do {
      if (cursor.type.name === 'Wildcard') text = 'lane1.order-* -> switch'.slice(cursor.from, cursor.to);
    } while (cursor.next());
    expect(text).toBe('order-*');
  });

  it.each([
    ['two stars in one segment', 'lane1.a*b*c -> switch'],
    ['a glob combined with **', 'lane1.cam** -> switch'],
  ])('rejects %s', (_name, source) => {
    // Both fall out of the token shape rather than needing a rule: the bare and
    // glob alternatives cannot combine, so these simply do not lex.
    expect(errorCount(source)).toBeGreaterThan(0);
  });

  it('accepts a mid-path wildcard, leaving it to the compiler to reject', () => {
    // DD-01 §2: the grammar describes shape, later stages describe meaning. A
    // mid-path wildcard must still produce a usable tree so the editor keeps
    // highlighting the rest of the line — DD-03 §3.1 emits SGL3004 with a span.
    expect(errorCount('lane1.*.handler -> switch')).toBe(0);
  });

  it('confines wildcards to edge endpoints', () => {
    // `Path` is reachable only from `Endpoint`, so `*` in a node key has nowhere
    // to go. This is the property that keeps §7 selectors out of the edge syntax.
    expect(errorCount('*: { @label: "nope" }')).toBeGreaterThan(0);
  });

  it.each(['wildcards.sgl', 'wildcard-globs.sgl', 'wildcard-paths.sgl'])('parses %s clean', (name) => {
    expect(errorCount(corpus(name))).toBe(0);
  });
});

describe('matchesWildcard', () => {
  const step = (prefix: string, suffix: string): WildcardStep => ({
    kind: 'Wildcard',
    depth: 'children',
    prefix,
    suffix,
    span: { from: 0, to: 0 },
  });

  it('matches a bare wildcard against anything', () => {
    for (const key of ['', 'a', 'cam1', 'order service']) {
      expect(matchesWildcard(step('', ''), key)).toBe(true);
    }
  });

  it('matches on a prefix', () => {
    const cam = step('cam', '');
    expect(['cam1', 'cam2', 'cam-hd', 'camera', 'cam'].every((k) => matchesWildcard(cam, k))).toBe(true);
    expect(['mic1', 'webcam', 'Cam1'].some((k) => matchesWildcard(cam, k))).toBe(false);
  });

  it('matches on a suffix', () => {
    const db = step('', '-db');
    expect(matchesWildcard(db, 'orders-db')).toBe(true);
    expect(matchesWildcard(db, 'cache')).toBe(false);
  });

  it('matches on both ends at once', () => {
    const camHd = step('cam', 'hd');
    expect(matchesWildcard(camHd, 'camAhd')).toBe(true);
    expect(matchesWildcard(camHd, 'camB')).toBe(false);
  });

  it('does not let a prefix and suffix overlap in a short key', () => {
    // Without the length guard, `ca*am` matches `cam`: the same three characters
    // satisfy startsWith('ca') and endsWith('am') simultaneously.
    expect(matchesWildcard(step('ca', 'am'), 'cam')).toBe(false);
    expect(matchesWildcard(step('ca', 'am'), 'caam')).toBe(true);
  });

  it('is case-sensitive, like every other path reference', () => {
    expect(matchesWildcard(step('cam', ''), 'CAM1')).toBe(false);
  });

  it('matches a quoted key on its decoded text', () => {
    expect(matchesWildcard(step('order', ''), 'order service')).toBe(true);
  });
});

describe('the grammar at large', () => {
  it.each([
    'empty.sgl',
    'single.sgl',
    'nesting-3.sgl',
    'chains.sgl',
    'parallel-selfloop.sgl',
    'ports.sgl',
    'classes.sgl',
    'containers-edges.sgl',
    'shapes.sgl',
    'unicode.sgl',
    'hidden.sgl',
    'wildcards.sgl',
    'wildcard-globs.sgl',
    'wildcard-paths.sgl',
    'variables.sgl',
    // Both were tracked as known grammar defects (README → Open questions) until
    // Stage A: checkout.sgl needed the `$name` Variable token, json-form.sgl.json
    // needed a quoted spelling of ConfigKey (ConfigString) so strict JSON can
    // hold a config entry at all.
    'checkout.sgl',
    'json-form.sgl.json',
  ])('parses %s with no error nodes', (name) => {
    expect(errorCount(corpus(name))).toBe(0);
  });
});

describe('diagnostic catalogue', () => {
  it('allocates the wildcard codes in the semantic range', () => {
    for (const code of ['SGL3003', 'SGL3004', 'SGL3005'] as const) {
      expect(CATALOGUE).toHaveProperty(code);
    }
    expect(CATALOGUE.SGL3003.severity).toBe('warning');
    expect(CATALOGUE.SGL3004.severity).toBe('error');
    expect(CATALOGUE.SGL3005.severity).toBe('error');
  });

  it('gives every code a message template that names its subject', () => {
    for (const [code, spec] of Object.entries(CATALOGUE)) {
      expect(spec.template.endsWith('.'), `${code} is not a complete sentence`).toBe(true);
    }
  });
});

describe('qualified names (A9, I16; DD-01 §2)', () => {
  /** The text of every node named `name`, in document order. */
  const texts = (source: string, name: string): string[] => {
    const out: string[] = [];
    const cursor = parser.parse(source).cursor();
    do {
      if (cursor.type.name === name) out.push(source.slice(cursor.from, cursor.to));
    } while (cursor.next());
    return out;
  };

  it.each([
    ['the class shorthand', 'lambda: aws.Lambda', 'ClassRef', ['aws.Lambda']],
    ['a composed qualifier', 'lambda: b.c.Lambda', 'ClassRef', ['b.c.Lambda']],
    ['@type, one name', '@type: aws.Lambda', 'Word', ['aws.Lambda']],
    ['@type, a list', 'x: { @type: [aws.Lambda, Service, b.c.D] }', 'Word', ['aws.Lambda', 'Service', 'b.c.D']],
    ['@extends in a class body', '@classes: { S: { @extends: lib.Service } }', 'Word', ['lib.Service']],
    ['a qualified variable', 'a: { @style.stroke: $aws.brand }', 'Variable', ['$aws.brand']],
    ['a composed variable', 'a: { @label: $b.c.x }', 'Variable', ['$b.c.x']],
  ])('parses %s', (_name, source, node, expected) => {
    expect(errorCount(source)).toBe(0);
    expect(texts(source, node)).toEqual(expected);
  });

  it('keeps a following `../` edge a Parent token, not a qualifier (@precedence { Parent, "." })', () => {
    const source = 'x: {\n  a: Service\n  ../b -> c\n}\n';
    expect(errorCount(source)).toBe(0);
    expect(texts(source, 'ClassRef')).toEqual(['Service']);
    expect(texts(source, 'Parent')).toEqual(['../']);
  });

  it('keeps a following root-level edge its own statement', () => {
    const source = 'a: Service\nb.c -> d\n';
    expect(errorCount(source)).toBe(0);
    expect(texts(source, 'ClassRef')).toEqual(['Service']);
    expect(texts(source, 'EdgeStmt')).toEqual(['b.c -> d']);
  });

  it.each([
    ['a trailing dot', 'a: B.'],
    ['a qualifier with no name', 'a: .B'],
    ['a dotted node key', 'a.b: C'],
    ['a trailing dot on a variable', '@x: $a.'],
    ['a variable qualifier in a key', '$a.b: 1'],
  ])('still rejects %s', (_name, source) => {
    expect(errorCount(source)).toBeGreaterThan(0);
  });
});
