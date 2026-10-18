// Minimal word-level diff (LCS) used to highlight what an AI edit changed.
// Tokens keep their trailing whitespace so re-joining reproduces the text.

import { documentToMarkdown } from "./markdown";
import type { Chunk, Document } from "./types";

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

function tokenize(s: string): string[] {
  // Prefer locale-aware word segmentation so CJK prose (no inter-word spaces)
  // diffs at word granularity. The old whitespace split collapsed an entire
  // Japanese/Chinese paragraph into ONE token, so a one-character edit rendered
  // as a full-paragraph delete+insert — visually useless for the primary
  // (Japanese-academic) audience. Intl.Segmenter covers every character, so
  // concatenating the tokens still reproduces the original text exactly.
  type Segmenter = {
    segment(input: string): Iterable<{ segment: string }>;
  };
  type SegmenterCtor = new (
    locale?: string,
    options?: { granularity?: "grapheme" | "word" | "sentence" }
  ) => Segmenter;
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (Seg) {
    try {
      const seg = new Seg(undefined, { granularity: "word" });
      return Array.from(seg.segment(s), (x) => x.segment);
    } catch {
      // fall through to the regex tokenizer
    }
  }
  // Fallback: split into words + following whitespace, keeping punctuation.
  return s.match(/\S+\s*|\s+/g) ?? [];
}

/** Compute a word-level diff between `before` and `after`. */
export function wordDiff(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", a[i]);
      i++;
    } else {
      push("insert", b[j]);
      j++;
    }
  }
  while (i < n) push("delete", a[i++]);
  while (j < m) push("insert", b[j++]);
  return ops;
}

/** True when the two strings differ at all (cheap guard before diffing). */
export function changed(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

/** One paragraph that differs between the saved baseline and the current doc. */
export interface ChangedChunk {
  id: string;
  before: string;
  after: string;
}

/**
 * Document-wide diff (item 1-2): compares `saved.chunks` vs `current.chunks`
 * BY CHUNK ID — content never decides identity — so an edited paragraph is
 * always "changed", never a remove+add pair (chunks keep their id across
 * edits; only structural ops like delete/duplicate change the id set). Pure
 * function, no side effects, so it is fully unit-testable and safe to call
 * from a render path (memoize the CALLER if it's hot). Content is compared
 * exactly, whitespace included (BUG-001/005, QA 20261003): a trailing double
 * space is a Markdown hard break, and the dirty flag counts it, so this view
 * must too. (`changed()` still trims — it only drives the AI-edit highlight.)
 */
export interface DocumentDiffResult {
  added: Chunk[];
  removed: Chunk[];
  changed: ChangedChunk[];
}

export function documentDiff(
  saved: Document | null,
  current: Document
): DocumentDiffResult {
  const savedChunks = saved?.chunks ?? [];
  const savedById = new Map(savedChunks.map((c) => [c.id, c]));
  const currentIds = new Set(current.chunks.map((c) => c.id));

  const added: Chunk[] = [];
  const changedList: ChangedChunk[] = [];
  // Preserve CURRENT's chunk order for stable UI ordering.
  for (const chunk of current.chunks) {
    const before = savedById.get(chunk.id);
    if (!before) {
      added.push(chunk);
    } else if (before.content !== chunk.content) {
      changedList.push({ id: chunk.id, before: before.content, after: chunk.content });
    }
  }
  const removed = savedChunks.filter((c) => !currentIds.has(c.id));

  return { added, removed, changed: changedList };
}

/**
 * What kind of change separates the current document from the saved baseline
 * (BUG-015b): the health-bar label and DiffPanel use this so a dirty document
 * never reads "No changes since last save".
 *
 * - `paragraphs`: added + removed + changed chunks (documentDiff, exact text).
 * - `titleChanged`: the title differs (exactly); with no baseline, a non-empty
 *   title counts.
 * - `otherChanged`: the stored analysis or any other document field, the order
 *   of the paragraphs both versions share, or any chunk's `order` or metadata
 *   (notes, comments, links, summaries, confirmed, layout…) differs.
 * - `sourceChanged` (BUG-005, QA 20261003): nothing above differs but the
 *   Markdown text does — frontmatter, blank-line runs, line endings, an H1's
 *   marker style live only in `markdownSource`. Optional so older literals
 *   type-check; absent means false.
 *
 * Contract (one equality notion, CLAUDE.md invariant 3): `hasChanges(summary)`
 * is false exactly when `sameAsSaved(saved, current)` — the predicate the
 * store's dirty flag uses — is true, for any non-null baseline. diff.test.ts
 * and store.test.ts assert it, so the UI can never show 未保存 + 保存時と同じ内容
 * for a clean baseline (only for an unsaved one, MISS-12).
 *
 * Not compared: `mode` (a view switch is view-only, BUG-019a), the raw
 * `markdownSource` beyond the Markdown text it yields (see sourceDiffers),
 * `metadata.contentHistory` and the export-only `metadata.renderedImage`.
 * Unchanged chunks keep their object identity through store edits, so the
 * reference checks make the common case cheap; still memoize the caller.
 */
export interface ChangeSummary {
  paragraphs: number;
  titleChanged: boolean;
  otherChanged: boolean;
  sourceChanged?: boolean;
}

/** Whether a summary reports any change at all. */
export function hasChanges(s: ChangeSummary): boolean {
  return s.paragraphs > 0 || s.titleChanged || s.otherChanged || !!s.sourceChanged;
}

const IGNORED_METADATA_KEYS = new Set(["contentHistory", "renderedImage"]);

/** Structural equality, independent of key order; `undefined` keys are absent. */
function sameValue(a: unknown, b: unknown, ignore?: Set<string>): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = (r: Record<string, unknown>) =>
    Object.keys(r).filter((k) => r[k] !== undefined && !ignore?.has(k));
  const ka = keys(ra);
  const kb = keys(rb);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameValue(ra[k], rb[k]));
}

/** Everything but the chunks, the title and the view-related fields. */
function otherFields(doc: Document): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { chunks: _c, title: _t, mode: _m, markdownSource: _s, ...rest } = doc;
  return rest;
}

/** A chunk's non-content data matches (order + metadata, minus the ignored keys). */
function sameChunkData(a: Chunk, b: Chunk): boolean {
  return a.order === b.order && (a.metadata === b.metadata || sameValue(a.metadata, b.metadata, IGNORED_METADATA_KEYS));
}

// documentToMarkdown per document object: documents are immutable in the
// store, so the saved baseline is serialized at most once (typing path).
const markdownCache = new WeakMap<Document, string>();
function markdownOf(doc: Document): string {
  let md = markdownCache.get(doc);
  if (md === undefined) {
    md = documentToMarkdown(doc);
    markdownCache.set(doc, md);
  }
  return md;
}

/**
 * Whether the Markdown text the two documents stand for differs, given that
 * their chunks and titles already match. The text is `documentToMarkdown`:
 * the source verbatim in Markdown mode, else the chunks merged into the
 * baseline (or serialized when there is none), so a missing source equals the
 * derived serialization and a mode switch — which only ever stores that text
 * — never counts. Two whitespace-only texts are the same: an all-blank
 * document has no content, and Editor/Slide mode reads every blank source as
 * the serialized chunks ("" in Markdown mode, "\n" after a switch). Any
 * other byte difference counts, so a frontmatter-only or whitespace-only edit
 * of a non-blank source stays dirty.
 */
function sourceDiffers(saved: Document, current: Document): boolean {
  if (
    saved.markdownSource === current.markdownSource &&
    (saved.mode === "markdown") === (current.mode === "markdown")
  ) {
    return false; // same text read the same way, over matching chunks
  }
  const a = markdownOf(saved);
  const b = markdownOf(current);
  return a !== b && !(a.trim() === "" && b.trim() === "");
}

/**
 * THE "current content equals the saved baseline" predicate (BUG-001/005/007,
 * QA 20261003). The store derives `dirty` from it after every edit, undo,
 * redo and save; changeSummary reports a change exactly when it is false.
 *
 * Conservative by construction: it may answer "different" for equal data
 * (e.g. a merge baseline rewritten to the same text), never "same" for
 * different data — a false "same" would let a tab close without the save
 * prompt. A null baseline is never the same. Identity shortcuts first, so the
 * typing path costs a few reference checks; Markdown is serialized only once
 * chunks, title and other fields all match.
 */
export function sameAsSaved(saved: Document | null, current: Document): boolean {
  if (saved === current) return true;
  if (!saved) return false;
  if (saved.title !== current.title) return false;
  // Both read their source verbatim: a differing source is a change (cheap
  // early exit for Markdown typing, before comparing re-parsed chunks).
  if (
    saved.mode === "markdown" &&
    current.mode === "markdown" &&
    saved.markdownSource !== undefined &&
    current.markdownSource !== undefined &&
    saved.markdownSource !== current.markdownSource &&
    !(saved.markdownSource.trim() === "" && current.markdownSource.trim() === "")
  ) {
    return false;
  }
  if (saved.chunks !== current.chunks) {
    if (saved.chunks.length !== current.chunks.length) return false;
    for (let i = 0; i < saved.chunks.length; i += 1) {
      const a = saved.chunks[i];
      const b = current.chunks[i];
      if (a === b) continue;
      if (a.id !== b.id || a.content !== b.content || !sameChunkData(a, b)) return false;
    }
  }
  if (!sameValue(otherFields(saved), otherFields(current))) return false;
  return !sourceDiffers(saved, current);
}

export function changeSummary(saved: Document | null, current: Document): ChangeSummary {
  if (saved === current) return { paragraphs: 0, titleChanged: false, otherChanged: false, sourceChanged: false };
  const d = documentDiff(saved, current);
  const paragraphs = d.added.length + d.removed.length + d.changed.length;
  const titleChanged = (saved?.title ?? "") !== current.title;
  if (!saved) {
    return { paragraphs, titleChanged, otherChanged: current.analysis !== undefined, sourceChanged: false };
  }

  let otherChanged = !sameValue(otherFields(saved), otherFields(current));
  if (!otherChanged && saved.chunks !== current.chunks) {
    const savedById = new Map(saved.chunks.map((c) => [c.id, c]));
    const currentIds = new Set(current.chunks.map((c) => c.id));
    const sharedSaved = saved.chunks.filter((c) => currentIds.has(c.id)).map((c) => c.id);
    const sharedCurrent = current.chunks.filter((c) => savedById.has(c.id)).map((c) => c.id);
    // A length mismatch here means a duplicated id — never "no change".
    otherChanged =
      sharedSaved.length !== sharedCurrent.length || sharedSaved.some((id, i) => id !== sharedCurrent[i]);
    for (const chunk of current.chunks) {
      if (otherChanged) break;
      const before = savedById.get(chunk.id);
      if (!before || before === chunk) continue;
      otherChanged = !sameChunkData(before, chunk);
    }
  }
  const sourceChanged =
    paragraphs === 0 && !titleChanged && !otherChanged && sourceDiffers(saved, current);
  return { paragraphs, titleChanged, otherChanged, sourceChanged };
}
