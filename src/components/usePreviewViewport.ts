// Mouse and trackpad control of the Markdown preview viewport:
//   ⌘/Ctrl + wheel, or a trackpad pinch → zoom, keeping the text under the
//     pointer where it is;
//   sideways swipe, Shift + wheel, Option + drag or middle-button drag → move
//     the reading column left/right.
// The arithmetic lives in ../previewViewport.ts (unit-tested); this file only
// reads events and layout.

import { type RefObject, useEffect } from "react";
import {
  clampPreviewOffset,
  panForWheel,
  zoomForPinch,
  zoomForWheel,
} from "../previewViewport";
import { useStore } from "../store";

/** Palette bridge: move the preview column sideways by `detail` px. */
export const PREVIEW_PAN_EVENT = "nurumayu:preview-pan";
export function requestPreviewPan(dx: number): void {
  window.dispatchEvent(new CustomEvent(PREVIEW_PAN_EVENT, { detail: dx }));
}

// WebKit's trackpad pinch events (not in the DOM lib types).
interface GestureLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

export function usePreviewViewport(scroller: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = scroller.current;
    if (!active || !el) return;
    const store = useStore.getState;

    const columnWidth = () =>
      el.querySelector<HTMLElement>(".markdown-preview")?.getBoundingClientRect().width ?? el.clientWidth;
    const panBy = (dx: number) =>
      store().setMarkdownOffsetX(clampPreviewOffset(store().markdownOffsetX + dx, el.clientWidth, columnWidth()));

    // Zoom keeping the point under the pointer fixed: remember which block is
    // there (and how far into it), zoom, then scroll that point back under it.
    let anchor: { block: HTMLElement; into: number; y: number } | null = null;
    const zoomAt = (x: number, y: number, next: number) => {
      if (!anchor) {
        const rect = el.getBoundingClientRect();
        const hit =
          document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-source-line]") ??
          document.elementFromPoint(rect.left + rect.width / 2, y)?.closest<HTMLElement>("[data-source-line]");
        if (hit && el.contains(hit)) {
          const box = hit.getBoundingClientRect();
          anchor = { block: hit, into: box.height > 0 ? (y - box.top) / box.height : 0, y };
          requestAnimationFrame(() => {
            if (!anchor) return;
            const after = anchor.block.getBoundingClientRect();
            el.scrollTop += after.top + anchor.into * after.height - anchor.y;
            anchor = null;
          });
        }
      }
      store().setMarkdownZoom(next);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Also what a pinch arrives as where the browser maps it to Ctrl+wheel.
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, zoomForWheel(store().markdownZoom, e.deltaY, e.deltaMode));
        return;
      }
      const dx = panForWheel(e.deltaX, e.deltaY, e.shiftKey);
      if (dx === null) return;
      e.preventDefault();
      panBy(dx);
    };

    let pinchStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchStart = store().markdownZoom;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLike;
      zoomAt(g.clientX, g.clientY, zoomForPinch(pinchStart, g.scale));
    };
    const onGestureEnd = (e: Event) => e.preventDefault();

    // Option + drag (or middle-button drag) moves the column; a plain drag
    // still selects text.
    let drag: { id: number; startX: number; startOffset: number } | null = null;
    const isPanStart = (e: MouseEvent) => e.button === 1 || (e.button === 0 && e.altKey);
    const onPointerDown = (e: PointerEvent) => {
      if (!isPanStart(e)) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, startX: e.clientX, startOffset: store().markdownOffsetX };
      el.style.cursor = "grabbing";
    };
    const onMouseDown = (e: MouseEvent) => {
      if (isPanStart(e)) e.preventDefault(); // no caret, no text selection
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      store().setMarkdownOffsetX(
        clampPreviewOffset(drag.startOffset + e.clientX - drag.startX, el.clientWidth, columnWidth())
      );
    };
    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.style.cursor = "";
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onPan = (e: Event) => panBy(Number((e as CustomEvent<number>).detail) || 0);

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    window.addEventListener(PREVIEW_PAN_EVENT, onPan);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
      window.removeEventListener(PREVIEW_PAN_EVENT, onPan);
      el.style.cursor = "";
    };
  }, [scroller, active]);
}
