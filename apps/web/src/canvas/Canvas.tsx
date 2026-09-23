import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { NodeId } from '@sgl/core';
import { StatusChip } from '../panels/StatusChip.js';
import type { Pipeline } from '../state/pipeline.js';
import { hitTestNode } from './hit-test.js';
import { fitViewport, panBy, screenToDiagram, zoomAt, IDENTITY_VIEWPORT, type Extent, type Viewport } from './viewport.js';

export interface CanvasProps {
  readonly pipeline: Pipeline;
  /** Handed the imperative `fit()` function once the canvas mounts, and
   *  `null` on unmount — the toolbar's Fit button and the status chip's "Fit"
   *  offer (DD-08 §6, §11) both trigger the same function from outside this
   *  component. */
  readonly onFitReady?: (fit: (() => void) | null) => void;
}

/**
 * The host `<svg>`, the pan/zoom viewport, the `innerHTML` swap of a wrapper `<g>`
 * and the interaction overlay as a sibling `<g>` (DD-08 §6). Hover/click are
 * computed from `lastGood.layout` frames, never the DOM.
 */
export function Canvas({ pipeline, onFitReady }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<SVGGElement | null>(null);
  const viewportGRef = useRef<SVGGElement | null>(null);
  const overlayGRef = useRef<SVGGElement | null>(null);
  const hoverRectRef = useRef<SVGRectElement | null>(null);
  const selectedRectRef = useRef<SVGRectElement | null>(null);

  const viewportRef = useRef<Viewport>(IDENTITY_VIEWPORT);
  const hasFittedRef = useRef(false);
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
    if (bounds === undefined) return;
    viewportRef.current = fitViewport({ w: bounds.w, h: bounds.h }, viewportSize());
    applyTransform();
    pipeline.fitDone(); // records the baseline for DD-08 §6's 40% "Fit" offer.
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
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      wrapper.innerHTML = lastGood === null ? '' : lastGood.svg;
      // Which render is on screen, stamped from the same `lastGood` just
      // swapped in: a theme switch changes neither the node count nor any
      // geometry a test could wait on, so the e2e suite awaits `data-theme`
      // reaching the new theme instead of sleeping (Stage I fix round 1,
      // item 8). Not part of the exported SVG — it sits on the wrapper `<g>`.
      if (lastGood === null) {
        wrapper.removeAttribute('data-paint-hash');
        wrapper.removeAttribute('data-theme');
      } else {
        wrapper.setAttribute('data-paint-hash', lastGood.styled.paintHash);
        wrapper.setAttribute('data-theme', lastGood.styled.themeId);
      }

      if (!hasFittedRef.current && lastGood !== null) {
        hasFittedRef.current = true;
        fitNow();
      }
      updateOverlayRect(selectedRectRef, selectedRef.current);
    });
    return () => disposeRenderEffect();
  }, [pipeline]);

  useEffect(() => {
    onFitReady?.(fitNow);
    return () => onFitReady?.(null);
  }, [pipeline]);

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
