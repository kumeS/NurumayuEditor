// Find / Replace / Go to Line — pure core (BUG-010).
//
// Used by the docked find bar (components/FindBar.tsx), the chunk replace
// actions in store.ts and the CodeMirror replace in MarkdownEditor.tsx.
//
// Invariants (findReplace.test.ts):
// - The query is LITERAL: regex metacharacters are escaped, and replacement
//   text is inserted verbatim (`$&`, `$1` stay as typed).
// - Offsets are UTF-16 indices into the ORIGINAL text. Case-insensitive search
//   uses the RegExp `iu` flags rather than lower-casing, so characters whose
//   lower case changes length (Turkish 'İ') never shift later offsets.
// - Matches are non-overlapping, left to right; an empty query matches nothing.
// - Whole word applies only at query edges that are letters/digits of a
//   space-separated script (Latin, Cyrillic, Greek, digits, `_`). At a CJK
//   (Han / kana / Hangul) edge it is a no-op, because those scripts do not
//   separate words with spaces; CJK neighbours of a Latin word count as
//   boundaries ("これはcatです" matches whole-word "cat").
// - Replace All is ONE change list (`replacementChanges`): the store applies it
//   with `applyChanges`, CodeMirror dispatches the same list, so both produce
//   the same text.
// - A match that already reads the replacement is not a change
//   (`isNoOpChange`): `replacementChanges` / `replaceAll` drop it and do not
//   count it, so an all-identity Replace All changes nothing, adds no undo
//   step and reports 0 (C12, review follow-up, QA 20261003).
// - Chunk search covers text and heading chunks only (image paths and diagram
//   source are not prose). The document title is not searched.
// - Go to Line accepts integers 1..N only (`parseLineNumber`): out-of-range
//   and non-integer input is rejected, never clamped (BUG-004, QA 20261003).
// - A Replace All report is shown only while the searched text and the find
//   options (Match case, Whole word) are the ones it was made for
//   (`freshReplaceReport`, BUG-002 + C13, QA 20261003).
// Known limits: no regex mode and no search inside the document title; Slides
// mode find is planned (`findAvailability`).

import type { Chunk, DocMode } from "./types";

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** A match as a half-open UTF-16 range [from, to). */
export interface TextMatch {
  from: number;
  to: number;
}

/** One replacement edit; the same shape CodeMirror's `changes` accepts. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface ChunkMatch {
  chunkId: string;
  from: number;
  to: number;
  /** Offsets in the searchable chunks joined by one separator each — a single
   *  document-wide order for `nextMatch`. */
  docFrom: number;
  docTo: number;
}

// RegExp SyntaxCharacters only: in `u` mode any other escaped char ("\-") is
// a SyntaxError.
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const WORDISH = /[\p{L}\p{N}\p{M}_]/u;

/** A word character of a space-separated script (whole-word boundary test). */
function isSpacedWordChar(ch: string): boolean {
  return ch !== "" && WORDISH.test(ch) && !CJK.test(ch);
}

/** The full code point ending right before UTF-16 index `i` ("" at 0). */
function codePointBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

/** The full code point starting at UTF-16 index `i` ("" at the end). */
function codePointAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** All non-overlapping literal matches of `query` in `text`. */
export function findMatches(text: string, query: string, opts: FindOptions): TextMatch[] {
  if (!query || !text) return [];
  const re = new RegExp(query.replace(ESCAPE, "\\$&"), opts.caseSensitive ? "gu" : "giu");
  const checkStart = opts.wholeWord && isSpacedWordChar(codePointAt(query, 0));
  const checkEnd = opts.wholeWord && isSpacedWordChar(codePointBefore(query, query.length));
  const out: TextMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    const rejected =
      (checkStart && isSpacedWordChar(codePointBefore(text, from))) ||
      (checkEnd && isSpacedWordChar(codePointAt(text, to)));
    if (rejected) {
      // Retry one code point later, so a valid match overlapping this
      // rejected candidate is still found.
      re.lastIndex = from + Math.max(1, codePointAt(text, from).length);
      continue;
    }
    out.push({ from, to });
  }
  return out;
}

/** Whether `change` leaves `text` as it is: its insert equals the span it
 *  replaces (C12, review follow-up, QA 20261003). */
export function isNoOpChange(text: string, change: TextChange): boolean {
  return text.slice(change.from, change.to) === change.insert;
}

/** The edits Replace All makes: one per match that the replacement (inserted
 *  verbatim) actually changes. A match already reading the replacement is
 *  dropped, so it is neither dispatched nor counted (C12). */
export function replacementChanges(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions
): TextChange[] {
  return findMatches(text, query, opts)
    .map((m) => ({ from: m.from, to: m.to, insert: replacement }))
    .filter((c) => !isNoOpChange(text, c));
}

/** Apply non-overlapping, ascending changes to `text`. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

/** Replace every match; `count` is how many were changed (identity matches
 *  are not counted, see `replacementChanges`). */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions
): { output: string; count: number } {
  const changes = replacementChanges(text, query, replacement, opts);
  return { output: changes.length ? applyChanges(text, changes) : text, count: changes.length };
}

/**
 * Index of the match to go to from `caret`: "next" = first match starting at
 * or after it, "prev" = last match starting before it; both wrap around.
 * -1 when there are no matches.
 */
export function nextMatch(matches: readonly TextMatch[], caret: number, dir: "next" | "prev"): number {
  if (matches.length === 0) return -1;
  if (dir === "next") {
    const i = matches.findIndex((m) => m.from >= caret);
    return i === -1 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < caret) return i;
  return matches.length - 1;
}

/** Chunks find searches: prose only (text + heading). */
export function isSearchableChunk(chunk: Chunk): boolean {
  const type = chunk.metadata.chunkType;
  return type === "text" || type === "heading";
}

/** Matches across the searchable chunks, in document order. */
export function findInChunks(chunks: readonly Chunk[], query: string, opts: FindOptions): ChunkMatch[] {
  const out: ChunkMatch[] = [];
  let base = 0;
  for (const c of chunks) {
    if (!isSearchableChunk(c)) continue;
    for (const m of findMatches(c.content, query, opts)) {
      out.push({ chunkId: c.id, from: m.from, to: m.to, docFrom: base + m.from, docTo: base + m.to });
    }
    base += c.content.length + 1;
  }
  return out;
}

/** A caret inside chunk `chunkId` in the same document-wide offsets as
 *  `ChunkMatch.docFrom` (0 when the chunk is unknown). */
export function chunkDocOffset(chunks: readonly Chunk[], chunkId: string, offset: number): number {
  let base = 0;
  for (const c of chunks) {
    if (c.id === chunkId) {
      return isSearchableChunk(c) ? base + Math.max(0, Math.min(offset, c.content.length)) : base;
    }
    if (isSearchableChunk(c)) base += c.content.length + 1;
  }
  return 0;
}

/** The searchable chunks' text joined by one separator each: the text Editor
 *  mode searches, in the same offsets as `ChunkMatch.docFrom` / `docTo`. */
export function chunkSearchText(chunks: readonly Chunk[]): string {
  return chunks
    .filter(isSearchableChunk)
    .map((c) => c.content)
    .join("\n");
}

/** What the find bar says after Replace All, and the search it was made
 *  for: the searched text (BUG-002) and the find options (C13, review
 *  follow-up, QA 20261003). `count` is how many matches it changed. */
export interface ReplaceReport extends FindOptions {
  count: number;
  text: string;
}

/**
 * The report while the searched text and the find options are still the ones
 * it was made for, else null: once an undo, redo or edit changes the text, or
 * Match case / Whole word is toggled, "Replaced N." no longer describes the
 * live matches (freshness is checked where the report is used). The bar
 * stores the null, so a redo back to the same text does not revive it.
 */
export function freshReplaceReport(
  report: ReplaceReport | null,
  text: string,
  opts: FindOptions
): ReplaceReport | null {
  return report !== null &&
    report.text === text &&
    report.caseSensitive === opts.caseSensitive &&
    report.wholeWord === opts.wholeWord
    ? report
    : null;
}

/** Number of lines (a trailing newline starts a new, empty line). */
export function lineCount(source: string): number {
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

/** A Go to Line field value: a line in 1..total, or why it is not one. */
export type LineInput = { ok: true; line: number } | { ok: false; reason: "empty" | "invalid" | "range" };

/** Full-width digits ０–９ (what a Japanese IME types). */
const FULL_WIDTH_DIGIT = /[０-９]/g;

/**
 * Parse a Go to Line field (BUG-004, QA 20261003): full-width digits are
 * folded to ASCII (ux-a11y-i18n-7) and surrounding whitespace (U+3000
 * included) is trimmed; what is left must be ASCII digits only and name a
 * line in 1..total. Nothing is stripped or clamped: signs, decimals,
 * exponents and other numerals (①, ¹, 十五) are "invalid", 0 and total+1
 * are "range". Pure.
 */
export function parseLineNumber(value: string, total: number): LineInput {
  const s = value.replace(FULL_WIDTH_DIGIT, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  if (s === "") return { ok: false, reason: "empty" };
  if (!/^[0-9]+$/.test(s)) return { ok: false, reason: "invalid" };
  const line = Number(s);
  return line >= 1 && line <= total ? { ok: true, line } : { ok: false, reason: "range" };
}

/** Start offset of 1-based `line`, clamped to the document's lines (a
 *  safety net only: the bar validates with `parseLineNumber` first). */
export function lineStartOffset(source: string, line: number): number {
  const target = Number.isFinite(line) ? Math.min(Math.max(1, Math.floor(line)), lineCount(source)) : 1;
  let current = 1;
  for (let i = 0; i < source.length && current < target; i++) {
    if (source.charCodeAt(i) === 10) {
      current++;
      if (current === target) return i + 1;
    }
  }
  return 0;
}

/** Longest selection that prefills the query field. */
const SEED_MAX = 200;

/** The query to prefill from the editor's selection, or null to keep the old one. */
export function findSeed(selection: string): string | null {
  if (!selection || selection.length > SEED_MAX || /[\r\n]/.test(selection)) return null;
  return selection;
}

/**
 * Where the find bar works. Slides mode is "planned": its detached title and
 * body fields are not wired to the selection hand-off yet, so the bar says so
 * instead of searching text it cannot show.
 */
export function findAvailability(mode: DocMode | undefined): "available" | "planned" {
  return mode === "slide" ? "planned" : "available";
}
