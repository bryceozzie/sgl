import type { ThemeDoc } from '@sgl/theme';

/**
 * Test fixtures, not shipped (fix round 1, item 3): a theme pair whose paint
 * is role-, shape- and class-specific — which the built-in themes are not, so
 * they cannot catch a paint class whose name leaves out a cascade input — and
 * a document that exercises every such input: classed nodes and edges,
 * several shapes, inline `@style` colours on labelled edges, and a container.
 * The two themes differ in every colour and in nothing else (same geometry,
 * same arrowheads), so switching between them is paint-only.
 */
function synthetic(id: string, color: (n: number) => string): ThemeDoc {
  return {
    id,
    name: id,
    schemaVersion: 1,
    extends: 'neutral-light',
    tokens: {},
    rules: {
      'node.title': { color: color(1) },
      'container.title': { color: color(2) },
      'edge.label': { color: color(3) },
    },
    byShape: { round: { fill: color(4) }, cylinder: { fill: color(5), stroke: color(13) } },
    byClass: {
      Hot: { fill: color(6), stroke: color(7), color: color(8), labelPlate: color(9) },
      Cold: { stroke: color(10), color: color(11), labelPlate: color(14) },
    },
    canvas: { background: color(12) },
  };
}

const hex = (v: number): string => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;

export const SYNTHETIC_A: ThemeDoc = synthetic('synthetic-a', (n) => hex(0x102030 + n * 0x0b0907));
export const SYNTHETIC_B: ThemeDoc = synthetic('synthetic-b', (n) => hex(0xf0e0d0 - n * 0x07090b));

export const SYNTHETIC_DOC = `@classes: {
  Hot:  {}
  Cold: {}
}
a: { @shape: round, @label: "a" }
b: { @type: Hot, @label: "b" }
c: { @label: "c" }
d: { @shape: cylinder, @type: Hot, @label: "d" }
e: { @type: Cold, @label: "e" }
f: { @shape: round, @type: Cold, @label: "f", @style: { fill: "#abcdef" } }
g: {
  @label: "group"
  @type: Hot
  x: { @label: "x" }
  y: { @shape: cylinder, @label: "y" }
}
a -> b: { @label: "hot", @type: Hot }
b -> c: { @label: "plain" }
c -> d: { @label: "cold", @type: Cold }
d -> e: { @label: "red", @style: { stroke: "#123456", color: "#ff0000" } }
e -> f: { @label: "blue", @style: { color: "#0000ff" } }
f -> a: { @style: { stroke: "#654321" } }
g.x -> g.y: { @label: "inner", @type: [Hot, Cold] }
a <-> c
`;

/**
 * A18 (DD-11 T44, T57): the synthetic document with every label marked up —
 * each mark and their combinations, on nodes, a container and edges, one
 * label wrapped at `@size.maxWidth` — for the paint-only property over
 * nested run tspans. Rendered through the rich pipeline (`parseInline`).
 */
export const SYNTHETIC_RICH_DOC = SYNTHETIC_DOC.replace('@label: "a" }', '@label: "**a** *it*" }')
  .replace('@label: "b" }', '@label: "`b` and ***both***" }')
  .replace('@label: "c" }', '@label: "c with a **long bold tail** to wrap", @size: { maxWidth: 90 } }')
  .replace('@label: "d" }', '@label: "**`d`**" }')
  .replace('@label: "group"', '@label: "*group*"')
  .replace('@label: "hot"', '@label: "**hot**"')
  .replace('@label: "cold"', '@label: "`cold`"')
  .replace('@label: "inner"', '@label: "*in* **ner**"');
