import { engineNotes, type LayoutHost } from '@sgl/layout-api';
import { runHostSequence } from '@sgl/layout-api/conformance';
import { StaticMetricsMeasurer } from '@sgl/measure';
import { describe, expect, it } from 'vitest';
import { createPreviewer, DISPOSE_AFTER_MS, PREVIEW_CACHE_SIZE, previewEngineId, type PreviewOutcome, type PreviewRequest } from '../src/help/help-preview.js';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import type { AppMeasurer, Cancel, Schedule } from '../src/state/types.js';
import { createHarness, HARNESS_ENGINES, METRICS } from './harness.js';

/**
 * DD-13 P24–P27 (help branch 4): previews run the app's own pipeline
 * (`createPipeline`) on a layout host of their own, one example at a time,
 * cached by (example, theme, engine), and the host is disposed 60 s after
 * help closes. Node, with the harness's in-process engines behind a host
 * that counts what it is asked.
 */

class TestMeasurer extends StaticMetricsMeasurer implements AppMeasurer {
  async ready(): Promise<void> {}
}

interface Probe {
  readonly hosts: number;
  readonly disposed: number;
  readonly runs: number;
  readonly maxConcurrent: number;
}

function fakeHosts(): { readonly create: () => LayoutHost; readonly probe: () => Probe } {
  let hosts = 0;
  let disposed = 0;
  let runs = 0;
  let running = 0;
  let maxConcurrent = 0;
  return {
    create: () => {
      hosts += 1;
      return {
        async run(engineId, input, options) {
          runs += 1;
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          try {
            await new Promise((r) => setTimeout(r, 1));
            const engine = HARNESS_ENGINES.find((e) => e.id === engineId)!;
            const { raw, result } = await runHostSequence(engine, input, options, METRICS);
            return { value: result, diagnostics: engineNotes(raw.notes) };
          } finally {
            running -= 1;
          }
        },
        dispose() {
          disposed += 1;
        },
      };
    },
    probe: () => ({ hosts, disposed, runs, maxConcurrent }),
  };
}

function manualClock(): { readonly schedule: Schedule; readonly advance: (ms: number) => void } {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      const cancel: Cancel = () => {
        t.cancelled = true;
      };
      return cancel;
    },
    advance: (ms) => {
      now += ms;
      for (const t of timers.filter((x) => !x.cancelled && x.at <= now)) {
        t.cancelled = true;
        t.fn();
      }
    },
  };
}

function setup() {
  const hosts = fakeHosts();
  const clock = manualClock();
  const previewer = createPreviewer({ measurer: new TestMeasurer(), metrics: METRICS, createHost: hosts.create, schedule: clock.schedule, engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id) });
  const render = (req: PreviewRequest): Promise<PreviewOutcome> => new Promise((done) => previewer.render(req, done));
  return { previewer, hosts, clock, render };
}

const req = (key: string, source: string, engineId = 'sgl.grid', themeId = 'neutral-light'): PreviewRequest => ({ key, source, engineId, themeId });

describe('help previews (DD-13 P24–P27)', () => {
  it('renders an example through the app pipeline: the same SVG the editor would show for that text', async () => {
    const { previewer, render } = setup();
    previewer.open();
    const source = 'a\nb\na -> b\n';
    const out = await render(req('x#1', source));
    const editor = await createHarness(source);
    expect(out.svg).toBe(editor.pipeline.lastGood.peek()!.svg);
    expect(out.codes).toEqual([]);
    expect(out.engineId).toBe('sgl.grid');
    editor.dispose();
  });

  it('runs one example at a time, on one host of its own, however many are asked for at once', async () => {
    const { previewer, hosts, render } = setup();
    previewer.open();
    const outs = await Promise.all([render(req('a#1', 'a\n')), render(req('b#1', 'b\nc\nb -> c\n')), render(req('c#1', 'x\n'))]);
    expect(outs.every((o) => o.svg !== null)).toBe(true);
    expect(hosts.probe()).toMatchObject({ hosts: 1, runs: 3, maxConcurrent: 1 });
  });

  it('caches by (example, theme, engine): the same again costs no layout; another theme renders again', async () => {
    const { previewer, hosts, render } = setup();
    previewer.open();
    const first = await render(req('a#1', 'a\nb\n'));
    const again = await render(req('a#1', 'a\nb\n'));
    expect(again).toBe(first);
    expect(hosts.probe().runs).toBe(1);
    const dark = await render(req('a#1', 'a\nb\n', 'sgl.grid', 'neutral-dark'));
    expect(dark.svg).not.toBe(first.svg);
    expect(hosts.probe().runs).toBe(2);
  });

  it('the cache keeps the 64 most recently used', async () => {
    const { previewer, hosts, render } = setup();
    previewer.open();
    for (let i = 0; i <= PREVIEW_CACHE_SIZE; i += 1) await render(req(`e#${i}`, `n${i}\n`));
    const runs = hosts.probe().runs;
    await render(req(`e#${PREVIEW_CACHE_SIZE}`, `n${PREVIEW_CACHE_SIZE}\n`)); // the newest: cached
    expect(hosts.probe().runs).toBe(runs);
    await render(req('e#0', 'n0\n')); // the oldest: evicted
    expect(hosts.probe().runs).toBe(runs + 1);
  });

  it('a cancelled request never runs', async () => {
    const { previewer, hosts, render } = setup();
    previewer.open();
    const first = render(req('a#1', 'a\n'));
    let called = false;
    const cancel = previewer.render(req('b#1', 'b\n'), () => {
      called = true;
    });
    cancel();
    await first;
    await render(req('c#1', 'c\n'));
    expect(called).toBe(false);
    expect(hosts.probe().runs).toBe(2);
  });

  it('reports the diagnostics; an example with an error has no SVG', async () => {
    const { previewer, render } = setup();
    previewer.open();
    const warned = await render(req('w#1', 'a: { @nope: 1 }\n'));
    expect(warned.svg).not.toBeNull();
    expect(warned.codes).toEqual(['SGL2010']);
    const broken = await render(req('e#1', 'a -> b\n'));
    expect(broken.svg).toBeNull();
    expect(broken.codes.length).toBeGreaterThan(0);
  });

  it('the host is disposed 60 s after help closes, not before; reopening in time keeps it; a later preview makes a new one', async () => {
    const { previewer, hosts, clock, render } = setup();
    previewer.open();
    await render(req('a#1', 'a\n'));
    previewer.close();
    clock.advance(DISPOSE_AFTER_MS - 1);
    expect(hosts.probe().disposed).toBe(0);
    previewer.open(); // back within the minute
    clock.advance(DISPOSE_AFTER_MS);
    expect(hosts.probe().disposed).toBe(0);
    previewer.close();
    clock.advance(DISPOSE_AFTER_MS);
    expect(hosts.probe()).toMatchObject({ hosts: 1, disposed: 1 });
    expect(previewer.hostAlive()).toBe(false);
    previewer.open();
    await render(req('b#1', 'b\n'));
    expect(hosts.probe().hosts).toBe(2);
  });

  it('no host is made until the first preview', () => {
    const { previewer, hosts } = setup();
    previewer.open();
    previewer.close();
    expect(hosts.probe().hosts).toBe(0);
    expect(previewer.hostAlive()).toBe(false);
  });
});

describe('the engine of a preview (DD-13 P27)', () => {
  const engines = REGISTERED_ENGINES;
  it('is the example\'s own, by bare name, else elk', () => {
    expect(previewEngineId(undefined, engines, 'sgl.elk')).toBe('sgl.elk');
    expect(previewEngineId('grid', engines, 'sgl.elk')).toBe('sgl.grid');
    expect(previewEngineId('fixed', engines, 'sgl.elk')).toBe('sgl.fixed');
    expect(previewEngineId('sgl.tree', engines, 'sgl.elk')).toBe('sgl.tree');
    expect(previewEngineId('nope', engines, 'sgl.elk')).toBe('nope');
  });
});
