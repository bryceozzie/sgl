import type { LayoutResult } from '@sgl/layout-api';
import { runConformance, runHostSequence } from '@sgl/layout-api/conformance';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { elkEngine } from '../src/index.js';
import { layoutInputForSource, METRICS } from './corpus-input.js';

/**
 * F32: ELK ids are one flat namespace per kind, and the adapter's own ids
 * (the root, a port's `node#port`) used to share it with the author's. A node
 * named `root`, or named like a port or an edge id, then collided and ELK
 * mislaid its edges. Every author id is namespaced now (DD-06 §6.1), so no
 * name can collide. Each document below runs the whole conformance suite
 * (checks 1–7, check 2 being the double run), and lays out exactly like the
 * same document with plain names.
 */

const quote = (name: string): string => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** One shape of document over six names: a leaf with ports, a container
 *  holding two children, edges between all of them (port ends included).
 *  Every node has the same explicit label, so only the names differ. */
function documentOf(names: readonly string[]): string {
  const [a, b, c, box, inner, other] = names.map(quote) as [string, string, string, string, string, string];
  const L = '@label: "N"';
  return [
    `${a}: { ${L}, @ports: { in: west, out: east } }`,
    `${b}: { ${L} }`,
    `${c}: { ${L} }`,
    `${box}: {`,
    `  ${L}`,
    `  ${inner}: { ${L} }`,
    `  ${other}: { ${L} }`,
    `}`,
    `${b} -> ${a}[in]`,
    `${a}[out] -> ${c}`,
    `${c} -> ${box}.${inner}`,
    `${box}.${inner} -> ${box}.${other}`,
    `${a} -> ${box}`,
    `${b} -> ${c}: "x"`,
    '',
  ].join('\n');
}

const PLAIN = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];

/** The result with every id replaced by its index in graph order, so two
 *  documents that differ only in their names compare equal. */
function byIndex(source: string, result: LayoutResult): string {
  const { graph } = layoutInputForSource(source);
  return JSON.stringify({
    bounds: result.bounds,
    nodes: graph.order.map((id) => result.nodes[id]),
    edges: graph.edges.map((e) => result.edges[e.id]),
    labels: result.labels.map((l) => ({ ...l, labelId: undefined })),
  });
}

async function laidOut(source: string): Promise<string> {
  return byIndex(source, (await runHostSequence(elkEngine, layoutInputForSource(source), {}, METRICS)).result);
}

async function conformanceFailures(name: string, source: string): Promise<readonly string[]> {
  const report = await runConformance(elkEngine, [{ name, input: layoutInputForSource(source) }], { metrics: METRICS, now: () => 0 });
  return report.failures;
}

/** An edge id the compiler generates (`e-<hash>`), to name a node after. */
function generatedEdgeId(): string {
  return layoutInputForSource(documentOf(PLAIN)).graph.edges[0]!.id;
}

describe('F32: no author id collides with an ELK id', () => {
  it('a node named root, with edges in and out, lays out and every edge is attached', async () => {
    // Labelled alike, so the two documents differ in the name alone.
    const doc = (x: string): string => `a\n${x}: { @label: "root" }\nb\na -> ${x}\n${x} -> b\n${x} -> ${x}\n`;
    expect(await conformanceFailures('root', doc('root'))).toEqual([]);
    expect(await laidOut(doc('root'))).toBe(await laidOut(doc('x')));
  });

  const cases: Readonly<Record<string, readonly string[]>> = {
    'root, in every position': ['root', 'n1', 'n2', 'root2', 'root', 'n5'],
    'root as the container': ['n0', 'n1', 'n2', 'root', 'n4', 'n5'],
    'a node named like a port id (n0#in)': ['n0', 'n0#in', 'n2', 'n3', 'n4', 'n5'],
    'a node named like a port id, and its port the port of another': ['n0', 'n0#out', 'n0#in', 'n3', 'n4', 'n5'],
    'names containing the separators': ['a#b', 'a', 'b#', '#', 'n:a', 'p1:a#in'],
    'names like the namespaced ids': ['n:n0', 'n0', 'e:n0', 'p2:n0#in', 'n:root', 'root'],
    'the empty name and a lone colon': ['', ':', 'n:', 'e:', 'p', 'p0:#in'],
  };
  for (const [name, names] of Object.entries(cases)) {
    it(`${name}: conformance (checks 1–7, double run), and the same layout as plain names`, async () => {
      const source = documentOf(names);
      expect(await conformanceFailures(name, source)).toEqual([]);
      expect(await laidOut(source)).toBe(await laidOut(documentOf(PLAIN)));
    });
  }

  it('a node named after a generated edge id', async () => {
    const edgeId = generatedEdgeId();
    const source = documentOf(['n0', 'n1', 'n2', 'n3', 'n4', edgeId]);
    expect(await conformanceFailures('edge id', source)).toEqual([]);
    expect(await laidOut(source)).toBe(await laidOut(documentOf(PLAIN)));
  });

  it('property: any six distinct tricky names lay out exactly like plain ones', async () => {
    const plain = await laidOut(documentOf(PLAIN));
    const fragment = fc.constantFrom('root', '#', ':', 'n', 'e', 'p', 'in', 'out', '0', '1', 'n0', 'e-', '.', ' ', '"', '\\', 'é');
    const name = fc.array(fragment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join(''));
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(name, { minLength: 6, maxLength: 6 }), async (names) => {
        const source = documentOf(names);
        // Unique names, but also unique ids (a name may compile to another's id).
        const { graph } = layoutInputForSource(source);
        fc.pre(graph.order.length === 6);
        expect(await laidOut(source)).toBe(plain);
      }),
      { numRuns: 40, seed: 32 },
    );
  }, 60_000);
});
