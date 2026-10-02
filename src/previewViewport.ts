// Markdown preview viewport: mouse/trackpad zoom and sideways panning of the
// reading column. Pure arithmetic; the DOM wiring is usePreviewViewport.ts.

export const PREVIEW_ZOOM_MIN = 0.6;
export const PREVIEW_ZOOM_MAX = 2.5;
/** Palette / button step for moving the column sideways, in screen px. */
export const PREVIEW_PAN_STEP = 80;
/** However far the column is moved, this much of it stays on screen. */
export const PREVIEW_PAN_KEEP_VISIBLE = 160;

const clampZoom = (z: number) => Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, z));

/**
 * Zoom after one ⌘/Ctrl + wheel event. Exponential, so a notch in and a notch
 * out return to the same zoom, and trackpad (pixel) and mouse-wheel (line)
 * deltas feel alike.
 */
export function zoomForWheel(zoom: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return clampZoom(zoom * Math.exp(-px * 0.0025));
}

/** Zoom during a trackpad pinch: the zoom at gesture start times the gesture's scale. */
export function zoomForPinch(startZoom: number, scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? clampZoom(startZoom * scale) : clampZoom(startZoom);
}

/**
 * Horizontal pan for a plain wheel event, or null when it is a vertical scroll
 * (left to the browser). A sideways trackpad swipe pans; so does Shift + wheel.
 * Returns the change to the column offset (swipe left → column moves left).
 */
export function panForWheel(deltaX: number, deltaY: number, shiftKey: boolean): number | null {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return -deltaX;
  if (shiftKey && deltaY !== 0) return -deltaY;
  return null;
}

/**
 * Keep the moved column partly on screen: its centre may travel until only
 * `keep` px of it remain visible at either edge.
 */
export function clampPreviewOffset(
  offset: number,
  viewportWidth: number,
  contentWidth: number,
  keep = PREVIEW_PAN_KEEP_VISIBLE
): number {
  if (!Number.isFinite(offset)) return 0;
  const limit = Math.max(0, (viewportWidth + contentWidth) / 2 - Math.min(keep, contentWidth));
  return Math.round(Math.min(limit, Math.max(-limit, offset)));
}
