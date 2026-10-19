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
 *   Markdown source does, by more than view switches rewrite. Examples (not
 *   a complete list, review follow-up C20): frontmatter, blank-line runs,
 *   trailing spaces, indentation, line endings, heading or fence marker style
 *   — bytes the chunk parse drops, kept only in `markdownSource`. Optional so
 *   older literals type-check; absent = false.
 *
 * Contract (one equality notion, CLAUDE.md invariant 3): `hasChanges(summary)`
 * is false exactly when `sameAsSaved(saved, current)` — the predicate the
 * store's dirty flag uses — is true, for any non-null baseline. diff.test.ts
 * and store.test.ts assert it. The store derives `dirty` from it on every
 * edit, undo, redo and save, but not on a view switch (BUG-019a), so 未保存 +
 * 保存時と同じ内容 shows for an unsaved baseline (MISS-12) and, for a saved
 * one, only after a switch stores a blank tab's "\n" (healthLabels.ts lists
 * the known cases).
 *
 * Not compared: `mode` (a view switch is view-only, BUG-019a), source
 * rewrites a view switch alone produces (see viewSwitchSources), and the
 * export-only `metadata.renderedImage` (set only on fileActions' export
 * clone; no store action writes it). `metadata.contentHistory` IS compared
 * (QA 20261003 follow-up): .aix persists it (models.rs content_history), so
 * an AI version swapped back to the saved text is still unsaved data. An
 * empty list equals an absent one — Rust never writes an empty list.
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

/**
 * Chunk-metadata entries that never decide "changed": the export-only
 * `renderedImage`, and an empty `contentHistory` (Rust's
 * `skip_serializing_if = "Vec::is_empty"` writes it exactly like an absent
 * one, while the store writes `[]` on some paths). A non-empty
 * contentHistory counts (QA 20261003 follow-up).
 */
function skipMetadataEntry(key: string, value: unknown): boolean {
  return key === "renderedImage" || (key === "contentHistory" && Array.isArray(value) && value.length === 0);
}

/** Structural equality, independent of key order; `undefined` keys are absent. */
function sameValue(a: unknown, b: unknown, skip?: (key: string, value: unknown) => boolean): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = (r: Record<string, unknown>) =>
    Object.keys(r).filter((k) => r[k] !== undefined && !skip?.(k, r[k]));
  const ka = keys(ra);
  const kb = keys(rb);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameValue(ra[k], rb[k]));
}

/** Everything but the chunks, the title and the view-related fields. */
function otherFields(doc: Document): Record<string, unknown> {
  const { chunks: _c, title: _t, mode: _m, markdownSource: _s, ...rest } = doc;
  return rest;
}

/** A chunk's non-content data matches (order + metadata, minus skipMetadataEntry). */
function sameChunkData(a: Chunk, b: Chunk): boolean {
  return a.order === b.order && (a.metadata === b.metadata || sameValue(a.metadata, b.metadata, skipMetadataEntry));
}

/**
 * The sources a document with these chunks can reach from `source` by view
 * switches alone: entering Markdown mode stores `documentToMarkdown` of the
 * Editor/Slide view (setMode), leaving it keeps the source. So the chain is
 * `source`, then the chunks merged into it (serialized when it is missing or
 * blank), repeated until it stops changing — the merge is not always a fixed
 * point on the first pass (an empty slide heading serializes as "#" but
 * merges as "# "). Bounded at four steps. Pure; `source` undefined is a
 * document with no Markdown source yet.
 *
 * One step is cut (review follow-up C1, QA 20261003): a Markdown-mode doc
 * whose source is blank does not reach a NON-blank serialization (its
 * "# <title>\n"). It is written verbatim, so that text is bytes it would only
 * have after a view switch it has not had — counting it let a select-all
 * delete on a title-only .md, or "# <stem>⏎" typed into an empty one, read
 * clean. Kept: the untitled fresh-tab "" ↔ "\n" (the serialization is blank).
 * Known limit: an empty titled .md switched Editor → Markdown stores that
 * heading without an edit; it stays clean (setMode never sets dirty) while
 * the summary reports a source change.
 */
export function viewSwitchSources(doc: Document, source: string | undefined): (string | undefined)[] {
  const out: (string | undefined)[] = [source];
  const verbatim = (doc.mode ?? "editor") === "markdown";
  let cur = source;
  for (let i = 0; i < 4; i += 1) {
    const next = documentToMarkdown({ ...doc, mode: "editor", markdownSource: cur });
    if (out.includes(next)) break;
    if (verbatim && cur !== undefined && !cur.trim() && next.trim()) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/**
 * Whether the two sources differ by more than view switches can explain,
 * given that chunks and title already match (so either side's chunks stand
 * for both). A missing source counts as its derived serialization; a mode
 * switch — which only ever stores that derived text — never counts. Any other
 * byte difference does: for example a frontmatter-only, blank-line, spacing,
 * line-ending, or heading/fence marker edit stays dirty.
 *
 * Two directions: the saved bytes reach the current ones (the user switched
 * views since the save), or the current doc reaches the saved bytes (an undo
 * back to a snapshot from before a switch). The second is skipped when the
 * current doc is in Markdown mode (review follow-up C1, QA 20261003): its
 * source is what a save writes, verbatim, so a switch it has not had cannot
 * excuse its bytes.
 */
function sourceDiffers(saved: Document, current: Document): boolean {
  const a = saved.markdownSource;
  const b = current.markdownSource;
  if (a === b) return false; // same bytes: at most the view differs
  // Each side's own chunks stand in (they match here); cached per document,
  // so the store's check and the health bar's summary of the same doc — and
  // every check against the same saved baseline — merge at most once.
  if (reachOf(saved).includes(b)) return false;
  if ((current.mode ?? "editor") === "markdown") return true;
  return !reachOf(current).includes(a);
}

// Documents are immutable in the store, so a per-object cache stays valid.
const reachCache = new WeakMap<Document, (string | undefined)[]>();
function reachOf(doc: Document): (string | undefined)[] {
  let reach = reachCache.get(doc);
  if (!reach) {
    reach = viewSwitchSources(doc, doc.markdownSource);
    reachCache.set(doc, reach);
  }
  return reach;
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
 * typing path costs a few reference/string checks; Markdown is serialized only
 * once chunks, title and other fields all match AND the raw sources differ.
 */
export function sameAsSaved(saved: Document | null, current: Document): boolean {
  if (saved === current) return true;
  if (!saved) return false;
  if (saved.title !== current.title) return false;
  const sc = saved.chunks;
  const cc = current.chunks;
  if (sc !== cc) {
    if (sc.length !== cc.length) return false;
    // Ids and text first (a typed character fails here), metadata after.
    for (let i = 0; i < sc.length; i += 1) {
      if (sc[i] !== cc[i] && (sc[i].id !== cc[i].id || sc[i].content !== cc[i].content)) return false;
    }
    for (let i = 0; i < sc.length; i += 1) {
      if (sc[i] !== cc[i] && !sameChunkData(sc[i], cc[i])) return false;
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
