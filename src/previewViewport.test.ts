import { describe, expect, it } from "vitest";
import {
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  clampPreviewOffset,
  panForWheel,
  zoomForPinch,
  zoomForWheel,
} from "./previewViewport";

describe("zoomForWheel — ⌘/Ctrl + scroll wheel zooms the preview", () => {
  it("scrolling up zooms in, down zooms out", () => {
    expect(zoomForWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomForWheel(1, 100)).toBeLessThan(1);
  });
  it("one notch in then one notch out returns to the same zoom", () => {
    expect(zoomForWheel(zoomForWheel(1.3, -40), 40)).toBeCloseTo(1.3);
  });
  it("treats a line-mode mouse wheel like pixels", () => {
    expect(zoomForWheel(1, 3, 1)).toBeCloseTo(zoomForWheel(1, 48, 0));
  });
  it("stays within the zoom range", () => {
    expect(zoomForWheel(2.4, -10000)).toBe(PREVIEW_ZOOM_MAX);
    expect(zoomForWheel(0.7, 10000)).toBe(PREVIEW_ZOOM_MIN);
  });
});

describe("zoomForPinch — trackpad pinch", () => {
  it("scales the zoom the gesture started at, clamped", () => {
    expect(zoomForPinch(1.2, 1.5)).toBeCloseTo(1.8);
    expect(zoomForPinch(2, 3)).toBe(PREVIEW_ZOOM_MAX);
    expect(zoomForPinch(1, Number.NaN)).toBe(1);
  });
});

describe("panForWheel — sideways swipe / Shift + wheel moves the column", () => {
  it("pans on a mostly-horizontal swipe, following the fingers", () => {
    expect(panForWheel(30, 4, false)).toBe(-30);
  });
  it("leaves vertical scrolling (with trackpad jitter) to the browser", () => {
    expect(panForWheel(3, 40, false)).toBeNull();
  });
  it("Shift + wheel pans", () => {
    expect(panForWheel(0, 50, true)).toBe(-50);
  });
});

describe("clampPreviewOffset — the column never leaves the screen entirely", () => {
  it("lets the column move freely while it stays partly visible", () => {
    expect(clampPreviewOffset(200, 1000, 600)).toBe(200);
  });
  it("stops once only the kept strip remains visible", () => {
    // (1000 + 600) / 2 − 160 = 640
    expect(clampPreviewOffset(5000, 1000, 600)).toBe(640);
    expect(clampPreviewOffset(-5000, 1000, 600)).toBe(-640);
  });
  it("recovers from a non-number", () => {
    expect(clampPreviewOffset(Number.NaN, 1000, 600)).toBe(0);
  });
});
