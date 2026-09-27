/**
 * The generated reference (DD-13 P6): the facts help shows and E6
 * (autocomplete) completes from, built from the code's own tables by
 * `buildReference` (`build.ts`). No prose: summaries, examples and
 * explanations are hand-written content, joined to these facts by id in the
 * help chunk (DD-13 §3.5).
 *
 * Every fact has an `id` of the form `<kind>/<name>` (DD-13 P3): the deep-link
 * path, the join key with the hand-written entries and the search target.
 * Types only: importing this module costs nothing at run time.
 */

import type { ConfigKeySpec, Severity } from '@sgl/core';
import type { EngineCapabilities, JSONSchema7 } from '@sgl/layout-api';
import type { StyleProperty } from '@sgl/theme';

export type Scope = ConfigKeySpec['scope'][number];

/** What a string, number or boolean the code holds prints as in help. */
export type FactValue = string | number | boolean;

export interface Reference {
  /** Registry rows in canonical order, each followed by its sub-keys; then the structural keys. */
  readonly keys: readonly KeyFact[];
  /** `@style.*` properties, in the style registry's order. */
  readonly styles: readonly StyleFact[];
  /** The language's shapes, in the `@shape` row's order. */
  readonly shapes: readonly ShapeFact[];
  /** The caller's engines, in the caller's order (the Engine ▾ order). */
  readonly engines: readonly EngineFact[];
  /** Built-in themes, by id. */
  readonly themes: readonly ThemeFact[];
  /** Every token any built-in theme defines, by name. */
  readonly tokens: readonly TokenFact[];
  /** Every catalogue code, by code. */
  readonly diagnostics: readonly DiagFact[];
}

export interface KeyFact {
  /** `'key/size.maxWidth'`. */
  readonly id: string;
  /** `'size.maxWidth'`: the key without `@`, dotted for a sub-key. */
  readonly key: string;
  /** `'@size.maxWidth'`: as an author writes it. */
  readonly written: string;
  /** Where the key is accepted, straight from the registry (DD-13 P8). */
  readonly scopes: readonly Scope[];
  readonly type: ConfigKeySpec['type'];
  /** What the value may be: an enum, port sides, theme ids or engine ids. */
  readonly values?: readonly string[];
  /** Only where code holds one (DD-13 P7). */
  readonly default?: FactValue;
  /** Ids of the sub-key facts (`key/size.maxWidth`), or of the style facts for `@style`. */
  readonly subKeys?: readonly string[];
  /** The id of the key this is a sub-key of. */
  readonly parent?: string;
  /** `@extends` and `@edges`: handled by the resolver, not the registry (`STRUCTURAL_KEYS`). */
  readonly structural?: true;
  /** Written by the canonical JSON form; an author rarely writes it. */
  readonly canonicalOnly?: true;
}

/** One style property's value in the default theme's rules, for one role. */
export interface RoleDefault {
  /** A rule role: `node`, `node.title`, `container`, `edge`, `edge.label`, … */
  readonly role: string;
  /** As the theme writes it: a number, a token reference (`@line`) or a list (`8 12`). */
  readonly value: string;
}

export interface StyleFact {
  /** `'style/fill'`. */
  readonly id: string;
  readonly name: string;
  /** `'@style.fill'`. */
  readonly written: string;
  readonly affects: StyleProperty['affects'];
  readonly type: StyleProperty['type'];
  /** An enum, or the dash keywords for `strokeDash`. */
  readonly values?: readonly string[];
  readonly appliesTo: StyleProperty['appliesTo'];
  readonly inherits: boolean;
  /** The default theme's value per role, sorted by role; empty when no rule sets it. */
  readonly defaults: readonly RoleDefault[];
}

export interface ShapeFact {
  /** `'shape/cylinder'`. */
  readonly id: string;
  readonly name: string;
  /** Drawn by this build (`DRAWABLE_SHAPES`); otherwise it is `SGL3006` and drawn as the default. */
  readonly drawn: boolean;
  /** The shape a node gets with no `@shape` (`DEFAULT_SHAPE`). */
  readonly default?: true;
  /** The default theme's `byShape` style for it, sorted by property. */
  readonly themeDefaults?: readonly { readonly property: string; readonly value: string }[];
}

export interface OptionFact {
  /** `'option/elk.direction'`, or `'hint/grid.columns'` for a hint. */
  readonly id: string;
  readonly name: string;
  /** `'@layout.direction'`. */
  readonly written: string;
  /** JSON Schema types, in schema order: `['number', 'string']` for grid's `columns`. */
  readonly types: readonly string[];
  readonly values?: readonly string[];
  readonly minimum?: number;
  /** The schema's `default`. */
  readonly default?: FactValue;
}

export interface EngineFact {
  /** `'engine/elk'`: the bare name (DD-12 N22). */
  readonly id: string;
  /** `'sgl.elk'`: what `@layout.engine` and the worker's registry take. */
  readonly engineId: string;
  /** `'elk'`. */
  readonly bareName: string;
  readonly name: string;
  readonly determinism: EngineCapabilities['determinism'];
  /** The descriptor's capabilities, keys sorted. */
  readonly capabilities: Readonly<Record<string, FactValue>>;
  /** Root `@layout` options (`optionsSchema`), in schema order. */
  readonly options: readonly OptionFact[];
  /** `@layout.<hint>` on a node or edge (`hintsSchema`), in schema order. */
  readonly hints: readonly OptionFact[];
}

export interface ThemeFact {
  /** `'theme/print'`. */
  readonly id: string;
  readonly themeId: string;
  readonly name: string;
  readonly extends: string | null;
  /** The paint properties the theme forces over the document (DD-04 §4 step 7), sorted. */
  readonly forces: readonly string[];
  /** The app's default theme (`DEFAULT_THEME_ID`). */
  readonly default: boolean;
}

export interface TokenFact {
  /** `'token/surface.sunken'`. */
  readonly id: string;
  readonly name: string;
  /** `'@surface.sunken'`: how a style value refers to it. */
  readonly written: string;
  /** Resolved value per built-in theme id, keys sorted; absent where a theme does not define it. */
  readonly values: Readonly<Record<string, string>>;
}

export type DiagStage = 'syntax' | 'resolution' | 'semantic' | 'layout' | 'theme' | 'platform';

export interface DiagFact {
  /** `'diag/SGL2010'`. */
  readonly id: string;
  readonly code: string;
  readonly severity: Severity;
  /** The catalogue's message template, `{placeholders}` and all. */
  readonly template: string;
  /** From the code's thousands digit (DD-00 §3). */
  readonly stage: DiagStage;
}

/** What `buildReference` needs of an engine: `REGISTERED_ENGINES`' entries, or a descriptor. */
export interface ReferenceEngine {
  readonly id: string;
  readonly name: string;
  readonly capabilities: EngineCapabilities;
  readonly optionsSchema?: JSONSchema7;
  readonly hintsSchema?: JSONSchema7;
}
