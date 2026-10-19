// Pure label helpers for the health bar (HealthBar.tsx) and DiffPanel.
//
// Constraints:
// - changesLabel never answers "No changes since last save" while the
//   document is dirty (BUG-015b / MISS-12): a dirty document whose content
//   matches an UNSAVED baseline (an AI draft, a repaired file — MISS-12)
//   reads "Unsaved (matches last save)". For a saved baseline, every edit,
//   undo, redo and save derives dirty from the same predicate (diff.ts
//   sameAsSaved ⇔ !hasChanges, QA 20261003); a view switch does not
//   (BUG-019a), so the two can part only through a switch's stored source.
//   Known cases, both pinned in store.test.ts (review follow-up C1, QA
//   20261003): an UNTITLED blank Markdown tab with whitespace typed, then
//   switched Editor → Markdown, reads dirty + "Unsaved (matches last save)";
//   an empty titled .md switched Editor → Markdown reads clean + "Markdown
//   source changed".
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
  "Markdown source changed",
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
  // Only the Markdown text differs (QA 20261003): named even when clean (the
  // empty titled .md view-switch case in the header).
  if (summary.sourceChanged) return translateWith("Markdown source changed", lang, {});
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
