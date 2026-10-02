// Pure label helpers for the health bar (HealthBar.tsx) and DiffPanel.
//
// Constraints:
// - changesLabel never answers "No changes since last save" while the
//   document is dirty (BUG-015b / MISS-12): a dirty document whose content
//   matches the saved baseline (e.g. undo back to it) reads "Unsaved (matches
//   last save)".
// - A draft report (fileActions.draftDocument writes format "draft" into the
//   single lastExportReport slot) is labelled as a draft, not as an export.
// - Keys are passed to translateWith as literals so the i18n coverage scan
//   sees them; HEALTH_LABEL_KEYS lists them for the JA-entry test.

import { translateWith, type UiLang } from "./i18n";
import type { ChangeSummary } from "./diff";

export const HEALTH_LABEL_KEYS = [
  "{n} changed since last save",
  "Title changed",
  "Order, analysis or metadata changed",
  "Unsaved (matches last save)",
  "No changes since last save",
  "Draft report",
  "Last draft",
  "Export ({format})",
  "Last export — {format}",
] as const;

/** The "changes since last save" label for the given summary and dirty flag. */
export function changesLabel(summary: ChangeSummary, dirty: boolean, lang: UiLang): string {
  if (summary.paragraphs > 0) {
    return translateWith("{n} changed since last save", lang, { n: summary.paragraphs });
  }
  if (summary.titleChanged) return translateWith("Title changed", lang, {});
  if (summary.otherChanged) return translateWith("Order, analysis or metadata changed", lang, {});
  return dirty
    ? translateWith("Unsaved (matches last save)", lang, {})
    : translateWith("No changes since last save", lang, {});
}

/** Button text and popover heading for the last export / draft report. */
export function reportLabels(format: string, lang: UiLang): { button: string; heading: string } {
  if (format === "draft") {
    return {
      button: translateWith("Draft report", lang, {}),
      heading: translateWith("Last draft", lang, {}),
    };
  }
  const f = format.toUpperCase();
  return {
    button: translateWith("Export ({format})", lang, { format: f }),
    heading: translateWith("Last export — {format}", lang, { format: f }),
  };
}
