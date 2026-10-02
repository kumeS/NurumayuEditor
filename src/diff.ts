// Minimal word-level diff (LCS) used to highlight what an AI edit changed.
// Tokens keep their trailing whitespace so re-joining reproduces the text.

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
 * from a render path (memoize the CALLER if it's hot).
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
    } else if (changed(before.content, chunk.content)) {
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
 * - `paragraphs`: added + removed + changed chunks (documentDiff, content only).
 * - `titleChanged`: the title differs (trimmed); with no baseline, a non-empty
 *   title counts.
 * - `otherChanged`: the stored analysis, the order of the paragraphs both
 *   versions share, or any chunk's metadata (comments, links, summaries,
 *   confirmed, layout…) differs.
 *
 * Not compared, because changing them never marks the document dirty: `mode`
 * and `markdownSource` (a mode switch and its baseline rewrite are view-only),
 * `metadata.contentHistory` and the export-only `metadata.renderedImage`.
 * Unchanged chunks keep their object identity through store edits, so the
 * reference check makes the common case cheap; still memoize the caller.
 */
export interface ChangeSummary {
  paragraphs: number;
  titleChanged: boolean;
  otherChanged: boolean;
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

export function changeSummary(saved: Document | null, current: Document): ChangeSummary {
  if (saved === current) return { paragraphs: 0, titleChanged: false, otherChanged: false };
  const d = documentDiff(saved, current);
  const paragraphs = d.added.length + d.removed.length + d.changed.length;
  const titleChanged = (saved?.title ?? "").trim() !== current.title.trim();
  if (!saved) {
    return { paragraphs, titleChanged, otherChanged: current.analysis !== undefined };
  }

  let otherChanged = !sameValue(saved.analysis, current.analysis);
  if (!otherChanged && saved.chunks !== current.chunks) {
    const savedById = new Map(saved.chunks.map((c) => [c.id, c]));
    const currentIds = new Set(current.chunks.map((c) => c.id));
    const sharedSaved = saved.chunks.filter((c) => currentIds.has(c.id)).map((c) => c.id);
    const sharedCurrent = current.chunks.filter((c) => savedById.has(c.id)).map((c) => c.id);
    otherChanged = sharedSaved.some((id, i) => id !== sharedCurrent[i]);
    for (const chunk of current.chunks) {
      if (otherChanged) break;
      const before = savedById.get(chunk.id);
      if (!before || before === chunk || before.metadata === chunk.metadata) continue;
      otherChanged = !sameValue(before.metadata, chunk.metadata, IGNORED_METADATA_KEYS);
    }
  }
  return { paragraphs, titleChanged, otherChanged };
}
