import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { NodeId } from '@sgl/core';
import type { Pipeline } from '../state/pipeline.js';
import { hitTestNode } from './hit-test.js';
import { boundsChangedSignificantly, fitViewport, panBy, screenToDiagram, zoomAt, IDENTITY_VIEWPORT, type Extent, type Viewport } from './viewport.js';

export interface CanvasProps {
  readonly pipeline: Pipeline;
}

/**
 * The host `<svg>`, the pan/zoom viewport, the `innerHTML` swap of a wrapper `<g>`
 * and the interaction overlay as a sibling `<g>` (DD-08 §6). Hover/click are
 * computed from `lastGood.layout` frames, never the DOM.
 */
export function Canvas({ pipeline }: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<SVGGElement | null>(null);
  const viewportGRef = useRef<SVGGElement | null>(null);
  const overlayGRef = useRef<SVGGElement | null>(null);
  const hoverRectRef = useRef<SVGRectElement | null>(null);
  const selectedRectRef = useRef<SVGRectElement | null>(null);

  const viewportRef = useRef<Viewport>(IDENTITY_VIEWPORT);
  const hasFittedRef = useRef(false);
  const lastBoundsRef = useRef<Extent | null>(null);
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
  // every render after that).
  useEffect(() => {
    const disposeRenderEffect = effect(() => {
      const lastGood = pipeline.lastGood.value;
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      wrapper.innerHTML = lastGood === null ? '' : lastGood.svg;

      const bounds = lastGood === null ? null : { w: lastGood.layout.bounds.w, h: lastGood.layout.bounds.h };
      if (!hasFittedRef.current && bounds !== null) {
        hasFittedRef.current = true;
        lastBoundsRef.current = bounds;
        fitNow();
      } else if (bounds !== null && boundsChangedSignificantly(lastBoundsRef.current, bounds)) {
        // DD-08 §6: offer "Fit" rather than fitting automatically — no chip in
        // part 1 (§11 is part 2), so this is recorded but not surfaced yet.
        lastBoundsRef.current = bounds;
      } else if (bounds !== null) {
        lastBoundsRef.current = bounds;
      }
      updateOverlayRect(selectedRectRef, selectedRef.current);
    });
    return () => disposeRenderEffect();
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
      <button type="button" class="fit-button" onClick={fitNow}>
        ⟳ Fit
      </button>
    </div>
  );
}
