import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRIG_ANGLES } from '../../../packages/layout-std/test/trig-angles.js';

/**
 * B5 branch 5, fix round 1, item 5: the trigonometry the app actually ships,
 * the **built** `std-trees-*.js` chunk (`dist/assets`, found as
 * `scripts/check-core-chunks.mjs` finds it), gives the golden's bits
 * (`packages/layout-std/test/__goldens__/trig.txt`) for every angle. The
 * minifier (terser, `build/minify.ts`) could otherwise rewrite the
 * polynomial, fold a constant differently or reorder an addition, and
 * `radial` would stop being `bitwise` with every source-level test green.
 *
 * The chunk is loaded in a child Node process, with its one static import
 * (the layout worker chunk, which would run the worker's own code) replaced
 * by a stub exporting the same names. `std-trees.ts` exports `sinTurn` and
 * `cosTurn`, and `lazy.ts` reaches the chunk's exports by a computed name,
 * so the bundler keeps them; they are told apart by value (sin 0 = 0, sin ¼
 * = 1; cos 0 = 1).
 */

const DIST = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const GOLDEN = fileURLToPath(new URL('../../../packages/layout-std/test/__goldens__/trig.txt', import.meta.url));

const SCRIPT = `
const [file, stubSpec, anglesJson] = process.argv.slice(1);
const fs = await import('node:fs');
let code = fs.readFileSync(file, 'utf8');
// The chunk's static imports of other chunks: replace each with a stub module.
code = code.replace(/import\\s*\\{([^}]*)\\}\\s*from\\s*"\\.\\/[^"]+\\.js";?/g, (_, names) => {
  const exported = names.split(',').map((n) => n.trim().split(/\\s+as\\s+/)[0]).filter(Boolean);
  const stub = exported.map((n) => 'export const ' + n + ' = () => { throw new Error("stub"); };').join('\\n');
  return 'import {' + names + '} from "data:text/javascript,' + encodeURIComponent(stub) + '";';
});
const m = await import('data:text/javascript,' + encodeURIComponent(code));
const fns = Object.values(m).filter((f) => typeof f === 'function' && f.length === 1);
const safe = (f, t) => { try { return f(t); } catch { return undefined; } };
const sin = fns.find((f) => safe(f, 0) === 0 && safe(f, 0.25) === 1);
const cos = fns.find((f) => safe(f, 0) === 1 && safe(f, 0.25) === 0);
if (!sin || !cos) { console.log(JSON.stringify({ error: 'no sinTurn/cosTurn among the chunk exports: ' + Object.keys(m).join(',') })); process.exit(0); }
const bits = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getBigUint64(0).toString(16).padStart(16, '0'); };
const rows = JSON.parse(anglesJson).map((t) => t + ' ' + bits(sin(t)) + ' ' + bits(cos(t)));
console.log(JSON.stringify({ text: rows.join('\\n') + '\\n' }));
`;

describe('the built std-trees chunk’s trigonometry equals the golden, bit for bit (fix round 1, item 5)', () => {
  it('every angle of TRIG_ANGLES', () => {
    const chunks = readdirSync(DIST).filter((f) => /^std-trees-[\w-]+\.js$/.test(f));
    expect(chunks, 'run `pnpm build` first').toHaveLength(1);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT, `${DIST}${chunks[0]}`, '', JSON.stringify(TRIG_ANGLES)], { encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').at(-1)!) as { text?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.text).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
