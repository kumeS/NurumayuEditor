// Draft length targets and reports (BUG-005a/c): the option labels in the
// Draft dialog, the live progress label while a draft streams, and the
// achieved-vs-target report after it finishes.
//
// Constraints:
// - One counter, one unit rule: achieved length comes from textStats'
//   documentTextStats + lengthUnitFor (the same numbers the status bar shows).
//   When the draft is measured in characters, the word target is converted
//   with CJK_CHARS_PER_WORD — the constant Rust's draft prompt uses
//   (JA_CHARS_PER_WORD, contract-tested in textStats.test.ts).
// - Option labels follow the UI language: Japanese shows 約N字 (N = words ×
//   CJK_CHARS_PER_WORD), English shows words.
// - Pure: no store, no Tauri. Callers pass the UI language.
// Known limit: an English UI with a 中文 / 한국어 output language still labels
// the options in words, while the backend asks the model for characters
// (CHAR_MEASURED_LANGUAGES in ai.rs); the post-draft report measures the
// actual text, so it stays correct.

import { translate, translateWith, type UiLang } from "./i18n";
import { CJK_CHARS_PER_WORD, documentTextStats, lengthUnitFor, type LengthUnit } from "./textStats";
import type { Chunk } from "./types";

/** Draft length choices, in words. `null` lets the model choose (Auto). */
export const DRAFT_TARGETS: readonly (number | null)[] = [null, 300, 800, 1500, 3000];

/** A result more than this fraction away from its target is reported. */
export const DRAFT_LENGTH_TOLERANCE = 0.2;

export interface DraftMeasure {
  unit: LengthUnit;
  achieved: number;
  /** Target in `unit`, or null when no target was requested. */
  target: number | null;
}

/** Label for one Draft length option in the UI language. */
export function draftLengthOptionLabel(words: number | null, lang: UiLang): string {
  if (words === null) return translate("Auto", lang);
  const vars = { words, chars: words * CJK_CHARS_PER_WORD };
  if (words <= 300) return translateWith("Short (~{words} words)", lang, vars);
  if (words <= 800) return translateWith("Medium (~{words} words)", lang, vars);
  if (words <= 1500) return translateWith("Long (~{words} words)", lang, vars);
  return translateWith("Very long (~{words} words)", lang, vars);
}

/** Measure a (partial or final) draft against its word target. */
export function measureDraft(chunks: Chunk[], targetWords: number | undefined): DraftMeasure {
  const stats = documentTextStats(chunks);
  const unit = lengthUnitFor(stats);
  const chars = unit === "characters";
  return {
    unit,
    achieved: chars ? stats.characters : stats.words,
    target: targetWords ? (chars ? targetWords * CJK_CHARS_PER_WORD : targetWords) : null,
  };
}

/** Busy label while the draft streams: "Drafting… ~N / ~M words". */
export function draftProgressLabel(m: DraftMeasure, lang: UiLang): string {
  const vars = { n: m.achieved, target: m.target ?? 0 };
  if (m.unit === "characters") {
    return m.target === null
      ? translateWith("Drafting… {n} characters", lang, vars)
      : translateWith("Drafting… {n} / ~{target} characters", lang, vars);
  }
  return m.target === null
    ? translateWith("Drafting… ~{n} words", lang, vars)
    : translateWith("Drafting… ~{n} / ~{target} words", lang, vars);
}

/** Completion message: paragraphs, achieved length and (if any) the target. */
export function draftDoneMessage(m: DraftMeasure, paragraphs: number, lang: UiLang): string {
  const vars = { p: paragraphs, n: m.achieved, target: m.target ?? 0 };
  if (m.unit === "characters") {
    return m.target === null
      ? translateWith("Draft created — {p} paragraphs, {n} characters.", lang, vars)
      : translateWith("Draft created — {p} paragraphs, {n} characters (target ~{target}).", lang, vars);
  }
  return m.target === null
    ? translateWith("Draft created — {p} paragraphs, ~{n} words.", lang, vars)
    : translateWith("Draft created — {p} paragraphs, ~{n} words (target ~{target}).", lang, vars);
}

/** A warning for the persistent report when the draft missed its target by
 *  more than DRAFT_LENGTH_TOLERANCE; null when within range or untargeted. */
export function draftLengthWarning(m: DraftMeasure, lang: UiLang): string | null {
  if (m.target === null) return null;
  if (Math.abs(m.achieved - m.target) <= m.target * DRAFT_LENGTH_TOLERANCE) return null;
  const vars = { n: m.achieved, target: m.target };
  return m.unit === "characters"
    ? translateWith("The draft is {n} characters, outside ±20% of the ~{target}-character target.", lang, vars)
    : translateWith("The draft is ~{n} words, outside ±20% of the ~{target}-word target.", lang, vars);
}
