import { shortHash } from '@sgl/core';
import { neutralDark, neutralLight, type ComputedStyle, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { isArrowhead, MarkerTable } from '../src/markers.js';
import { num } from '../src/num.js';
import { cssColor, hashToken } from '../src/security.js';
import { ClassTable, geometryDeclarations, paintDeclarations, type RuleKind } from '../src/style.js';
import { listCorpusDocs, renderCorpusDoc } from './pipeline.js';

/**
 * F9 (execution plan §2.1): `ClassTable` and `MarkerTable` compute each class
 * and marker name once per distinct style instead of once per element. The
 * names and rules must be exactly what the per-element computation produced,
 * so every golden stays byte-identical (the goldens in `render.test.ts` are
 * the end-to-end half of that proof). This file is the unit half: every style
 * and every marker the whole corpus uses, under both built-in themes, asked
 * for repeatedly and in two orders, against the naming rule of DD-07 §6
 * restated here without any caching.
 */

const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark];
const PREFIX: Readonly<Record<RuleKind, string>> = { shape: 's', text: 't', plate: 'p' };

/** DD-07 §6's class naming, computed from scratch every time. */
function referenceClasses(style: ComputedStyle, kind: RuleKind): { readonly names: string; readonly rules: readonly (readonly [string, string])[] } {
  const rules: (readonly [string, string])[] = [];
  const paintDecls = paintDeclarations(style.paint, kind);
  const paint = paintDecls.length === 0 ? null : `${PREFIX[kind]}-${hashToken(style.paintHash)}`;
  if (paint !== null) rules.push([paint, paintDecls.join(';')]);
  const geometryDecls = geometryDeclarations(style.geometry, kind);
  const geometry = geometryDecls.length === 0 ? null : `g-${shortHash(geometryDecls.join(';'))}`;
  if (geometry !== null) rules.push([geometry, geometryDecls.join(';')]);
  return { names: [geometry, paint].filter((c): c is string => c !== null).join(' '), rules };
}

/** DD-07 §6's marker id, computed from scratch every time. */
function referenceMarkerId(arrowhead: string, color: string, size: number, start: boolean): string | null {
  if (arrowhead === 'none' || size <= 0) return null;
  return `m-${arrowhead}${start ? '-s' : ''}-${hashToken(shortHash(`${cssColor(color)}|${num(size)}`))}`;
}

interface Use {
  readonly style: ComputedStyle;
  readonly kind: RuleKind;
}

interface MarkerUse {
  readonly arrowhead: string;
  readonly color: string;
  readonly size: number;
  readonly start: boolean;
}

function call(table: ClassTable, { style, kind }: Use): string {
  return kind === 'shape' ? table.shapeClasses(style) : kind === 'text' ? table.textClasses(style) : table.plateClasses(style);
}

describe('ClassTable/MarkerTable naming is computed once per distinct style, with unchanged output (F9)', () => {
  for (const theme of THEMES) {
    for (const doc of listCorpusDocs()) {
      it(`${doc} under ${theme.id}`, async () => {
        const { styled } = await renderCorpusDoc(doc, theme);
        const uses: Use[] = [];
        const markers: MarkerUse[] = [];
        for (const style of Object.values(styled.styles) as ComputedStyle[]) {
          uses.push({ style, kind: 'shape' }, { style, kind: 'plate' });
          const stroke = style.paint['stroke'];
          const arrow = style.paint['arrowhead'];
          const size = style.geometry['arrowSize'];
          const marker = {
            arrowhead: isArrowhead(arrow) ? arrow : 'triangle',
            color: typeof stroke === 'string' ? stroke : '#000000',
            size: typeof size === 'number' ? size : 8,
          };
          markers.push({ ...marker, start: false }, { ...marker, start: true });
        }
        for (const style of Object.values(styled.labelStyles) as ComputedStyle[]) uses.push({ style, kind: 'text' });

        // Each name equals the reference, on first sight and on every repeat.
        const table = new ClassTable();
        const expectedRules = new Map<string, string>();
        for (let pass = 0; pass < 3; pass += 1) {
          for (const use of uses) {
            const ref = referenceClasses(use.style, use.kind);
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
            const arrowhead = m.arrowhead as Parameters<MarkerTable['add']>[0];
            const id = markerTable.add(arrowhead, m.color, m.size, m.start);
            expect(id).toBe(referenceMarkerId(m.arrowhead, m.color, m.size, m.start));
            if (id !== null && !alone.has(id)) {
              const fresh = new MarkerTable();
              fresh.add(arrowhead, m.color, m.size, m.start);
              alone.set(id, fresh.emit());
            }
          }
        }
        expect(markerTable.emit()).toBe([...alone.keys()].sort().map((id) => alone.get(id) as string).join(''));
      });
    }
  }
});
