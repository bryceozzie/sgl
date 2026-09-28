import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_ENGINE_ID, REGISTERED_ENGINES } from '../io/app-boot.js';
import { lazyChunk } from '../state/lazy.js';
import { APP_METRICS } from '../state/metrics.js';
import { createAppWorkerHost } from '../state/worker-host.js';
import type { Signal } from '@preact/signals';
import type { HelpDeps, HelpRequest } from '../toolbar/HelpButton.js';
import { categoryTitle, homeCategories } from './categories.js';
import type { ExampleSpec } from './content.js';
import { Facts } from './facts.js';
import type { Previewer, PreviewOutcome } from './help-preview.js';
import { joinHelp, QUICKSTART_ID, type HelpTable, type HelpTableEntry } from './join.js';
import { explainedBy, helpHref } from './links.js';
import { Blocks, Code, Runs } from './render.js';
import { buildSearchIndex, searchHelp, type SearchIndex } from './search.js';
import './help.css';

/**
 * The Help drawer (DD-13 §6), the lazy `help` chunk. The boot path
 * (`toolbar/HelpButton.tsx`) owns the button and mounts this once it has
 * loaded: the `<aside>`, the search box, the categories or the results, and
 * one entry at a time.
 *
 * The drawer is an `<aside>` labelled by its heading, not a dialog, and not
 * modal (P34). Escape inside it (one the search box did not use to clear
 * itself) and its × close it, with focus back on the Help button; a click
 * outside does not, so the user can type in the editor with help open (P39).
 *
 * The content (`help-content`) and the reference builder (`reference`) are
 * chunks of their own, loaded with this one; previews load `help-preview` on
 * the first example that scrolls into view. Each failed load toasts, as the
 * app's other lazy chunks do (`state/lazy.ts`), and is tried again next time.
 *
 * **Focus** (P37, P39) moves only for a user action in help (a click, Enter,
 * an arrow key, Escape here) or when help was opened to take it (the Help
 * button: the search box; a diagnostics row's Help: the entry's heading).
 * A first visit opens it without moving focus (HD6). Nothing else moves it:
 * not the chunks landing, not results updating, not a preview finishing.
 */

const loadContent = lazyChunk(() => import('./help-content.js'));
const loadReference = lazyChunk(() => import('../reference/reference.js'));
const loadPreview = lazyChunk(() => import('./help-preview.js'));

interface Loaded {
  readonly table: HelpTable;
  readonly index: SearchIndex;
}

let loaded: Promise<Loaded> | undefined;
function loadTable(): Promise<Loaded> {
  return (loaded ??= Promise.all([loadContent(), loadReference()]).then(
    ([content, reference]) => {
      const table = joinHelp(reference.buildReference(REGISTERED_ENGINES), content.default);
      return { table, index: buildSearchIndex(table.entries) };
    },
    (err: unknown) => {
      loaded = undefined;
      throw err;
    },
  ));
}

/** Help surfaces showing now; the preview host is disposed a minute after the last closes (P25). */
let showing = 0;
let previewer: Previewer | undefined;
let previewerLoad: Promise<Previewer> | undefined;
function getPreviewer(deps: HelpDeps): Promise<Previewer> {
  return (previewerLoad ??= loadPreview().then(
    (m) => {
      previewer = m.createPreviewer({
        measurer: deps.measurer,
        metrics: APP_METRICS,
        createHost: () => createAppWorkerHost(deps.measurer),
        engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id),
        // The editor pipeline's own lazy chunks (DD-13 P24).
        loadRichText: () => import('../state/rich-text.js').then((r) => r.richText),
        loadImports: () => import('../state/imports.js').then((r) => r.createImportsRuntime(deps.store)),
      });
      if (showing === 0) previewer.close();
      return previewer;
    },
    (err: unknown) => {
      previewerLoad = undefined;
      throw err;
    },
  ));
}

type View = { readonly kind: 'home' } | { readonly kind: 'entry'; readonly id: string };

const bare = (engineId: string): string => engineId.replace(/^sgl\./, '');
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/** A rendered preview (P28): a fixed-size box until it lands, then the SVG. */
function Preview({ spec, engineId, deps, onOutcome }: { readonly spec: ExampleSpec; readonly engineId: string; readonly deps: HelpDeps; readonly onOutcome: (o: PreviewOutcome | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [outcome, setOutcome] = useState<PreviewOutcome | 'failed' | null>(null);
  const themeId = deps.pipeline.effectiveThemeId.value;

  useEffect(() => {
    const el = box.current;
    if (el === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const io = new IntersectionObserver((seen) => {
      if (seen.some((s) => s.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancel: (() => void) | undefined;
    let live = true;
    getPreviewer(deps).then(
      (p) => {
        if (!live) return;
        cancel = p.render({ key: spec.id, source: spec.source, engineId, themeId }, (o) => {
          setOutcome(o);
          onOutcome(o);
        });
      },
      () => {
        if (live) {
          setOutcome('failed');
          onOutcome(null);
        }
      },
    );
    return () => {
      live = false;
      cancel?.();
    };
  }, [visible, themeId]);

  // The SVG is `render()` output, which gets the trust the canvas gives
  // `lastGood.svg` (DD-09 §1.1, DD-13 P28).
  const svg = outcome !== null && outcome !== 'failed' ? outcome.svg : null;
  useLayoutEffect(() => {
    if (box.current !== null) box.current.innerHTML = svg ?? '';
  }, [svg]);

  const state = outcome === null ? 'pending' : svg !== null ? 'rendered' : 'failed';
  return (
    <div class="help-preview" data-state={state}>
      <div class="help-preview-svg" ref={box} />
      {state === 'pending' ? <span class="help-preview-note">Rendering…</span> : null}
      {state === 'failed' ? <span class="help-preview-note">This example could not be previewed.</span> : null}
    </div>
  );
}

function Example({ spec, deps }: { readonly spec: ExampleSpec; readonly deps: HelpDeps }) {
  const engineId = REGISTERED_ENGINES.find((e) => e.id === `sgl.${spec.engine ?? ''}`)?.id ?? DEFAULT_ENGINE_ID;
  const [outcome, setOutcome] = useState<PreviewOutcome | null>(null);
  const copy = (): void => {
    const done = (): void => void deps.toasts.push('Example copied.');
    const failed = (): void => void deps.toasts.push("Couldn't copy the example: this browser refused access to the clipboard.", 'error');
    try {
      void navigator.clipboard.writeText(spec.source).then(done, failed);
    } catch {
      failed();
    }
  };
  const codes = outcome?.codes ?? [];
  return (
    <figure class="help-example" data-example={spec.id}>
      <Code tokens={spec.tokens} />
      <div class="help-example-actions">
        <button type="button" class="help-copy" onClick={copy}>
          Copy
        </button>
        <button
          type="button"
          class="help-open"
          onClick={() => void deps.openExample(spec.source, engineId).then((opened) => opened && deps.toasts.push('Opened the example as a new document. Your previous document is in Documents.'))}
        >
          Open as new document
        </button>
      </div>
      {spec.preview ? <Preview spec={spec} engineId={engineId} deps={deps} onOutcome={setOutcome} /> : null}
      <figcaption>
        <span class="help-example-title">{spec.title}</span>
        {spec.preview ? (
          <span class="help-example-meta">
            {' · '}
            {bare(outcome?.engineId ?? engineId)} · {outcome?.themeId ?? deps.pipeline.effectiveThemeId.value}
            {codes.length > 0 ? ` · ${plural(codes.length, 'diagnostic')}${sameMultiset(codes, spec.expect) ? ' (expected)' : ''}` : ''}
          </span>
        ) : (
          <span class="help-example-meta"> · no preview</span>
        )}
      </figcaption>
    </figure>
  );
}

function EntryView({ entry, table, deps, onLink }: { readonly entry: HelpTableEntry; readonly table: HelpTable; readonly deps: HelpDeps; readonly onLink: (id: string) => void }) {
  const content = entry.content;
  const code = entry.fact?.kind === 'diag' ? entry.fact.fact.code : undefined;
  const explained = code !== undefined && content === undefined ? explainedBy(table, code) : [];
  return (
    <>
      <Facts entry={entry} table={table} onLink={onLink} />
      {content !== undefined ? (
        <>
          <p class="help-summary">
            <Runs runs={content.summary} onLink={onLink} />
          </p>
          <Blocks blocks={content.blocks} onLink={onLink} example={(spec) => <Example spec={spec} deps={deps} />} />
          {content.seeAlso.length > 0 ? (
            <p class="help-see-also">
              See also:{' '}
              {content.seeAlso.map((id, i) => (
                <>
                  {i > 0 ? ', ' : ''}
                  <a
                    href={helpHref(id)}
                    onClick={(ev) => {
                      ev.preventDefault();
                      onLink(id);
                    }}
                  >
                    {table.get(id)?.title ?? id}
                  </a>
                </>
              ))}
            </p>
          ) : null}
        </>
      ) : null}
      {explained.length > 0 ? (
        <p class="help-explained">
          Explained in:{' '}
          {explained.map((e, i) => (
            <>
              {i > 0 ? ', ' : ''}
              <a
                href={helpHref(e.id)}
                onClick={(ev) => {
                  ev.preventDefault();
                  onLink(e.id);
                }}
              >
                {e.title}
              </a>
            </>
          ))}
        </p>
      ) : null}
    </>
  );
}

export function HelpView({ request, deps }: { readonly request: HelpRequest; readonly deps: HelpDeps }) {
  const [data, setData] = useState<Loaded | 'failed' | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'home' });
  const [history, setHistory] = useState<readonly View[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** What takes focus after the next render: set only by a user action or an opening that asks for it. */
  const focusNext = useRef<'search' | 'heading' | { readonly result: string } | null>(null);
  const lastResult = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    showing += 1;
    previewer?.open();
    let live = true;
    loadTable().then(
      (d) => live && setData(d),
      () => live && setData('failed'),
    );
    return () => {
      live = false;
      showing -= 1;
      if (showing === 0) previewer?.close();
    };
  }, []);

  // An opening request (the Help button, a diagnostics row, a first visit).
  useEffect(() => {
    // A first visit (HD6) opens at the quick start.
    const id = request.id ?? (request.focus === 'none' ? QUICKSTART_ID : undefined);
    if (id !== undefined) {
      setView({ kind: 'entry', id });
      setHistory([]);
    }
    focusNext.current = request.focus === 'search' ? 'search' : request.focus === 'entry' ? 'heading' : null;
  }, [request]);

  const table = data !== null && data !== 'failed' ? data.table : null;
  const entry = view.kind === 'entry' && table !== null ? table.get(view.id) : undefined;

  // An id nothing answers to shows the home, with a notice (as text).
  useEffect(() => {
    if (table !== null && view.kind === 'entry' && entry === undefined) {
      setNotice(`No help entry \`${view.id}\``);
      setView({ kind: 'home' });
    }
  }, [table, view]);

  useLayoutEffect(() => {
    const want = focusNext.current;
    const el = root.current;
    if (want === null || el === null) return;
    if (want === 'search') el.querySelector<HTMLInputElement>('.help-search')?.focus();
    else if (want === 'heading') {
      const h = el.querySelector<HTMLElement>('.help-entry-title');
      if (h === null) return; // not rendered yet: the content is still loading
      h.focus();
    } else el.querySelector<HTMLButtonElement>(`.help-result[data-id="${CSS.escape(want.result)}"]`)?.focus();
    focusNext.current = null;
  });

  function follow(id: string): void {
    setNotice(null);
    setHistory((h) => [...h, view]);
    setView({ kind: 'entry', id });
    focusNext.current = 'heading';
  }

  function back(): void {
    const previous = history[history.length - 1] ?? { kind: 'home' };
    setHistory((h) => h.slice(0, -1));
    setView(previous);
    focusNext.current = previous.kind === 'entry' ? 'heading' : lastResult.current !== null && query !== '' ? { result: lastResult.current } : 'search';
  }

  function openResult(id: string): void {
    lastResult.current = id;
    follow(id);
  }

  const results = useMemo(() => (data !== null && data !== 'failed' ? searchHelp(data.index, query) : undefined), [data, query]);

  function onSearchKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && query !== '') {
      ev.preventDefault(); // the drawer closes only on an Escape nothing else used
      setQuery('');
    } else if (ev.key === 'ArrowDown') {
      const first = root.current?.querySelector<HTMLButtonElement>('.help-result, .help-home button');
      if (first) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  function onListKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('.help-result, .help-home .help-link') ?? [])].filter((b) => b.offsetParent !== null);
    const at = buttons.indexOf(ev.target as HTMLButtonElement);
    if (at < 0) return;
    ev.preventDefault();
    const next = at + (ev.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) root.current?.querySelector<HTMLInputElement>('.help-search')?.focus();
    else buttons[Math.min(next, buttons.length - 1)]!.focus();
  }

  const entryButton = (e: HelpTableEntry, cls: string) => (
    <li>
      <button type="button" class={cls} data-id={e.id} onClick={() => openResult(e.id)}>
        <span class="help-link-title">{e.title}</span>
        {e.content !== undefined && cls === 'help-result' ? (
          <span class="help-link-summary">
            <Runs runs={e.content.summary} onLink={() => undefined} />
          </span>
        ) : null}
      </button>
    </li>
  );

  return (
    <div class="help-view" ref={root}>
      {view.kind === 'home' ? (
        <>
          <input
            type="search"
            class="help-search"
            aria-label="Search help"
            placeholder="Search help: @pin, maxWidth, SGL2010…"
            value={query}
            onInput={(ev) => setQuery((ev.currentTarget as HTMLInputElement).value)}
            onKeyDown={onSearchKey}
          />
          <p class="help-count" role="status" aria-live="polite">
            {results === undefined ? '' : results.total === 0 ? `No results for “${query.trim()}”` : plural(results.total, 'result')}
          </p>
          {notice !== null ? <p class="help-notice">{notice}</p> : null}
          {data === null ? <p class="help-loading">Loading help…</p> : null}
          {data === 'failed' ? <p class="help-loading">Help couldn't be loaded. Close it and try again.</p> : null}
          {table !== null && results === undefined ? (
            <div class="help-home" onKeyDown={onListKey}>
              {homeCategories(table.entries).map((c) => (
                <details open={c.category === 'quickstart'}>
                  <summary>{c.title}</summary>
                  <ul>{c.entries.map((e) => entryButton(e, 'help-link'))}</ul>
                </details>
              ))}
            </div>
          ) : null}
          {results !== undefined ? (
            <div class="help-results" onKeyDown={onListKey}>
              {results.groups.map((g) => (
                <section>
                  <h3 class="help-group">{categoryTitle(g.category)}</h3>
                  <ul>{g.entries.map((e) => entryButton(e, 'help-result'))}</ul>
                </section>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div class="help-entry">
          <button type="button" class="help-back" onClick={back}>
            <span aria-hidden="true">←</span> {history.length > 0 && history[history.length - 1]!.kind === 'entry' ? 'Back' : query !== '' ? 'Results' : 'Help home'}
          </button>
          {entry !== undefined && table !== null ? (
            <article>
              <h3 class="help-entry-title" tabindex={-1}>
                {entry.title}
              </h3>
              <EntryView entry={entry} table={table} deps={deps} onLink={follow} />
            </article>
          ) : (
            <p class="help-loading">{data === 'failed' ? "Help couldn't be loaded. Close it and try again." : 'Loading help…'}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpDrawer({ state, deps }: { readonly state: Signal<HelpRequest | null>; readonly deps: HelpDeps }) {
  const request = state.value;
  if (request === null) return null;
  const close = (): void => {
    state.value = null;
    document.querySelector<HTMLElement>('[aria-controls="help-drawer"]')?.focus();
  };
  return (
    <aside
      id="help-drawer"
      class="help-drawer"
      aria-labelledby="help-drawer-title"
      onKeyDown={(ev) => {
        if (ev.key === 'Escape' && !ev.defaultPrevented) {
          ev.preventDefault();
          close();
        }
      }}
    >
      <div class="help-drawer-head">
        <h2 id="help-drawer-title">Help</h2>
        <button type="button" class="help-close" aria-label="Close help" onClick={close}>
          ×
        </button>
      </div>
      <HelpView request={request} deps={deps} />
    </aside>
  );
}
