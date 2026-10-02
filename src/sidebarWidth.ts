// Files sidebar width — a persisted layout preference, set by dragging the
// sidebar's edge. Bounds are mirrored in Rust (`settings::SIDEBAR_WIDTH_MIN/MAX`,
// which clamps on load) and kept in lockstep by a contract test.

import { api } from "./api";
import { tNow } from "./i18n";
import { useStore } from "./store";
import type { Settings } from "./types";

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 560;
export const SIDEBAR_WIDTH_DEFAULT = 256;
/** Keyboard resize step (arrow keys on the handle). */
export const SIDEBAR_WIDTH_STEP = 16;

/** Clamp to the bounds, and leave at least `reserve` px for the document when a viewport is given. */
export function clampSidebarWidth(width: number, viewport?: number, reserve = 360): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  let max = SIDEBAR_WIDTH_MAX;
  if (viewport !== undefined) max = Math.max(SIDEBAR_WIDTH_MIN, Math.min(max, viewport - reserve));
  return Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH_MIN, width)));
}

export function sidebarWidthOf(settings: Settings | null): number {
  const w = settings?.sidebarWidth;
  return typeof w === "number" ? clampSidebarWidth(w) : SIDEBAR_WIDTH_DEFAULT;
}

/** Persist a finished resize. A failed save keeps the width for this session and says so. */
export async function saveSidebarWidth(width: number): Promise<void> {
  const s = useStore.getState();
  if (!s.settings) return;
  const next: Settings = { ...s.settings, sidebarWidth: clampSidebarWidth(width) };
  if (next.sidebarWidth === s.settings.sidebarWidth) return;
  s.setSettings(next);
  try {
    await api.saveSettings(next);
  } catch (e) {
    const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    useStore.getState().notify(`${tNow("Couldn't save the sidebar width:")} ${detail}`, "error");
  }
}
