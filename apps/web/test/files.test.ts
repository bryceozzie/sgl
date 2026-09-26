import { describe, expect, it, vi } from 'vitest';
import { diagnostic, NO_SPAN, parse, resolve, type DocumentModel } from '@sgl/core';
import { createImportLinker, resolveImports } from '@sgl/core/imports';
import { toJson } from '@sgl/core/json';
import { documentTitle, openableExtension, sanitizeFileStem, saveFileName } from '../src/state/filename.js';
import { MAX_OPEN_BYTES, readOpenedFile, saveContent, type SaveInputs } from '../src/state/files.js';

/** DD-08 §7 — files, DOM-free. */

const modelOf = (source: string): DocumentModel => resolve(parse(source).ast).model;

describe('title: @title, then the first node key, then "diagram"', () => {
  it('@title wins', () => {
    expect(documentTitle(modelOf('@title: "Checkout Flow"\nweb: "Web"\n'))).toBe('Checkout Flow');
  });

  it('without @title, the first node key in document order', () => {
    expect(documentTitle(modelOf('zebra: "Z"\napple: "A"\n'))).toBe('zebra');
    expect(documentTitle(modelOf('@theme: "neutral-dark"\npayments: {\n  api: "API"\n}\n'))).toBe('payments');
  });

  it('a blank @title falls through to the first key', () => {
    expect(documentTitle(modelOf('@title: "   "\nweb: "Web"\n'))).toBe('web');
  });

  it('with neither, "diagram"', () => {
    expect(documentTitle(modelOf(''))).toBe('diagram');
    expect(documentTitle(modelOf('@title: ""\n'))).toBe('diagram');
    expect(documentTitle(modelOf('// only a comment\n'))).toBe('diagram');
  });

  it('skips a container grafted from an import: a document is not named after its first import (A9, DD-02 I12)', () => {
    const host = { lookup: () => ({ key: 'aws', source: '@title: "AWS"\nlambda\n', candidates: 1 }) };
    const imported = (source: string): DocumentModel => resolveImports(parse(source).ast, createImportLinker(host, { self: 'me' })).model;
    const model = imported('@imports: [{ path: "./aws.sgl", as: aws }]\nweb: "Web"\n');
    expect(model.root.children.map((c) => c.key)).toEqual(['aws', 'web']);
    expect(documentTitle(model)).toBe('web');
    expect(documentTitle(imported('@imports: [{ path: "./aws.sgl", as: aws }]\n'))).toBe('diagram');
  });
});

describe('sanitised for file names', () => {
  it.each([
    ['Checkout Flow', 'Checkout Flow'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
    ['tab\there\nnewline', 'tab here newline'],
    ['  ..hidden. ', 'hidden'],
    ['...', 'diagram'],
    ['', 'diagram'],
    ['CON', 'CON_'],
    ['lpt1', 'lpt1_'],
    ['console', 'console'],
    ['ctrl\u0007bell', 'ctrl-bell'],
    ['Grüße 日本', 'Grüße 日本'],
  ])('%j → %j', (title, stem) => {
    expect(sanitizeFileStem(title)).toBe(stem);
  });

  it('caps the length without leaving a trailing dot or space', () => {
    const stem = sanitizeFileStem(`${'x'.repeat(119)} .${'y'.repeat(50)}`);
    expect(stem).toBe('x'.repeat(119));
  });
  // Fix round 1, item 12.
  it.each([
    // Windows reserves the stem before the FIRST dot, whatever follows.
    ['con.backup', 'con_.backup'],
    ['AUX.tar', 'AUX_.tar'],
    ['nul.a.b', 'nul_.a.b'],
    ['con .backup', 'con_ .backup'],
    ['console.backup', 'console.backup'],
    // …and these, which the first list missed.
    ['CONIN$', 'CONIN$_'],
    ['conout$', 'conout$_'],
    ['CONOUT$.log', 'CONOUT$_.log'],
    ['COM\u00b9', 'COM\u00b9_'],
    ['com\u00b2', 'com\u00b2_'],
    ['LPT\u00b3', 'LPT\u00b3_'],
    ['lpt\u00b9.txt', 'lpt\u00b9_.txt'],
    ['COM\u2074', 'COM\u2074'], // only ¹ ² ³ are reserved
  ])('reserved device name %j → %j', (title, stem) => {
    expect(sanitizeFileStem(title)).toBe(stem);
  });

  it.each([
    // Bidi controls could make "evil\u202Egpj.svg" display as "evilsvg.jpg".
    ['evil\u202Egpj', 'evilgpj'],
    ['a\u202Ab\u202Bc\u202Cd\u202De', 'abcde'],
    ['a\u2066b\u2067c\u2068d\u2069e', 'abcde'],
    ['l\u200Er\u200Fm', 'lrm'],
    // Zero-width characters: invisible, and they make look-alike names.
    ['zero\u200Bwidth\u200Cjoin\u200Dx', 'zerowidthjoinx'],
    ['\uFEFFbom', 'bom'],
    ['\u200B\u200B', 'diagram'],
  ])('bidi and zero-width characters are stripped: %j → %j', (title, stem) => {
    expect(sanitizeFileStem(title)).toBe(stem);
  });

  it('caps the length by code point, never splitting a surrogate pair', () => {
    const stem = sanitizeFileStem('🚀'.repeat(200)); // 400 UTF-16 code units
    expect(Array.from(stem)).toHaveLength(120);
    expect(stem).toBe('🚀'.repeat(120));
    expect(stem).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone surrogate
    const mixed = sanitizeFileStem(`${'x'.repeat(119)}😀tail`);
    expect(mixed).toBe(`${'x'.repeat(119)}😀`);
  });
});

describe('save names and the remembered extension', () => {
  it('defaults', () => {
    expect(saveFileName('sgl', 'Checkout Flow')).toBe('Checkout Flow.sgl');
    expect(saveFileName('json', 'Checkout Flow')).toBe('Checkout Flow.sgl.json');
    expect(saveFileName('svg', 'Checkout Flow')).toBe('Checkout Flow.svg');
  });

  it('a remembered extension applies to the item of its own kind only', () => {
    expect(saveFileName('sgl', 'd', '.txt')).toBe('d.txt');
    expect(saveFileName('json', 'd', '.txt')).toBe('d.sgl.json');
    expect(saveFileName('json', 'd', '.json')).toBe('d.json');
    expect(saveFileName('sgl', 'd', '.json')).toBe('d.sgl');
    expect(saveFileName('svg', 'd', '.txt')).toBe('d.svg');
  });

  it('recognises what Open accepts, longest extension first', () => {
    expect(openableExtension('a.sgl')).toBe('.sgl');
    expect(openableExtension('A.SGL.JSON')).toBe('.sgl.json');
    expect(openableExtension('a.json')).toBe('.json');
    expect(openableExtension('notes.txt')).toBe('.txt');
    expect(openableExtension('a.md')).toBeNull();
    expect(openableExtension('.sgl')).toBeNull(); // no name at all
  });
});

describe('Open', () => {
  const fileOf = (name: string, size: number, text = 'a: "A"\n') => ({ name, size, text: vi.fn(async () => text) });

  it('reads an accepted file and remembers its extension', async () => {
    const file = fileOf('d.sgl.json', 10, '{ "a": "A" }');
    expect(await readOpenedFile(file)).toEqual({ ok: true, text: '{ "a": "A" }', extension: '.sgl.json' });
  });

  it('refuses a file over 2 MB without reading it', async () => {
    const file = fileOf('big.sgl', MAX_OPEN_BYTES + 1);
    const result = await readOpenedFile(file);
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(file.text).not.toHaveBeenCalled();
    expect(await readOpenedFile(fileOf('edge.sgl', MAX_OPEN_BYTES))).toMatchObject({ ok: true });
  });

  it('refuses an extension Open does not accept', async () => {
    expect(await readOpenedFile(fileOf('notes.md', 10))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('a read failure is a value, not a throw', async () => {
    const file = { name: 'x.sgl', size: 1, text: async () => Promise.reject(new Error('gone')) };
    expect(await readOpenedFile(file)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

describe('Save ▾', () => {
  const source = '@title: "Flow"\n// a comment\nweb: "Web"\napi: "API"\nweb -> api\n';
  const inputs = (overrides: Partial<SaveInputs> = {}): SaveInputs => {
    const { model, diagnostics } = resolve(parse(source).ast);
    return { title: documentTitle(model), source, model, modelDiagnostics: diagnostics, lastGoodSvg: '<svg/>', ...overrides };
  };

  it('SGL is the source verbatim', () => {
    expect(saveContent('sgl', inputs())).toEqual({ ok: true, file: { name: 'Flow.sgl', mime: 'text/plain;charset=utf-8', text: source } });
  });

  it('canonical JSON is toJson(model)', () => {
    const result = saveContent('json', inputs());
    expect(result).toEqual({ ok: true, file: { name: 'Flow.sgl.json', mime: 'application/json;charset=utf-8', text: toJson(inputs().model) } });
  });

  it('canonical JSON is refused while the model has an error, which it would silently drop', () => {
    const broken = inputs({ modelDiagnostics: [diagnostic('SGL1003', NO_SPAN, {})] });
    expect(saveContent('json', broken)).toMatchObject({ ok: false });
    expect(saveContent('sgl', broken)).toMatchObject({ ok: true }); // the text itself always saves.
  });

  it('SVG is lastGood.svg unchanged — background on, scale 1 — and needs a render', () => {
    expect(saveContent('svg', inputs({ lastGoodSvg: '<svg class="sgl"/>' }))).toEqual({
      ok: true,
      file: { name: 'Flow.svg', mime: 'image/svg+xml;charset=utf-8', text: '<svg class="sgl"/>' },
    });
    expect(saveContent('svg', inputs({ lastGoodSvg: null }))).toMatchObject({ ok: false });
  });
});
