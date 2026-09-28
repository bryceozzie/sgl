import { fnv1a64, shortHash } from '@sgl/core';
import { neutralDark, neutralLight, type ComputedStyle, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { isArrowhead, markerPaintClass, MarkerTable, type Arrowhead } from '../src/markers.js';
import { num } from '../src/num.js';
import { cssColor, hashToken } from '../src/security.js';
import { cascadeSignature, ClassTable, geometryDeclarations, paintDeclarations, type RuleKind, type SignatureRole } from '../src/style.js';
import { listCorpusDocs, renderCorpusDoc } from './pipeline.js';

/**
 * F9 (execution plan §2.1): `ClassTable` and `MarkerTable` compute each class
 * and marker name once per distinct key instead of once per element. Since
 * F7 the key is theme-invariant: a paint class is named after the element's
 * cascade signature (`cascadeSignature`), a marker after (arrowhead, start/end,
 * size, the edge's signature token). The names and rules must be exactly what
 * the per-element computation produces (the goldens in `render.test.ts` are
 * the end-to-end half of that proof). This file is the unit half: every style
 * and every marker the whole corpus uses, under both built-in themes, asked
 * for repeatedly and in two orders, against DD-07 §6's naming rule restated
 * here without any caching.
 */

const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark];
const PREFIX: Readonly<Record<RuleKind, string>> = { shape: 's', text: 't', plate: 'p' };

/** DD-07 §6's class naming, computed from scratch every time. */
function referenceClasses(style: ComputedStyle, kind: RuleKind, signature: string): { readonly names: string; readonly rules: readonly (readonly [string, string])[] } {
  const rules: (readonly [string, string])[] = [];
  const paint = `${PREFIX[kind]}-${hashToken(fnv1a64(signature))}`;
  const paintDecls = paintDeclarations(style.paint, kind);
  if (paintDecls.length > 0) rules.push([paint, paintDecls.join(';')]);
  const geometryDecls = geometryDeclarations(style.geometry, kind);
  const geometry = geometryDecls.length === 0 ? null : `g-${shortHash(geometryDecls.join(';'))}`;
  if (geometry !== null) rules.push([geometry, geometryDecls.join(';')]);
  return { names: [geometry, paint].filter((c): c is string => c !== null).join(' '), rules };
}

/** DD-07 §6's marker id, computed from scratch every time. */
function referenceMarkerId(arrowhead: string, size: number, start: boolean, token: string): string | null {
  if (arrowhead === 'none' || size <= 0) return null;
  return `m-${arrowhead}${start ? '-s' : ''}-${num(size)}-${token}`;
}

interface Use {
  readonly style: ComputedStyle;
  readonly kind: RuleKind;
  readonly signature: string;
}

interface MarkerUse {
  readonly arrowhead: string;
  readonly color: string;
  readonly size: number;
  readonly start: boolean;
  readonly token: string;
}

function call(table: ClassTable, { style, kind, signature }: Use): string {
  return kind === 'shape' ? table.shapeClasses(style, signature) : kind === 'text' ? table.textClasses(style, signature) : table.plateClasses(style, signature);
}

/** Every (style, kind, signature) and every marker `render()` asks for. */
function usesOf(styled: StyledGraph): { readonly uses: readonly Use[]; readonly markers: readonly MarkerUse[] } {
  const uses: Use[] = [];
  const markers: MarkerUse[] = [];
  for (const id of styled.graph.order) {
    const node = styled.graph.nodes[id];
    const style = styled.styles[id];
    if (node === undefined || style === undefined) continue;
    const role = node.children.length > 0 ? 'container' : 'node';
    uses.push({ style, kind: 'shape', signature: cascadeSignature(role, node.shape, node.classes, node.config) });
    const label = node.labelId === null ? undefined : styled.labelStyles[node.labelId];
    if (label !== undefined) uses.push({ style: label, kind: 'text', signature: cascadeSignature(`${role}.title` as SignatureRole, undefined, node.classes, node.config) });
  }
  for (const edge of styled.graph.edges) {
    const style = styled.styles[edge.id];
    if (style === undefined) continue;
    const signature = cascadeSignature('edge', undefined, edge.classes, edge.config);
    uses.push({ style, kind: 'shape', signature }, { style, kind: 'plate', signature });
    const label = edge.labelId === null ? undefined : styled.labelStyles[edge.labelId];
    if (label !== undefined) uses.push({ style: label, kind: 'text', signature: cascadeSignature('edge.label', undefined, edge.classes, edge.config) });
    const stroke = style.paint['stroke'];
    const arrow = style.paint['arrowhead'];
    const size = style.geometry['arrowSize'];
    const marker = {
      arrowhead: isArrowhead(arrow) ? arrow : 'triangle',
      color: typeof stroke === 'string' ? stroke : '#000000',
      size: typeof size === 'number' ? size : 8,
      token: hashToken(fnv1a64(signature)),
    };
    markers.push({ ...marker, start: false }, { ...marker, start: true });
  }
  return { uses, markers };
}

describe('MarkerTable: every part of the key is part of what a cached id stands for (F7, F9)', () => {
  // The corpus uses one arrowhead at one size, so it cannot tell whether a
  // cached id ignores `arrowhead` or `size`: this synthetic cross product can.
  const ARROWHEADS = ['triangle', 'open', 'diamond', 'circle', 'none'] as const;
  const SIZES = [8, 12.5];
  const TOKENS = ['0123456789abcdef', 'fedcba9876543210'];
  const COLORS = ['#8A96A8', '#1F5F80'];
  const cases: MarkerUse[] = [];
  for (const arrowhead of ARROWHEADS) {
    for (const size of SIZES) {
      for (const token of TOKENS) {
        for (const color of COLORS) {
          for (const start of [false, true]) cases.push({ arrowhead, color, size, start, token });
        }
      }
    }
  }

  it(`${cases.length} combinations, each asked for three times and in two orders`, () => {
    for (const order of [cases, [...cases].reverse()]) {
      const table = new MarkerTable();
      const alone = new Map<string, string>();
      const colorsById = new Map<string, Set<string>>();
      for (let pass = 0; pass < 3; pass += 1) {
        for (const m of order) {
          const arrowhead = m.arrowhead as Arrowhead;
          const id = table.add(arrowhead, m.size, m.start, m.token);
          expect(id, JSON.stringify(m)).toBe(referenceMarkerId(m.arrowhead, m.size, m.start, m.token));
          if (id === null) continue;
          if (!alone.has(id)) {
            const fresh = new MarkerTable();
            fresh.add(arrowhead, m.size, m.start, m.token);
            alone.set(id, fresh.emit());
          }
          colorsById.set(id, (colorsById.get(id) ?? new Set()).add(m.color));
        }
      }
      // Every drawn (arrowhead, size, token, start) is its own marker, and the
      // colour is not part of the id: both colours share each one.
      expect(alone.size).toBe(cases.filter((m) => m.arrowhead !== 'none').length / COLORS.length);
      for (const [id, colors] of colorsById) expect(colors.size, id).toBe(COLORS.length);
      // No colour anywhere in <defs>: it is a <style> rule on the shape's class.
      for (const color of COLORS) expect(table.emit()).not.toContain(color);
      // The <defs> are each one's own element, sorted by id.
      expect(table.emit()).toBe([...alone.keys()].sort().map((id) => alone.get(id) as string).join(''));
    }
  });
});

describe('ClassTable/MarkerTable naming is computed once per distinct key, with unchanged output (F7, F9)', () => {
  for (const theme of THEMES) {
    for (const doc of listCorpusDocs()) {
      // A 30 s timeout (07 §2): n2000 through the whole pipeline plus three
      // reference passes takes ~1.6–2.8 s quiet and went over the default 5 s
      // under a full parallel run. These tests check names, not speed, so the
      // timeout is only a hang guard.
      it(`${doc} under ${theme.id}`, async () => {
        const { styled } = await renderCorpusDoc(doc, theme);
        const { uses, markers } = usesOf(styled);

        // Within one render, one signature is one paint: the key is sound.
        const paintBySignature = new Map<string, string>();
        for (const use of uses) {
          const key = `${use.kind}|${use.signature}`;
          const paint = paintDeclarations(use.style.paint, use.kind).join(';');
          expect(paintBySignature.get(key) ?? paint, key).toBe(paint);
          paintBySignature.set(key, paint);
        }

        // Each name equals the reference, on first sight and on every repeat.
        const table = new ClassTable();
        const expectedRules = new Map<string, string>();
        for (let pass = 0; pass < 3; pass += 1) {
          for (const use of uses) {
            const ref = referenceClasses(use.style, use.kind, use.signature);
            expect(call(table, use)).toBe(ref.names);
            for (const [name, body] of ref.rules) expectedRules.set(name, body);
          }
        }
        const expectedEmit = [...expectedRules.keys()].sort().map((name) => `.${name}{${expectedRules.get(name) as string}}`);
        expect(table.emit()).toEqual(expectedEmit);

        // The same styles met in the reverse order emit the same rules.
        const reversed = new ClassTable();
        for (const use of [...uses].reverse()) call(reversed, use);
        expect(reversed.emit()).toEqual(expectedEmit);

        // Markers: each id equals the reference on every repeat, and the
        // emitted <defs> equal each distinct marker built by a table of its
        // own (nothing cached, whatever the implementation), sorted by id.
        const markerTable = new MarkerTable();
        const alone = new Map<string, string>();
        for (let pass = 0; pass < 3; pass += 1) {
          for (const m of markers) {
            const arrowhead = m.arrowhead as Arrowhead;
            const id = markerTable.add(arrowhead, m.size, m.start, m.token);
            expect(id).toBe(referenceMarkerId(m.arrowhead, m.size, m.start, m.token));
            if (id !== null && !alone.has(id)) {
              const fresh = new MarkerTable();
              fresh.add(arrowhead, m.size, m.start, m.token);
              alone.set(id, fresh.emit());
            }
          }
        }
        expect(markerTable.emit()).toBe([...alone.keys()].sort().map((id) => alone.get(id) as string).join(''));

        // And each marker's colour rule is the edge's stroke, validated.
        const colorRules = new ClassTable();
        for (const m of markers) {
          if (referenceMarkerId(m.arrowhead, m.size, m.start, m.token) === null) continue;
          colorRules.markerPaint(markerPaintClass(m.arrowhead as Arrowhead, m.token), m.arrowhead === 'open', m.color);
        }
        for (const rule of colorRules.emit()) expect(rule).toMatch(/^\.m[fs]-[0-9a-f]{16}\{(?:fill|stroke):[^;{}]+\}$/);
        for (const m of markers.filter((x) => x.arrowhead !== 'none')) {
          expect(colorRules.emit()).toContain(`.${markerPaintClass(m.arrowhead as Arrowhead, m.token)}{${m.arrowhead === 'open' ? 'stroke' : 'fill'}:${cssColor(m.color)}}`);
        }
      }, 30_000);
    }
  }
});
