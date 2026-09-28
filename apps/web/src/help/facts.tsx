import type { ComponentChild } from 'preact';
import type { Scope } from '../reference/types.js';
import type { HelpTable, HelpTableEntry } from './join.js';
import { helpHref } from './links.js';
import type { FollowLink } from './render.js';

/**
 * The facts panel (DD-13 P16): what the reference generated for an entry,
 * always shown first, never typed into prose. A `<dl>` of term and value;
 * ids become links to their own entries. Part of the lazy `help` chunk.
 */

/** DD-13 P8: "Applies to", in the spec's words. */
const SCOPE_WORDS: Readonly<Record<Scope, string>> = {
  root: 'the document root',
  node: 'nodes and containers',
  edge: 'edges',
  class: 'class bodies',
};

function IdLink({ id, table, onLink }: { readonly id: string; readonly table: HelpTable; readonly onLink: FollowLink }) {
  const target = table.get(id);
  if (target === undefined) return <code>{id}</code>;
  return (
    <a
      href={helpHref(id)}
      onClick={(ev) => {
        ev.preventDefault();
        onLink(id);
      }}
    >
      {target.title}
    </a>
  );
}

function list(items: readonly ComponentChild[]): ComponentChild {
  return items.flatMap((item, i) => (i === 0 ? [item] : [', ', item]));
}

const codes = (values: readonly (string | number | boolean)[]): ComponentChild => list(values.map((v) => <code>{String(v)}</code>));

export function Facts({ entry, table, onLink }: { readonly entry: HelpTableEntry; readonly table: HelpTable; readonly onLink: FollowLink }) {
  const rows: [string, ComponentChild][] = [];
  const add = (term: string, value: ComponentChild | undefined): void => {
    if (value !== undefined && value !== null && value !== '') rows.push([term, value]);
  };
  const links = (ids: readonly string[]): ComponentChild => list(ids.map((id) => <IdLink id={id} table={table} onLink={onLink} />));
  const f = entry.fact;
  if (f !== undefined) {
    switch (f.kind) {
      case 'key': {
        const k = f.fact;
        add('Written as', <code>{k.written}</code>);
        add('Applies to', k.scopes.map((s) => SCOPE_WORDS[s]).join(', '));
        add('Type', <code>{k.type}</code>);
        if (k.values !== undefined) add('Values', codes(k.values));
        if (k.default !== undefined) add('Default', <code>{String(k.default)}</code>);
        if (k.subKeys !== undefined) add('Sub-keys', links(k.subKeys));
        if (k.parent !== undefined) add('Part of', links([k.parent]));
        if (k.structural === true) add('Handled by', 'the resolver (a structural key)');
        if (k.canonicalOnly === true) add('Written by', 'the canonical JSON form');
        break;
      }
      case 'style': {
        const s = f.fact;
        add('Written as', <code>{s.written}</code>);
        add('Type', <code>{s.type}</code>);
        if (s.values !== undefined) add('Values', codes(s.values));
        add('Applies to', s.appliesTo.join(', '));
        add('Affects', s.affects === 'geometry' ? 'geometry (the layout)' : 'paint only');
        add('Inherits', s.inherits ? 'yes' : 'no');
        if (s.defaults.length > 0) add('Default theme', list(s.defaults.map((d) => <span>{d.role} <code>{d.value}</code></span>)));
        break;
      }
      case 'shape': {
        const s = f.fact;
        add('Drawn', s.drawn ? 'yes' : 'not drawn yet (drawn as the default shape)');
        if (s.default === true) add('Default', 'yes: a node with no @shape');
        if (s.themeDefaults !== undefined && s.themeDefaults.length > 0) add('Default theme', list(s.themeDefaults.map((d) => <span>{d.property} <code>{d.value}</code></span>)));
        break;
      }
      case 'engine': {
        const e = f.fact;
        add('Engine id', <code>{e.engineId}</code>);
        add('Determinism', e.determinism);
        add('Capabilities', list(Object.entries(e.capabilities).map(([k, v]) => <span>{k} <code>{String(v)}</code></span>)));
        if (e.options.length > 0) add('Options', links(e.options.map((o) => o.id)));
        if (e.hints.length > 0) add('Hints', codes(e.hints.map((h) => h.written)));
        break;
      }
      case 'option':
      case 'hint': {
        const o = f.fact;
        add('Written as', <code>{o.written}</code>);
        add('Engine', links([`engine/${o.id.slice(o.id.indexOf('/') + 1).split('.')[0]!}`]));
        add('Type', codes(o.types));
        if (o.values !== undefined) add('Values', codes(o.values));
        if (o.minimum !== undefined) add('Minimum', <code>{String(o.minimum)}</code>);
        if (o.default !== undefined) add('Default', <code>{String(o.default)}</code>);
        break;
      }
      case 'theme': {
        const t = f.fact;
        add('Theme id', <code>{t.themeId}</code>);
        if (t.extends !== null) add('Extends', links([`theme/${t.extends}`]));
        if (t.forces.length > 0) add('Forces', codes(t.forces));
        if (t.default) add('Default', 'yes');
        break;
      }
      case 'token': {
        const t = f.fact;
        add('Written as', <code>{`"${t.written}"`}</code>);
        add('Values', list(Object.entries(t.values).map(([theme, v]) => <span>{theme} <code>{v}</code></span>)));
        break;
      }
      case 'diag': {
        const d = f.fact;
        add('Severity', d.severity);
        add('Stage', d.stage);
        add('Message', d.template);
        break;
      }
    }
  }
  const diagnostics = entry.content?.diagnostics ?? [];
  if (diagnostics.length > 0) add('Diagnostics', links(diagnostics.map((c) => `diag/${c}`)));
  if (rows.length === 0) return null;
  return (
    <dl class="help-facts">
      {rows.map(([term, value]) => (
        <div class="help-fact">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
