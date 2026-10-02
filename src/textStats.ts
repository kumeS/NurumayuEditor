// Document length statistics: the ONE counter and the ONE unit rule behind
// every length label (the status bar, and the Draft target/progress/report
// labels via draftLength.ts, which uses `lengthUnitFor` +
// `CJK_CHARS_PER_WORD`). Pure — no store,
// no Tauri — so it runs in the plain-Node test env.
//
// Constraints this module keeps:
// - Only text and heading chunks count (mirrors charLimitWarnings): Mermaid
//   source, image paths and data URLs are never "prose".
// - Characters are Unicode code points (surrogate pairs count once), excluding
//   whitespace (ASCII and ideographic U+3000 spaces, newlines).
// - The script mix (which unit a label uses) is judged over letters only, so
//   Markdown syntax, file paths, digits and punctuation never tip a Japanese
//   document into "words".
// - Words are Intl.Segmenter word-like segments, per paragraph. Without a
//   usable segmenter the documented fallback is whitespace-delimited words
//   plus one per CJK letter — an over-count for CJK, which is why CJK-
//   dominant documents are labelled in characters, not words.
// Known limit: word segmentation depends on the platform ICU data, so word
// counts can differ slightly between WebKit and Node for ambiguous input.

import type { Chunk } from "./types";

/**
 * Approximate number of Japanese characters that corresponds to one English
 * word when a length target is expressed in words (e.g. a "~300 words" Draft
 * target ≈ 600 文字). A heuristic, not a measurement. Mirrored by
 * `JA_CHARS_PER_WORD` in src-tauri/src/ai.rs (contract-tested).
 */
export const CJK_CHARS_PER_WORD = 2;

export interface TextStats {
  /** Non-whitespace code points in text/heading chunks. */
  characters: number;
  /** Letters (Unicode \p{L}) of any script — the base of the script-mix rule. */
  letters: number;
  /** The subset of `letters` in Han/Hiragana/Katakana/Hangul (incl. ー and 々; not 。、). */
  cjkCharacters: number;
  /** Word-like segments (see module doc for the fallback rule). */
  words: number;
}

/** The subset of `Intl.Segmenter` this module needs (injectable for tests). */
export type WordSegmenter = {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

export type LengthUnit = "characters" | "words";

// Script_Extensions so the prolonged sound mark (ー) and 々 — Script=Common
// but used only in CJK text — are CJK letters. CJK_SCRIPT also matches CJK
// punctuation (。、「」); the fallback word heuristic uses it as a separator.
const CJK_SCRIPT = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;
const CJK_SCRIPT_GLOBAL = new RegExp(CJK_SCRIPT.source, "gu");
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;

function isCjkLetter(ch: string): boolean {
  return LETTER.test(ch) && CJK_SCRIPT.test(ch);
}

function defaultSegmenter(): WordSegmenter | null {
  type SegmenterCtor = new (locale?: string, options?: { granularity?: "word" }) => WordSegmenter;
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Seg) return null;
  try {
    return new Seg(undefined, { granularity: "word" });
  } catch {
    return null;
  }
}

function fallbackWords(text: string): number {
  let cjk = 0;
  for (const ch of text) if (isCjkLetter(ch)) cjk++;
  const other = text.replace(CJK_SCRIPT_GLOBAL, " ").split(/\s+/u).filter(Boolean).length;
  return cjk + other;
}

/**
 * Length statistics for a document's prose. `segmenter`: omit for the
 * platform `Intl.Segmenter`; pass `null` to force the fallback heuristic.
 */
export function documentTextStats(chunks: Chunk[], segmenter?: WordSegmenter | null): TextStats {
  const seg = segmenter === undefined ? defaultSegmenter() : segmenter;
  const stats: TextStats = { characters: 0, letters: 0, cjkCharacters: 0, words: 0 };
  for (const c of chunks) {
    if (c.metadata.chunkType !== "text" && c.metadata.chunkType !== "heading") continue;
    for (const ch of c.content) {
      if (WHITESPACE.test(ch)) continue;
      stats.characters++;
      if (!LETTER.test(ch)) continue;
      stats.letters++;
      if (CJK_SCRIPT.test(ch)) stats.cjkCharacters++;
    }
    if (seg) {
      for (const s of seg.segment(c.content)) if (s.isWordLike) stats.words++;
    } else {
      stats.words += fallbackWords(c.content);
    }
  }
  return stats;
}

/**
 * The unit a length should be shown in: characters when CJK makes up at least
 * half of the letters (Japanese/Chinese/Korean have no reliable word unit),
 * words otherwise (including a document with no letters).
 */
export function lengthUnitFor(stats: TextStats): LengthUnit {
  return stats.letters > 0 && stats.cjkCharacters * 2 >= stats.letters ? "characters" : "words";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function characterCount(stats: TextStats, lang: "en" | "ja"): string {
  return lang === "ja" ? `${stats.characters}文字` : plural(stats.characters, "character", "characters");
}

function wordCount(stats: TextStats, lang: "en" | "ja"): string {
  return lang === "ja" ? `約${stats.words}語` : `~${plural(stats.words, "word", "words")}`;
}

/** Status-bar label: paragraphs plus the length in `lengthUnitFor`'s unit. */
export function formatLengthLabel(stats: TextStats, paragraphs: number, lang: "en" | "ja"): string {
  const length = lengthUnitFor(stats) === "characters" ? characterCount(stats, lang) : wordCount(stats, lang);
  const paras = lang === "ja" ? `${paragraphs}段落` : plural(paragraphs, "paragraph", "paragraphs");
  return `${paras} · ${length}`;
}

/** Tooltip detail: always both numbers, whichever unit the label shows. */
export function formatLengthDetail(stats: TextStats, lang: "en" | "ja"): string {
  return `${characterCount(stats, lang)} · ${wordCount(stats, lang)}`;
}
