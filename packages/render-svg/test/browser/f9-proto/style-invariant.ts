/**
 * F9 PHASE 1 PROTOTYPE: measurement only, not production code.
 *
 * A fork of `src/style.ts`'s `ClassTable` whose paint classes (`s-`/`t-`/`p-`)
 * are keyed on a theme-invariant signature instead of `paintHash`: a hash of
 * the element's cascade **inputs** (role, shape, author classes, inline
 * `style`), which DD-04 §4 turns into the same `ComputedStyle` under any one
 * theme. Two elements with the same signature therefore share paint under
 * every theme, so the class is still a valid dedup key, and switching theme
 * changes only the rule bodies in `<style>`, never an element's `class`.
 *
 * The geometry companion (`g-…`) is unchanged: it is keyed on its own
 * declarations, and a paint-only switch leaves geometry equal by definition.
 */

import { shortHash } from '@sgl/core';
import type { ComputedStyle } from '@sgl/theme';
import { hashToken } from '../../../src/security.js';
import { geometryDeclarations, paintDeclarations, type RuleKind } from '../../../src/style.js';

export class InvariantClassTable {
  private readonly rules = new Map<string, string>();

  private add(prefix: string, key: string, declarations: readonly string[]): string | null {
    if (declarations.length === 0) return null;
    const name = `${prefix}-${key}`;
    this.rules.set(name, declarations.join(';'));
    return name;
  }

  shapeClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'shape', 's', signature);
  }

  textClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'text', 't', signature);
  }

  plateClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'plate', 'p', signature);
  }

  private classesFor(style: ComputedStyle, kind: RuleKind, prefix: string, signature: string): string {
    // Note: a class with no declarations under *this* theme is still omitted,
    // as on main. Production would have to emit it unconditionally (an empty
    // rule) so that the `class` attribute cannot differ between themes; the
    // bench fixtures never hit that case (checked by the bench's own
    // "only <style>/<defs> differ" assertion).
    const paint = this.add(prefix, hashToken(shortHash(signature)), paintDeclarations(style.paint, kind));
    const geometryDecls = geometryDeclarations(style.geometry, kind);
    const geometry = this.add('g', shortHash(geometryDecls.join(';')), geometryDecls);
    return [geometry, paint].filter((c): c is string => c !== null).join(' ');
  }

  emit(): readonly string[] {
    return [...this.rules.keys()].sort().map((name) => `.${name}{${this.rules.get(name) as string}}`);
  }
}
