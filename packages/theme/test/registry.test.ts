import { describe, expect, it } from 'vitest';
import { BY_NAME, REGISTRY } from '../src/registry.js';
import { neutralDark, neutralLight } from '../src/themes/index.js';

describe('style-property registry', () => {
  // DD-04 §8, first bullet: registry completeness.
  it('gives every property an affects, a type and an appliesTo', () => {
    for (const p of REGISTRY) {
      expect(p.affects, p.name).toMatch(/^(geometry|paint)$/);
      expect(p.type, p.name).toBeTruthy();
      expect(p.appliesTo.length, p.name).toBeGreaterThan(0);
    }
  });

  it('declares the allowed values of every enum property', () => {
    for (const p of REGISTRY.filter((p) => p.type === 'enum')) {
      expect(p.enum, p.name).toBeDefined();
      expect(p.enum?.length, p.name).toBeGreaterThan(0);
    }
  });

  it('has no duplicate names', () => {
    expect(BY_NAME.size).toBe(REGISTRY.length);
  });

  it('classifies the properties that look like paint but are not', () => {
    // 06 §4 and Architecture §2: each of these moves pixels other than its own.
    for (const name of ['strokeWidth', 'radius', 'fontSize', 'padding', 'arrowSize']) {
      expect(BY_NAME.get(name)?.affects, name).toBe('geometry');
    }
  });
});

describe('built-in themes', () => {
  it('ships exactly the two the MVP calls for', () => {
    expect(neutralLight.id).toBe('neutral-light');
    expect(neutralDark.id).toBe('neutral-dark');
  });

  it('makes neutral-dark a token-only override of neutral-light', () => {
    // This is what makes acceptance criterion 2 hold: nothing geometric differs, so
    // the geometry hash is unchanged and a theme switch re-runs paint only.
    expect(neutralDark.extends).toBe('neutral-light');
    expect(Object.keys(neutralDark.rules)).toHaveLength(0);
    expect(Object.keys(neutralDark.byShape)).toHaveLength(0);

    for (const token of Object.keys(neutralDark.tokens)) {
      expect(neutralLight.tokens, `neutral-dark adds a token not in neutral-light: ${token}`)
        .toHaveProperty(token);
    }
  });
});
