// The Markdown preview's background tone — a persisted reading preference.
//
// The allowed tones are listed three times and kept in lockstep by a contract
// test: here, in Rust (`settings::PREVIEW_BACKGROUNDS`, which resets anything
// else on load) and as CSS tokens (`--preview-bg-*` in index.css). Components
// select a tone by key only; the colours live in CSS. Screen-only — print/PDF
// export is unaffected.

import { api } from "./api";
import { tNow } from "./i18n";
import { useStore } from "./store";
import type { PreviewBackground, Settings } from "./types";

export const PREVIEW_BACKGROUNDS = ["white", "warm", "gray", "paper", "mint", "blue"] as const;

/** English labels (dictionary keys; translated at render). */
export const PREVIEW_BACKGROUND_LABELS: Record<PreviewBackground, string> = {
  white: "White",
  warm: "Warm gray",
  gray: "Light gray",
  paper: "Paper",
  mint: "Mint",
  blue: "Light blue",
};

export function previewBackgroundOf(settings: Settings | null): PreviewBackground {
  const value = settings?.previewBackground;
  return value && (PREVIEW_BACKGROUNDS as readonly string[]).includes(value) ? value : "white";
}

/** Apply immediately, then persist. A failed save keeps the tone for this session and says so. */
export async function setPreviewBackground(tone: PreviewBackground): Promise<void> {
  const s = useStore.getState();
  if (!s.settings) return;
  const next: Settings = { ...s.settings, previewBackground: tone };
  s.setSettings(next);
  try {
    await api.saveSettings(next);
  } catch (e) {
    const detail = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    useStore.getState().notify(`${tNow("Couldn't save the preview background:")} ${detail}`, "error");
  }
}
