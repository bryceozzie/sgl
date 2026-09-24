import { effect, type ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { NodeId } from '@sgl/core';
import type { PaintPlan } from '@sgl/render-svg';
import { StatusChip } from '../panels/StatusChip.js';
import type { Pipeline } from '../state/pipeline.js';
import type { LastGood } from '../state/types.js';
import { hitTestNode } from './hit-test.js';
import { showLastGood } from './paint.js';
import { fitViewport, panBy, screenToDiagram, svgExtent, zoomAt, IDENTITY_VIEWPORT, type Extent, type Viewport } from './viewport.js';

export interface CanvasProps {
  readonly pipeline: Pipeline;
  /** Handed the imperative `fit()` function once the canvas mounts, and
   *  `null` on unmount — the toolbar's Fit button and the status chip's "Fit"
   *  offer (DD-08 §6, §11) both trigger the same function from outside this
   *  component. */
  readonly onFitReady?: (fit: (() => void) | null) => void;
  /** DD-08 §5/§9 (J6): the open document's stored `lastGoodSvg`, painted
   *  while `lastGood` is still `null` — at boot, before fonts or the worker
   *  are ready, and after switching documents (fix round 2), until that
   *  document's first live render — so a returning user never sees a blank
   *  canvas. */
  readonly storedSvg?: ReadonlySignal<string | undefined>;
  /** Bumped when a new document opens (§7 Open): the next render fits, as on
   *  first open (DD-08 §6: "fit on document open"). */
  readonly fitRequest?: number;
}

/**
 * The host `<svg>`, the pan/zoom viewport, the `innerHTML` swap of a wrapper `<g>`
 * and the interaction overlay as a sibling `<g>` (DD-08 §6). Hover/click are
 * computed from `lastGood.layout` frames, never the DOM.
 */
export function Canvas({ pipeline, onFitReady, storedSvg, fitRequest = 0 }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<SVGGElement | null>(null);
  const viewportGRef = useRef<SVGGElement | null>(null);
  const overlayGRef = useRef<SVGGElement | null>(null);
  const hoverRectRef = useRef<SVGRectElement | null>(null);
  const selectedRectRef = useRef<SVGRectElement | null>(null);

  const viewportRef = useRef<Viewport>(IDENTITY_VIEWPORT);
  const hasFittedRef = useRef(false);
  /** Whether what is on screen is the stored boot picture (J6) rather than a
   *  live render; the extent to fit it to comes from its own `viewBox`. */
  const showingStoredRef = useRef(false);
  /** The element tree the wrapper holds (`LastGood.paintPlan` of the live
   *  render last put there), `null` for nothing or the stored picture: a
   *  `lastGood` with this plan is shown by swapping its `<style>` text alone
   *  (F9 P3, `paint.ts`). */
  const onScreenPlanRef = useRef<PaintPlan | null>(null);
  const draggingRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const selectedRef = useRef<NodeId | null>(null);

  function applyTransform(): void {
    const { k, tx, ty } = viewportRef.current;
    const transform = `translate(${tx} ${ty}) scale(${k})`;
    viewportGRef.current?.setAttribute('transform', transform);
    overlayGRef.current?.setAttribute('transform', transform);
  }

  function viewportSize(): Extent {
    const rect = svgRef.current?.getBoundingClientRect();
    return { w: rect?.width ?? 0, h: rect?.height ?? 0 };
  }

  function fitNow(): void {
    const bounds = pipeline.lastGood.peek()?.layout.bounds;
    const stored = storedSvg?.peek();
    const extent = bounds !== undefined ? { w: bounds.w, h: bounds.h } : showingStoredRef.current && stored !== undefined ? svgExtent(stored) : null;
    if (extent === null) return;
    viewportRef.current = fitViewport(extent, viewportSize());
    applyTransform();
    if (bounds !== undefined) pipeline.fitDone(); // records the baseline for DD-08 §6's 40% "Fit" offer.
  }

  /** After the next frame, `data-paint-hash` for `good` — if it is still
   *  what the canvas shows. */
  const paintStampRef = useRef<{ cancel: () => void } | null>(null);
  function stampPaintHashLater(wrapper: SVGGElement, good: LastGood): void {
    paintStampRef.current?.cancel();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        paintStampRef.current = null;
        if (pipeline.lastGood.peek() === good) wrapper.setAttribute('data-paint-hash', good.styled.paintHash);
      }, 0);
    });
    paintStampRef.current = {
      cancel: () => {
        cancelAnimationFrame(frame);
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  function updateOverlayRect(ref: { current: SVGRectElement | null }, id: NodeId | null): void {
    const rect = ref.current;
    if (rect === null) return;
    const layout = pipeline.lastGood.peek()?.layout;
    const frame = id === null || layout === undefined ? undefined : layout.nodes[id]?.frame;
    if (frame === undefined) {
      rect.setAttribute('visibility', 'hidden');
      return;
    }
    rect.setAttribute('visibility', 'visible');
    rect.setAttribute('x', String(frame.x));
    rect.setAttribute('y', String(frame.y));
    rect.setAttribute('width', String(frame.w));
    rect.setAttribute('height', String(frame.h));
  }

  // Swap the rendered SVG in on every `lastGood` change; fit once, the first
  // time there is something to fit (DD-08 §6: "on document open," never on
  // every render after that — a later bounds change instead surfaces through
  // `pipeline.chip.value.offerFit`, computed in the DOM-free state layer).
  useEffect(() => {
    const disposeRenderEffect = effect(() => {
      const lastGood = pipeline.lastGood.value;
      const bootSvg = storedSvg?.value;
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      if (lastGood === null && bootSvg !== undefined) {
        // J6: the stored picture, until the first live render replaces it.
        // It is this document's own last good `render()` output, from our
        // own storage — the same trust as `lastGood.svg` itself.
        wrapper.innerHTML = bootSvg;
        onScreenPlanRef.current = null;
        wrapper.setAttribute('data-origin', 'stored');
        wrapper.removeAttribute('data-paint-hash');
        wrapper.removeAttribute('data-theme');
        showingStoredRef.current = true;
        fitNow();
        return;
      }
      const replacingStored = showingStoredRef.current;
      showingStoredRef.current = false;
      // The whole tree, or — when the tree on screen is the one this render
      // is drawn as — only its `<style>` text (F9 P3; DD-08 §6).
      if (lastGood === null) wrapper.innerHTML = '';
      else showLastGood(wrapper, lastGood, onScreenPlanRef.current);
      onScreenPlanRef.current = lastGood?.paintPlan ?? null;
      // `live` once a render of the running pipeline is on screen — the e2e
      // suite waits on it, so a stored boot picture is never mistaken for one.
      if (lastGood === null) wrapper.removeAttribute('data-origin');
      else wrapper.setAttribute('data-origin', 'live');
      // Which render is on screen, stamped from the same `lastGood` just
      // swapped in: a theme switch changes neither the node count nor any
      // geometry a test could wait on, so the e2e suite awaits `data-theme`
      // reaching the new theme instead of sleeping (Stage I fix round 1,
      // item 8). Not part of the exported SVG — it sits on the wrapper `<g>`.
      // `data-paint-hash` is removed now and stamped after the frame: it
      // reads `StyledGraph.paintHash`, which is hashed on first read (F9),
      // and nothing on screen depends on it.
      wrapper.removeAttribute('data-paint-hash');
      if (lastGood === null) wrapper.removeAttribute('data-theme');
      else {
        wrapper.setAttribute('data-theme', lastGood.styled.themeId);
        stampPaintHashLater(wrapper, lastGood);
      }

      // The first live render fits even after a stored picture did: that
      // records the fit baseline (§6's 40% offer) against real bounds, and
      // for the same document it lands on the same transform anyway.
      if ((!hasFittedRef.current || replacingStored) && lastGood !== null) {
        hasFittedRef.current = true;
        fitNow();
      }
      updateOverlayRect(selectedRectRef, selectedRef.current);
    });
    return () => {
      disposeRenderEffect();
      paintStampRef.current?.cancel();
    };
  }, [pipeline]);

  useEffect(() => {
    onFitReady?.(fitNow);
    return () => onFitReady?.(null);
  }, [pipeline]);

  // A newly opened document fits on its first render, like the first one did.
  useEffect(() => {
    if (fitRequest > 0) hasFittedRef.current = false;
  }, [fitRequest]);

  function onWheel(ev: WheelEvent): void {
    const svg = svgRef.current;
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const factor = Math.exp(-ev.deltaY * 0.01);
      viewportRef.current = zoomAt(viewportRef.current, cx, cy, factor);
    } else {
      viewportRef.current = panBy(viewportRef.current, -ev.deltaX, -ev.deltaY);
    }
    applyTransform();
  }

  function onPointerDown(ev: PointerEvent): void {
    draggingRef.current = { x: ev.clientX, y: ev.clientY };
    svgRef.current?.setPointerCapture(ev.pointerId);
  }

  function onPointerMove(ev: PointerEvent): void {
    const drag = draggingRef.current;
    if (drag !== null) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      draggingRef.current = { x: ev.clientX, y: ev.clientY };
      viewportRef.current = panBy(viewportRef.current, dx, dy);
      applyTransform();
      return;
    }
    const layout = pipeline.lastGood.peek()?.layout;
    if (layout === undefined) return;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (svgRect === undefined) return;
    const point = screenToDiagram(viewportRef.current, ev.clientX - svgRect.left, ev.clientY - svgRect.top);
    const hit = hitTestNode(layout, point);
    updateOverlayRect(hoverRectRef, hit);
  }

  function onPointerUp(ev: PointerEvent): void {
    const drag = draggingRef.current;
    draggingRef.current = null;
    svgRef.current?.releasePointerCapture(ev.pointerId);
    if (drag !== null && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 4) return; // a drag, not a click.

    const layout = pipeline.lastGood.peek()?.layout;
    if (layout === undefined) return;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (svgRect === undefined) return;
    const point = screenToDiagram(viewportRef.current, ev.clientX - svgRect.left, ev.clientY - svgRect.top);
    selectedRef.current = hitTestNode(layout, point);
    updateOverlayRect(selectedRectRef, selectedRef.current);
    // ⟶ E7 (part 2+): scroll the editor to graph.nodes[id].span.
  }

  return (
    <div class="canvas-host">
      <svg
        class="host"
        width="100%"
        height="100%"
        ref={svgRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <g class="viewport" ref={viewportGRef}>
          <g class="rendered" ref={wrapperRef} />
        </g>
        <g class="overlay" ref={overlayGRef} aria-hidden="true">
          <rect ref={hoverRectRef} class="node-outline hover" visibility="hidden" fill="none" />
          <rect ref={selectedRectRef} class="node-outline selected" visibility="hidden" fill="none" />
        </g>
      </svg>
      {/* DD-08 §2: the Fit *control* lives in the toolbar (`onFitReady` hands
          this component's `fitNow` up to it); the chip's own "Fit" offer
          (§6, §11) triggers the same function locally. */}
      <StatusChip pipeline={pipeline} onFit={fitNow} />
    </div>
  );
}
