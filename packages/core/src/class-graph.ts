/**
 * `@extends` cycles, broken one canonical way (DD-02 §4, DD-03 §4; execution
 * plan §2.1 F3), shared by `resolve()` (which splices the edge out of the
 * model) and `compile()` (which skips it, for a class table `resolve()` did
 * not build). For each cycle: rotate it to start at its lexicographically
 * smallest member, name that member in `SGL2004`, and drop the back-edge
 * *into* it — the `@extends` of the member just before it. Cycles are searched
 * over names and bases in sorted order, so the outcome depends on the class
 * graph alone, never on declaration order. Nothing here recurses: a chain or
 * a cycle of any length is safe.
 */

export interface CycleBreak {
  /** The cycle's smallest member: the class the message names. */
  readonly member: string;
  /** The class whose `@extends` of `member` is dropped. */
  readonly from: string;
  /** `A -> B -> C -> A`: each class extends the next. */
  readonly cycle: string;
}

/** The key of a dropped edge in `breakExtendsCycles`' `dropped` set. */
export const extendsEdge = (from: string, to: string): string => `${from}\u0000${to}`;

export function breakExtendsCycles(
  bases: ReadonlyMap<string, readonly string[]>,
): { readonly dropped: ReadonlySet<string>; readonly breaks: readonly CycleBreak[] } {
  const names = [...bases.keys()].sort();
  const sorted = new Map(names.map((n) => [n, [...new Set(bases.get(n))].filter((b) => bases.has(b)).sort()] as const));
  const dropped = new Set<string>();
  const breaks: CycleBreak[] = [];

  for (;;) {
    const cycle = findCycle(names, sorted, dropped);
    if (cycle === undefined) break;
    const member = [...cycle].sort()[0] as string;
    const at = cycle.indexOf(member);
    const rotated = [...cycle.slice(at), ...cycle.slice(0, at)];
    const from = rotated[rotated.length - 1] as string;
    dropped.add(extendsEdge(from, member));
    breaks.push({ member, from, cycle: [...rotated, member].join(' -> ') });
  }
  return { dropped, breaks };
}

/** One cycle still present, as the classes along it (each extends the next,
 *  the last extends the first), or `undefined`. Iterative depth-first search. */
function findCycle(
  names: readonly string[],
  bases: ReadonlyMap<string, readonly string[]>,
  dropped: ReadonlySet<string>,
): string[] | undefined {
  const done = new Set<string>();
  const onPath = new Set<string>();
  for (const start of names) {
    if (done.has(start)) continue;
    const path: string[] = [start];
    const next: number[] = [0];
    onPath.add(start);
    while (path.length > 0) {
      const top = path.length - 1;
      const name = path[top] as string;
      const list = bases.get(name) as readonly string[];
      const i = next[top] as number;
      if (i === list.length) {
        path.pop();
        next.pop();
        onPath.delete(name);
        done.add(name);
        continue;
      }
      next[top] = i + 1;
      const base = list[i] as string;
      if (dropped.has(extendsEdge(name, base)) || done.has(base)) continue;
      if (onPath.has(base)) return path.slice(path.indexOf(base));
      path.push(base);
      next.push(0);
      onPath.add(base);
    }
  }
  return undefined;
}
