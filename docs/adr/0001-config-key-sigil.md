# ADR-0001 — Distinguishing configuration from children

**Status:** Proposed · **Date:** 2026-09-14

## Context

The core language rule is "keys are containers, contents are children or container configuration."
Something has to tell the parser which is which. Every existing tool in this space has had to solve it, and the choice leaks into every diagram anyone ever writes.

## Options

**A. Reserved words.** `label`, `shape`, `style`, `direction` are configuration; everything else is a child. This is D2's approach.
- Familiar, no punctuation noise.
- But the reserved set can never grow without breaking documents, and a node genuinely called `style` or `direction` is unnameable. Users hit this constantly in real diagrams (`icon`, `link`, `grid`, `class` are all plausible node names).

**B. Sigil-prefixed configuration.** `@label`, `@shape`, `@style`. Anything unprefixed is a child.
- Zero collisions, forever. The reserved namespace can grow freely.
- Grep-able, syntax-highlightable, and obvious at a glance which lines are structure and which are settings.
- Valid JSON keys, so the canonical form needs no special casing.
- Costs one character per configuration line, and is unfamiliar to Mermaid/D2 users.

**C. Separate configuration block.** `{ config: {...}, children: {...} }`.
- Unambiguous and boring.
- But it doubles the nesting depth of every container and reads nothing like the "keys are containers" goal. Verbose for the common case of one label.

**D. Sigil on children instead.** Configuration is bare, children are prefixed.
- Inverts the cost onto the more common case. Children vastly outnumber configuration lines.

## Decision

**Option B — `@`-prefixed configuration keys.**

The deciding argument is extensibility. Layout engines and themes are plugins, and plugins need to introduce their own configuration keys (`@layout.rankSep`, `@theme.glow`). With reserved words, every plugin that adds a key steals a name from the user's namespace and risks breaking existing documents. With a sigil, the plugin namespace and the user namespace are disjoint by construction.

`@` is chosen over `$` (which is reserved for variable references), `_` (looks like a private field, collides with real node names), and `.` (conflicts with path syntax).

## Consequences

- Plugins can define configuration keys freely under their own namespace.
- Nodes may be named anything, including `label` and `style`.
- Editors get a trivially reliable highlighting and autocomplete trigger: typing `@` offers configuration, anything else offers node paths.
- Documents carry visible punctuation that Mermaid users will find unfamiliar. Mitigate with strong shorthands — `web: "Label"` and `api: Service` cover the two most common cases without any `@` at all.
- Unknown `@` keys inside a known namespace are warnings, not errors — forward compatibility for documents written against a newer version.

## Revisit if

Usability testing shows the sigil is a genuine barrier for casual users. A migration to Option A would be mechanical in one direction only (A cannot be migrated to B safely), so B is also the reversible choice.
