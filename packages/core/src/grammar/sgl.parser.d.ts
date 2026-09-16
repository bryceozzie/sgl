// Hand-written types for the generated parser. `lezer-generator` emits plain JS
// (sgl.parser.js + sgl.parser.terms.js, both committed — DD-10 §3) with no
// declarations, and this is the one file that tells TypeScript what it exports.
import type { LRParser } from '@lezer/lr';

export declare const parser: LRParser;
