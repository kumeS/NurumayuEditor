// Central application state (Zustand).
//
// Performance note (spec §4.1 / Phase 5): chunk mutations are immutable and
// preserve the object identity of *unchanged* chunks. Combined with per-chunk
// selectors in the components, editing one paragraph re-renders only that
// paragraph — not the whole document.

import { create } from "zustand";
import { PREVIEW_ZOOM_MAX, PREVIEW_ZOOM_MIN } from "./previewViewport";
import { documentToMarkdown, markdownToDocument, withMarkdownTitle } from "./markdown";
import { type FindOptions, isSearchableChunk, replaceAll } from "./findReplace";
import { groupSlides } from "./slides";
// i18n imports this module too; tNow only reads the store when CALLED (never
// at module init), so the cycle is safe.
import { tNow } from "./i18n";
import type {
  AnalysisResult,
  Chunk,
  ChunkType,
  DocMode,
  Document,
  PersistedTab,
  ReviewComment,
  Settings,
  SlideLayout,
} from "./types";

let idCounter = 0;
/**
 * Id generator for chunks/documents created on the frontend. Uses UUIDs so ids
 * match the Rust side (models.rs `new_id`) and stay stable across save/reload —
 * a single, reproducible addressing scheme for agents (T2/AX). Falls back to a
 * timestamp-counter scheme if `crypto.randomUUID` is unavailable.
 */
function localId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  idCounter += 1;
  return `c-${Date.now().toString(36)}-${idCounter}`;
}

function emptyChunk(order: number, type: ChunkType = "text"): Chunk {
  return {
    id: localId(),
    order,
    content: "",
    metadata: {
      chunkType: type,
      format: type === "diagram" ? "mermaid" : undefined,
      level: type === "heading" ? 2 : undefined,
      linkedChunks: [],
    },
  };
}

/** Reassign sequential `order` values after structural edits. */
function reindex(chunks: Chunk[]): Chunk[] {
  return chunks.map((c, i) => (c.order === i ? c : { ...c, order: i }));
}

/**
 * Hash a chunk's content for summary-freshness tracking (djb2 over the UTF-16
 * code units, kept unsigned, rendered as hex). Cheap, deterministic, and stable
 * across save/reload — good enough to detect "the text changed since this
 * summary was written"; not a cryptographic hash.
 */
export function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // h * 33 + c, unsigned 32-bit
  }
  return h.toString(16);
}

/**
 * Ids of chunks whose `metadata.summary` no longer matches their content —
 * i.e. the summary was written for an older version of the text (detected via
 * `summaryHash`). A summary WITHOUT a hash is treated as fresh: legacy docs
 * (summaries saved before hashing existed) must not trigger a surprise mass
 * re-summarization the first time an AI action runs.
 */
export function staleSummaryChunkIds(doc: Document): string[] {
  return doc.chunks
    .filter((c) => {
      if (!c.metadata.summary?.trim()) return false;
      const hash = c.metadata.summaryHash;
      if (!hash) return false; // legacy summary — treated fresh (see above)
      return hash !== hashContent(c.content);
    })
    .map((c) => c.id);
}

/**
 * Rebuild the relationship graph from persisted chunk metadata (spec §5
 * `linkedChunks` + `summary`) so a saved analysis survives reopen. Returns null
 * when the document carries no relationship data. Node labels/edge relations are
 * approximate (they aren't stored verbatim), but the structure and the
 * click-to-jump targets are exact.
 */
function rebuildAnalysis(doc: Document): AnalysisResult | null {
  // Heading chunks participate too (parity with the Rust analyzer, which now
  // emits heading nodes) — their labels come from the heading content.
  const graphChunks = doc.chunks.filter(
    (c) =>
      c.metadata.chunkType === "text" || c.metadata.chunkType === "heading"
  );
  // Only reconstruct when real relationships were persisted. A document that
  // merely has per-paragraph summaries (but was never analyzed) should not
  // resurrect a meaningless edge-less graph.
  const hasRelations = graphChunks.some(
    (c) => (c.metadata.linkedChunks?.length ?? 0) > 0
  );
  if (!hasRelations) return null;

  const ids = new Set(doc.chunks.map((c) => c.id));
  const firstWords = (s: string) =>
    s.trim().split(/\s+/).slice(0, 6).join(" ");
  const nodes: AnalysisResult["nodes"] = graphChunks.map((c) => {
    const summary = c.metadata.summary ?? "";
    return {
      id: c.id,
      label: firstWords(summary || c.content) || "·",
      summary,
      kind: "paragraph" as const,
    };
  });
  const edges: AnalysisResult["edges"] = [];
  for (const c of graphChunks) {
    for (const target of c.metadata.linkedChunks ?? []) {
      if (ids.has(target)) edges.push({ source: c.id, target, relation: "" });
    }
  }
  return { nodes, edges };
}

/**
 * Drop analysis nodes/edges that reference chunks no longer in the document
 * (A3). Cheap and deterministic — keeps the persisted graph from pointing at
 * deleted paragraphs after a structural edit. Sentence nodes survive iff their
 * owning paragraph does.
 */
export function pruneAnalysis(
  a: AnalysisResult | null | undefined,
  validIds: Set<string>
): AnalysisResult | null {
  if (!a) return null;
  const nodes = a.nodes.filter((n) =>
    n.kind === "sentence" ? !!n.parent && validIds.has(n.parent) : validIds.has(n.id)
  );
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = a.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );
  // Spread keeps non-structural fields (e.g. analyzedAt) intact through a prune.
  return { ...a, nodes, edges };
}

/**
 * Whether `ids` names ≥2 existing TEXT chunks that are strictly adjacent in
 * document order — the precondition for `mergeChunks` (and the SelectionBar's
 * Merge button enablement).
 */
export function canMergeChunks(doc: Document, ids: string[]): boolean {
  const idSet = new Set(ids);
  if (idSet.size < 2) return false;
  const indices: number[] = [];
  for (const id of idSet) {
    const idx = doc.chunks.findIndex((c) => c.id === id);
    if (idx < 0 || doc.chunks[idx].metadata.chunkType !== "text") return false;
    indices.push(idx);
  }
  indices.sort((a, b) => a - b);
  return indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
}

// CJK ranges for the merge separator: kana, Han (+ext A / compat), hangul,
// CJK punctuation and full-width forms — scripts that join without a space.
const CJK_RE =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;

/**
 * Separator for one merge boundary: nothing when either side is empty, when a
 * space would double up (either side already has boundary whitespace), or when
 * the joint is CJK↔CJK; a single space when the previous piece ends in ASCII
 * word/punctuation (Latin prose).
 */
function mergeSeparator(prev: string, next: string): string {
  if (!prev || !next) return "";
  const a = prev[prev.length - 1];
  const b = next[0];
  if (/\s/.test(a) || /\s/.test(b)) return ""; // never introduce double spaces
  if (CJK_RE.test(a) && CJK_RE.test(b)) return ""; // CJK joins tight
  if (/[\x21-\x7e]/.test(a)) return " "; // Latin prose boundary
  return "";
}

/**
 * True if a document's persisted graph references chunks it no longer contains
 * — i.e. the graph is structurally out of date (A3). Used by undo/redo to
 * recompute the staleness badge for a restored snapshot.
 */
function structurallyStale(doc: Document): boolean {
  const a = doc.analysis;
  if (!a) return false;
  const ids = new Set(doc.chunks.map((c) => c.id));
  return (
    a.nodes.some((n) => (n.kind === "sentence" ? !!n.parent && !ids.has(n.parent) : !ids.has(n.id))) ||
    a.edges.some((e) => !ids.has(e.source) || !ids.has(e.target))
  );
}

/**
 * Clamp/advance the presentation overlay's current slide index by `delta`
 * (item 1-3) — never below 0 or beyond `slideCount - 1`. Used for the bare
 * arrow-key/space next/previous navigation inside PresentationMode, extracted
 * as a pure function so the deck-bounds behaviour has a direct unit test
 * (empty deck / first slide / last slide) independent of any keyboard or
 * rendering integration.
 */
export function clampPresentIndex(
  current: number,
  delta: number,
  slideCount: number
): number {
  if (slideCount <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), slideCount - 1);
}

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

/**
 * Identity of the document an async operation started on (BUG-001b). Tab ids
 * alone are not document identity (openInTab reuses a pristine tab) and chunk
 * ids are persisted UUIDs (a reopened .aix has the same ids), so every load
 * gets a fresh `docNonce`. `opId` is a per-session counter for correlation
 * logging only; ownership compares `tabId` + `docNonce`.
 */
export interface OpTicket {
  opId: number;
  tabId: string;
  docNonce: number;
}

/**
 * What a ghost-text suggestion was generated for (BUG-001a/d): the chunk, the
 * exact text it continues (`prefix`), and the tab + document load. A
 * suggestion is only stored, and only accepted, while all four still match.
 */
export interface GhostContext {
  chunkId: string;
  prefix: string;
  tabId: string;
  docNonce: number;
}
export interface GhostSuggestion extends GhostContext {
  text: string;
}

/**
 * One AI-operation correlation record (MISS-01). Ids and machine-readable
 * reason codes ONLY — never document content, prompts, or keys. Kept in a
 * bounded in-memory ring buffer (AI_OP_LOG_MAX) so it is visible in release
 * builds; nothing persists it. Shown read-only in NetworkPanel ("Recent AI
 * operations") with a Copy-as-JSON-lines button (aiOpLogToJsonLines).
 */
export type AiOpPhase = "start" | "commit" | "discard";
export interface AiOpLogEntry {
  ts: number;
  opId: number;
  phase: AiOpPhase;
  action: string;
  tabId: string;
  docNonce: number;
  chunkId?: string;
  reason?: string;
}
export const AI_OP_LOG_MAX = 200;

/**
 * Idle gap (ms) after which the next keystroke in the same paragraph starts a
 * new undo step (BUG-002). The window slides: each edit refreshes it, so
 * continuous typing stays one step. Read via Date.now() (fake-timer friendly).
 */
export const UNDO_IDLE_MS = 1500;

/** What the docked find bar shows (BUG-010): plain find, find + replace, or
 *  a line-number field (Markdown source). */
export type FindMode = "find" | "replace" | "line";

/**
 * The find bar's UI state. Ephemeral and app-level (like the panel flags): it
 * is never persisted, not part of the document or TabSnapshot, and never
 * dirties or adds history. `current` is the index of the selected match in
 * the bar's live match list (-1 = none yet); `hit` is that match in Editor
 * mode (ChunkView highlights and selects it); `focusNonce` bumps on every
 * open so the bar re-focuses its field even when it is already open.
 */
/** A Settings landing spot (ux-a11y-i18n-5). */
export type SettingsFocus = "model-catalog";

export interface FindState {
  open: boolean;
  mode: FindMode;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  current: number;
  hit: { chunkId: string; from: number; to: number } | null;
  focusNonce: number;
  /** True right after Replace / Replace All until a find field (query or
   *  replacement) is edited, or the bar opens/closes: ⌘Z in the bar then
   *  undoes the DOCUMENT (ux-a11y-i18n-1, see shortcuts.ts). */
  replacePending: boolean;
}

export const FIND_INITIAL: FindState = {
  open: false,
  mode: "find",
  query: "",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  current: -1,
  hit: null,
  focusNonce: 0,
  replacePending: false,
};

// Globally monotonic, never reset: a nonce is never reused across loads,
// tabs, or a tab id that openInTab recycles.
let docNonceCounter = 0;
function nextDocNonce(): number {
  docNonceCounter += 1;
  return docNonceCounter;
}
let opCounter = 0;

/**
 * Whether two documents hold the same content (MISS-12: undo back to the
 * saved state is clean). Reference equality first (the common case: undo
 * restores the exact snapshot object), then a structural fallback that
 * reuses unchanged chunk identity and JSON-compares the rest. Conservative:
 * it may report "different" for equal data with reordered keys (→ dirty,
 * safe), never "same" for different data.
 */
function sameDocument(a: Document, b: Document | null): boolean {
  if (a === b) return true;
  if (!b || a.chunks.length !== b.chunks.length) return false;
  const { chunks: ac, ...aRest } = a;
  const { chunks: bc, ...bRest } = b;
  if (JSON.stringify(aRest) !== JSON.stringify(bRest)) return false;
  return ac.every((c, i) => c === bc[i] || JSON.stringify(c) === JSON.stringify(bc[i]));
}

/**
 * Per-document state captured when a tab is backgrounded. The ACTIVE tab's
 * state lives in the top-level fields below; inactive tabs are stored as these
 * snapshots. This set must mirror EXACTLY the per-document fields (so nothing
 * leaks across tabs — e.g. filePath, or a save would overwrite another tab's file).
 */
interface TabSnapshot {
  doc: Document;
  filePath: string | null;
  dirty: boolean;
  // The document as it was at the last save/open (item 1-2): the baseline
  // documentDiff() compares `doc` against to drive the "changes since last
  // save" view. null only transiently before the very first load (never
  // exposed to the UI, since loadDocument/newTab always set it in the SAME
  // action that clears dirty).
  savedDoc: Document | null;
  // True when `savedDoc` needs no saving (on disk, or a fresh blank doc);
  // false for AI drafts, repaired-on-load files and dirty restored tabs, so
  // undoing back to such a baseline stays dirty (MISS-12).
  savedDocIsClean: boolean;
  // Document-load identity (BUG-001b) — restored, never bumped, on switch.
  docNonce: number;
  past: Document[];
  future: Document[];
  analysis: AnalysisResult | null;
  analysisStale: boolean;
  focusedChunkId: string | null;
  lastEditChunkId: string | null;
  // Time of the last coalesced paragraph edit (BUG-002 idle boundary).
  lastEditAt: number;
  // In-flight operation state is PER-TAB (B3) — captured here so it doesn't leak
  // onto another tab on switch (a false "Drafting…" spinner) and a background
  // op's completion doesn't clear the foreground tab's state.
  globalBusy: string | null;
  streamingChunkId: string | null;
  streamingText: string;
  busyChunks: Record<string, boolean>;
}

function snapshotActive(s: AppState): TabSnapshot {
  return {
    doc: s.doc,
    filePath: s.filePath,
    dirty: s.dirty,
    savedDoc: s.savedDoc,
    savedDocIsClean: s.savedDocIsClean,
    docNonce: s.docNonce,
    past: s.past,
    future: s.future,
    analysis: s.analysis,
    analysisStale: s.analysisStale,
    focusedChunkId: s.focusedChunkId,
    lastEditChunkId: s.lastEditChunkId,
    lastEditAt: s.lastEditAt,
    globalBusy: s.globalBusy,
    streamingChunkId: s.streamingChunkId,
    streamingText: s.streamingText,
    busyChunks: s.busyChunks,
  };
}

function applySnapshot(snap: TabSnapshot) {
  return {
    doc: snap.doc,
    filePath: snap.filePath,
    dirty: snap.dirty,
    savedDoc: snap.savedDoc,
    savedDocIsClean: snap.savedDocIsClean,
    docNonce: snap.docNonce,
    past: snap.past,
    future: snap.future,
    analysis: snap.analysis,
    analysisStale: snap.analysisStale,
    focusedChunkId: snap.focusedChunkId,
    lastEditChunkId: snap.lastEditChunkId,
    lastEditAt: snap.lastEditAt,
    globalBusy: snap.globalBusy,
    streamingChunkId: snap.streamingChunkId,
    streamingText: snap.streamingText,
    busyChunks: snap.busyChunks,
    flashChunkId: null,
    flashChunkIds: [],
    selectedChunkIds: [],
    lastAiEditChunkId: null,
    // A ghost suggestion is scoped to a specific chunk in the OUTGOING
    // document — meaningless (and potentially confusing) on the incoming tab.
    ghostSuggestion: null,
    // The queue indexes the OUTGOING document — meaningless for the incoming tab.
    speechQueue: [],
  };
}

const INITIAL_TAB_ID = "tab-1";

interface AppState {
  // ----- active tab's document state (the live fields) -----
  doc: Document;
  filePath: string | null; // current native (.aix) file, if any
  dirty: boolean;
  // The document as it was at the last save/open — baseline for documentDiff()
  // (item 1-2). Invariant: dirty:false implies `doc` matches `savedDoc`.
  // Load/save/markClean set both in the SAME action; undo/redo never touch
  // `savedDoc` and derive `dirty` from it plus `savedDocIsClean` (MISS-12).
  savedDoc: Document | null;
  // See TabSnapshot.savedDocIsClean — undo/redo recompute `dirty` from it.
  savedDocIsClean: boolean;
  // Document-load identity (BUG-001b): fresh on loadDocument/newTab/
  // hydrateSession/commitDraftToTab/last-tab replacement; restored on switch.
  docNonce: number;

  // ----- tabs -----
  tabOrder: string[];
  activeTabId: string;
  inactiveTabs: Record<string, TabSnapshot>;

  settings: Settings | null;
  hasApiKey: boolean;

  focusedChunkId: string | null;
  flashChunkId: string | null; // transient highlight target (network-graph jump)
  flashChunkIds: string[]; // transient multi-highlight (e.g. both endpoints of a graph edge)
  selectedChunkIds: string[]; // multi-select (e.g. for image generation)
  busyChunks: Record<string, boolean>;
  globalBusy: string | null; // label of an in-flight global operation
  // Live streaming of a per-chunk AI action (translate/proofread/…): the chunk's
  // real content is untouched until the stream finalises.
  streamingChunkId: string | null;
  streamingText: string;
  // Ghost-text inline completion (開発.txt Stage 2, item 2-4): a transient
  // overlay suggestion — NEVER written into `chunk.content` until explicitly
  // accepted via `acceptGhostSuggestion` (its own undo step). `requestId` is a
  // monotonic per-store counter (never reset): the component that fired the
  // completion request captures the id it was issued and only applies a
  // result if it still matches `ghostRequestId`, which is how a superseded
  // (stale) in-flight request's late result is discarded (last-request-wins).
  // Every document transition (load/new/switch/close/hydrate/draft commit)
  // bumps it too (BUG-001d), and the stored context (tab, load, prefix) must
  // still match both when it is set and when it is accepted.
  ghostSuggestion: GhostSuggestion | null;
  ghostRequestId: number;
  // The configured text model the provider reported unusable (BUG-013c) —
  // drives the persistent HealthBar "Model unavailable: {model}" chip with an
  // Open Settings button (guarded by healthBarWiring.test.ts "HealthBar
  // model-unavailable chip"). Cleared by setSettings when the active model
  // changes.
  aiModelIssue: { model: string } | null;
  // AI operation correlation log (MISS-01) — see AiOpLogEntry. Global, not
  // per-tab (each entry names its tab + load).
  aiOpLog: AiOpLogEntry[];
  // Read-aloud (UI3): the single chunk currently being spoken, plus the backend
  // utterance id so a stale `speech-done` event can't clear a newer playback.
  speakingChunkId: string | null;
  speakingUtterance: number | null;
  // Multi-chunk read-aloud (item 14): chunk ids still to be spoken AFTER the
  // current utterance. Transient and NOT part of TabSnapshot — reading is only
  // meaningful for the visible document, so it is cleared on tab
  // switch/close/load alongside the other transient per-view state.
  speechQueue: string[];

  analysis: AnalysisResult | null;
  // True when the persisted graph no longer matches the edited document (A3) —
  // drives the NetworkPanel "out of date" badge.
  analysisStale: boolean;
  networkOpen: boolean;
  // Folder tree sidebar (left dock, general-purpose file explorer — not
  // per-tab, not per-mode). Defaults OPEN (unlike networkOpen/reviewPanelOpen)
  // since it's meant to be a standard, always-available feature rather than
  // something the user opts into per session. `folderRoot` is the last chosen
  // directory; neither field persists across launches (same as networkOpen).
  folderTreeOpen: boolean;
  folderRoot: string | null;
  // Markdown preview zoom (1 = 100%). A reading-comfort control, so it is
  // app-level rather than per-tab, and — like the panel flags — deliberately
  // not persisted across launches.
  markdownZoom: number;
  // Sideways shift of the preview's reading column, in screen px (0 = centred).
  // App-level and not persisted, like the zoom. The view clamps it to keep part
  // of the column on screen (previewViewport.ts).
  markdownOffsetX: number;
  // Review comments panel (right dock, like networkOpen — not per-tab). The
  // target chunk is the one the panel's "add comment" composer points at (set
  // when the panel is opened from a chunk's gutter comment button).
  reviewPanelOpen: boolean;
  reviewTargetChunkId: string | null;
  // "Changes since last save" popover (item 1-2), toggled from the HealthBar
  // indicator or the command palette — not per-tab (like networkOpen), since
  // it's a transient view over whichever tab is active.
  diffPanelOpen: boolean;
  // Window-filling presentation overlay (item 1-3; native full screen is
  // planned): ephemeral, UI-only state — NOT
  // a third `doc.mode` value (that's persisted editor/slide document state).
  // Not per-tab (like networkOpen/diffPanelOpen): it's a transient view over
  // whichever tab is active, opened from the Slide editor's Present button or
  // the command palette.
  presentationOpen: boolean;
  settingsOpen: boolean;
  /** Where an open Settings dialog should land (ux-a11y-i18n-5). */
  settingsFocus: SettingsFocus | null;
  draftOpen: boolean;
  helpOpen: boolean;
  // Command palette (提案1 — ⌘K).
  paletteOpen: boolean;
  // Docked find bar (BUG-010) — see FindState.
  find: FindState;
  // The most recent export's warning report (提案2): exports used to surface
  // warnings only as a 3.5s toast; the health bar keeps them reviewable.
  lastExportReport: { format: string; warnings: string[]; at: number } | null;

  toasts: Toast[];

  // history (undo/redo) — snapshots of the document
  past: Document[];
  future: Document[];
  lastEditChunkId: string | null;
  // Time (Date.now) of the last coalesced paragraph edit — UNDO_IDLE_MS rule.
  lastEditAt: number;
  // The chunk most recently replaced by an AI action — drives the transient
  // "what changed" diff highlight after proofread/translate/etc.
  lastAiEditChunkId: string | null;
}

interface AppActions {
  loadDocument: (
    doc: Document,
    filePath?: string | null,
    opts?: { dirty?: boolean }
  ) => void;
  setStreamingDocument: (doc: Document) => void;
  /** Route a finished Draft document to the tab that started it, active or
   *  background (BUG-005b): doc + baseline replaced, dirty, fresh history,
   *  new docNonce. Returns false (no-op) when that tab was closed or another
   *  document was loaded into it since `docNonce` was captured. */
  commitDraftToTab: (tabId: string, docNonce: number, document: Document) => boolean;
  newTab: (mode?: DocMode) => void;
  switchTab: (id: string) => void;
  /** Closing the LAST tab replaces it with a fresh untitled tab under a new
   *  id (BUG-018), so late ops addressed to the old id become no-ops. */
  closeTab: (id: string) => void;
  hydrateSession: (tabs: PersistedTab[], activeTabId: string) => void;
  /** Snapshot the active tab + document load an async op starts on. */
  captureOp: () => OpTicket;
  /** True while that same tab is active AND still shows that same load. */
  ownsOp: (op: OpTicket) => boolean;
  setTitle: (title: string) => void;
  setMode: (mode: DocMode) => void;
  /** `newUndoStep`: start a fresh undo step (a preview edit/split) instead of
   *  merging into the current Markdown typing session. */
  setMarkdownSource: (source: string, options?: { newUndoStep?: boolean }) => void;

  /** Live typing. Coalesces into the current undo step unless `newUndoStep`,
   *  a different chunk, or an idle gap > UNDO_IDLE_MS since the last edit.
   *  `composing` marks an IME composition continuation: the idle rule is
   *  skipped for it (a pause while choosing a candidate never splits). */
  updateChunkContent: (
    id: string,
    content: string,
    options?: { newUndoStep?: boolean; composing?: boolean }
  ) => void;
  replaceChunkContent: (id: string, content: string) => void; // undoable (AI results)
  selectChunkVersion: (id: string, value: string) => void; // swap to a saved version
  dismissAiEdit: () => void; // clear the transient diff highlight
  setChunkSummary: (id: string, summary: string) => void;
  setChunkType: (id: string, type: ChunkType) => void;
  setHeadingLevel: (id: string, level: number) => void;
  convertToHeading: (id: string, level: number, content: string) => void;

  addChunkAfter: (id: string | null, type?: ChunkType) => string;
  insertDiagramAfter: (id: string | null, code: string) => string;
  insertImageAfter: (id: string | null, url: string, prompt: string) => string;
  // Insert a user-supplied local image (file picker / drag-drop / paste) as an
  // image chunk. Unlike `insertImageAfter` (AI-generated), this never sets
  // `imagePrompt` — a locally inserted image has no generation prompt to
  // "regenerate" from — and marks `imageSource: "local"` so the UI can badge
  // it distinctly from an AI-generated image.
  insertLocalImageAfter: (id: string | null, dataUrl: string, fileName: string) => string;
  splitChunk: (id: string, caret: number) => string | null;
  deleteChunk: (id: string) => void;
  mergeWithPrevious: (id: string) => string | null;
  // Merge ≥2 adjacent text chunks into the first (item 3/4). Returns the merged
  // chunk's id, or null when the selection fails `canMergeChunks`.
  mergeChunks: (ids: string[]) => string | null;
  moveChunk: (id: string, dir: -1 | 1) => void;
  // Slide-level structural ops (slide editor).
  setChunkOrder: (orderedIds: string[]) => void;
  deleteChunks: (ids: string[]) => void;
  duplicateChunksAfter: (ids: string[]) => string[];
  setChunkLayout: (id: string, layout: SlideLayout | null) => void;
  setChunkSubtitle: (id: string, subtitle: boolean) => void;
  // Personal RAG (開発.txt Stage 3, item 3-1) auto-accumulation (Q11/Q16): mark/
  // unmark a chunk's content as vetted enough to feed into the user's personal
  // library — see fileActions.ts's save flow for what a confirmed chunk does.
  setChunkConfirmed: (id: string, confirmed: boolean) => void;
  setSlideBody: (leadId: string, body: string[] | null) => void;
  setChunkNotes: (id: string, notes: string) => void;
  replaceChunksWithTexts: (ids: string[], texts: string[]) => void;
  splitSlideBefore: (chunkId: string) => string | null;
  mergeSlideIntoPrevious: (headingChunkId: string) => string | null;

  setFocused: (id: string | null) => void;
  flashChunk: (id: string) => void;
  flashChunks: (ids: string[]) => void;
  toggleSelectChunk: (id: string) => void;
  clearSelection: () => void;
  // In-flight op setters take an optional `tabId` so a background operation
  // updates ITS OWN tab, not whatever tab is active when it resolves (B3).
  setBusyChunk: (id: string, busy: boolean, tabId?: string) => void;
  setGlobalBusy: (label: string | null, tabId?: string) => void;
  beginChunkStream: (id: string, tabId?: string) => void;
  updateChunkStream: (text: string, tabId?: string) => void;
  endChunkStream: (tabId?: string) => void;
  // Ghost-text (開発.txt Stage 2, item 2-4). `startGhostRequest` bumps and
  // returns the new request id BEFORE any async call is made, so the caller
  // can guard its own `on_delta`/resolution against being superseded.
  startGhostRequest: () => number;
  /** Store a suggestion for `ctx`. Ignored unless `requestId` is current, the
   *  context's tab + load are active, and the chunk's text still equals
   *  `ctx.prefix`. The legacy chunk-id form records the CURRENT tab, load and
   *  chunk text as the context. */
  setGhostSuggestion: (ctx: GhostContext | string, text: string, requestId: number) => void;
  /** Commit the visible suggestion into `chunkId` as its own undo step.
   *  Returns false (and clears it) unless chunk, tab, load and prefix all
   *  still match — the caller then lets the key fall through. */
  acceptGhostSuggestion: (chunkId: string) => boolean;
  clearGhostSuggestion: () => void;
  // Read-aloud lifecycle (UI3).
  beginSpeaking: (chunkId: string, utterance: number) => void;
  endSpeaking: (utterance?: number) => void;
  // Multi-chunk read-aloud queue (item 14). `shiftSpeechQueue` pops the head
  // (null when empty) — the api call itself lives in aiActions so these pure
  // mechanics stay testable.
  setSpeechQueue: (ids: string[]) => void;
  shiftSpeechQueue: () => string | null;

  /** Also clears `aiModelIssue` when `settings.model` changes. */
  setSettings: (settings: Settings) => void;
  setAiModelIssue: (issue: { model: string } | null) => void;
  /** Append to the bounded AI op log. Only the whitelisted AiOpLogEntry
   *  fields are copied (never spread), and `ts` is stamped here. */
  logAiOp: (entry: Omit<AiOpLogEntry, "ts">) => void;
  // Blindspot QA v1 (project.md Q13): on the very first launch (settings say
  // the example hasn't been shown yet, AND the active tab is still the
  // pristine blank doc — a real user hasn't typed a title or made a tab dirty
  // in the meantime), replace the blank first document with the worked
  // example. Returns true when it fired (the caller — App.tsx's settings-load
  // effect — is responsible for persisting `hasSeenWelcomeExample: true` via
  // api.saveSettings so this is a one-time effect); false when either guard
  // failed, in which case the caller must leave settings untouched.
  loadWelcomeExampleIfFirstRun: (settings: Settings) => boolean;
  setHasApiKey: (has: boolean) => void;
  /** Open Settings; "model-catalog" also opens the text-model catalog and
   *  focuses its Fetch button (palette "Browse OpenRouter models…"). Any
   *  other argument (e.g. a click event from onClick={openSettings}) is a
   *  plain open. */
  openSettings: (focus?: SettingsFocus | unknown) => void;
  closeSettings: () => void;
  openDraft: () => void;
  closeDraft: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  togglePalette: (open?: boolean) => void;
  /** Open the find bar in `mode`; a non-null `seed` (the editor selection)
   *  replaces the query. Resets `current` and bumps `focusNonce`. */
  openFind: (mode: FindMode, seed?: string | null) => void;
  closeFind: () => void;
  setFind: (patch: Partial<Omit<FindState, "open" | "mode" | "focusNonce">>) => void;
  /** Replace every match in the text/heading chunks as ONE undo step (marks
   *  the graph stale). Returns the count; 0 = nothing changed, no step. */
  replaceAllInChunks: (query: string, replacement: string, opts: FindOptions) => number;
  /** Replace [from, to) of one text/heading chunk as its own undo step.
   *  False (no change) for an unknown chunk or an out-of-range span. */
  replaceMatchInChunk: (chunkId: string, from: number, to: number, replacement: string) => boolean;
  /** Markdown mode: Replace All on the source as its own undo step, through
   *  setMarkdownSource(…, {newUndoStep}) so the merge baseline is kept.
   *  Used when the CodeMirror source view is not mounted. Returns the count. */
  replaceAllInMarkdown: (query: string, replacement: string, opts: FindOptions) => number;
  setLastExportReport: (format: string, warnings: string[]) => void;

  /** Persist an analysis. `sent` is the document the analysis was computed
   *  from (state-async-4): summaries are hashed against the text actually
   *  analyzed, and the graph stays stale if the text moved on meanwhile.
   *  Omitted → the current document (no async gap). */
  applyAnalysis: (result: AnalysisResult, sent?: Document) => void;
  toggleNetwork: (open?: boolean) => void;
  toggleReviewPanel: (open?: boolean) => void;
  toggleFolderTree: (open?: boolean) => void;
  setFolderRoot: (path: string | null) => void;
  setMarkdownZoom: (zoom: number) => void;
  setMarkdownOffsetX: (offset: number) => void;
  setReviewTarget: (id: string | null) => void;
  toggleDiffPanel: (open?: boolean) => void;
  openPresentation: () => void;
  closePresentation: () => void;

  // Review comments (per-chunk, persisted in metadata.comments). All undoable;
  // comments never invalidate the relationship graph (marksStale:false).
  addComment: (
    chunkId: string,
    text: string,
    author?: "user" | "ai",
    kind?: string
  ) => string | null;
  updateComment: (chunkId: string, commentId: string, text: string) => void;
  deleteComment: (chunkId: string, commentId: string) => void;
  toggleCommentResolved: (chunkId: string, commentId: string) => void;
  clearAiComments: (kind?: string) => void;

  notify: (message: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;

  undo: () => void;
  redo: () => void;

  // `savedDocument` is the EXACT document that was just written to disk —
  // callers MUST pass the snapshot they captured before the (async) write, not
  // rely on this reading "whatever doc is live right now". Save IPC calls are
  // awaited without blocking the editor, so the live doc can advance (another
  // keystroke) while the write is in flight; reading `get().doc` here would
  // silently promote that unsaved keystroke into the baseline (dirty:false
  // AND savedDoc pointing past what's actually on disk — the two are supposed
  // to be inseparable, item 1-2). Defaults to the current doc ONLY for callers
  // with no async gap between capturing and calling (e.g. tests). It also
  // marks the baseline as saved (`savedDocIsClean`) and ends the current
  // typing session, so undo can land exactly on the saved state (MISS-12).
  // This is the synchronous, active-tab form (no async gap; used by tests). The
  // save paths (saveNative/saveNativeAs) route through `markTabClean` instead,
  // which pins the mark to the tab + load the save started on and keeps
  // `dirty` true when the live doc moved past what was written.
  markClean: (filePath?: string | null, savedDocument?: Document) => void;
  /**
   * The routed form of markClean for an async save (state-async-3): marks the
   * tab `tabId` — active or backgrounded — clean against `savedDocument`, but
   * only while that tab still holds the load `docNonce` the save started on.
   * `dirty` stays true when the live doc moved past what was written (a
   * keystroke during the write). `filePath` undefined keeps the tab's path.
   * Returns false (and changes nothing) when the tab is gone or reloaded.
   */
  markTabClean: (
    tabId: string,
    docNonce: number,
    filePath: string | undefined,
    savedDocument: Document
  ) => boolean;
}

const MAX_HISTORY = 100;
/** Max saved per-chunk content versions (text revisions / image URLs). */
const VERSION_LIMIT = 20;
let toastCounter = 0;

function makeInitialDoc(mode: DocMode = "editor"): Document {
  return {
    id: localId(),
    // Empty title: the editor shows a grayed placeholder until the user types.
    title: "",
    mode,
    // A slide deck starts with one slide (a heading = the first slide's title);
    // an editor doc starts with one empty paragraph.
    chunks: [emptyChunk(0, mode === "slide" ? "heading" : "text")],
    markdownSource: mode === "markdown" ? "" : undefined,
  };
}

/**
 * The full per-view state of a brand-new blank tab — shared by newTab and
 * the last-tab replacement in closeTab (BUG-018) so the two can't drift.
 * Excludes tab bookkeeping (tabOrder/activeTabId/inactiveTabs) and the ghost
 * reset, which needs the current ghostRequestId (see `ghostReset`).
 */
function freshTabFields(mode: DocMode): Partial<AppState> {
  const fresh = makeInitialDoc(mode);
  return {
    doc: fresh,
    filePath: null,
    dirty: false,
    // A fresh blank tab's baseline is itself (item 1-2) and needs no saving.
    savedDoc: fresh,
    savedDocIsClean: true,
    docNonce: nextDocNonce(),
    past: [],
    future: [],
    analysis: null,
    analysisStale: false,
    focusedChunkId: fresh.chunks[0]?.id ?? null,
    lastEditChunkId: null,
    lastEditAt: 0,
    lastAiEditChunkId: null,
    flashChunkId: null,
    flashChunkIds: [],
    speechQueue: [],
    selectedChunkIds: [],
    // A fresh tab starts with no in-flight operations (B3).
    globalBusy: null,
    streamingChunkId: null,
    streamingText: "",
    busyChunks: {},
  };
}

/**
 * Invalidate any visible or in-flight ghost suggestion (BUG-001d): null it AND
 * bump the request id, so a late delta from before a document transition
 * can't resurrect a suggestion — reopened files share chunk ids.
 */
function ghostReset(s: AppState): Pick<AppState, "ghostSuggestion" | "ghostRequestId"> {
  return { ghostSuggestion: null, ghostRequestId: s.ghostRequestId + 1 };
}

// A tiny inline chart, encoded as an SVG data URL — no bundled asset file, no
// network fetch, just a few hundred bytes of markup. Stands in for "a plot you
// made this week" in the welcome example below (Q13's own-figure feature).
const WELCOME_EXAMPLE_PLOT_DATA_URL =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">' +
      '<rect width="320" height="200" fill="#ffffff"/>' +
      '<rect x="0.5" y="0.5" width="319" height="199" fill="none" stroke="#d0d0d0"/>' +
      '<line x1="40" y1="20" x2="40" y2="170" stroke="#888" stroke-width="1"/>' +
      '<line x1="40" y1="170" x2="300" y2="170" stroke="#888" stroke-width="1"/>' +
      '<polyline points="40,150 80,120 120,130 160,90 200,95 240,60 280,50" ' +
      'fill="none" stroke="#2563eb" stroke-width="2.5"/>' +
      '<circle cx="40" cy="150" r="3" fill="#2563eb"/>' +
      '<circle cx="80" cy="120" r="3" fill="#2563eb"/>' +
      '<circle cx="120" cy="130" r="3" fill="#2563eb"/>' +
      '<circle cx="160" cy="90" r="3" fill="#2563eb"/>' +
      '<circle cx="200" cy="95" r="3" fill="#2563eb"/>' +
      '<circle cx="240" cy="60" r="3" fill="#2563eb"/>' +
      '<circle cx="280" cy="50" r="3" fill="#2563eb"/>' +
      '<text x="44" y="34" font-family="sans-serif" font-size="12" fill="#333">' +
      "baseline noise (example)</text></svg>"
  );

/**
 * Blindspot QA v1 (project.md Q13): the one-time first-run worked example,
 * shown instead of a blank document so a brand-new user sees the weekly loop
 * (progress note → slides → own figure) before hitting the "add your API key"
 * wall. Pure data construction — no I/O — so `loadWelcomeExampleIfFirstRun`
 * below only has to decide WHEN to call this, and every branch stays testable
 * without mocking Tauri.
 *
 * Chunk shape:
 *   0. heading — names what this doc is and doubles as the slide title.
 *   1-3. text — a short progress-note voice (generic, not domain-specific).
 *   4. image — a small bundled placeholder chart, `imageSource: "local"`
 *      (mirrors the shape `insertLocalImageAfter` produces), captioned as
 *      "this week's plot" to demonstrate the own-figures feature.
 * The heading explicitly says this doc IS the slides too, pointing at the
 * Editor/Slides toggle.
 */
export function makeWelcomeExampleDoc(): Document {
  const heading: Chunk = {
    id: localId(),
    order: 0,
    content: "Week of — lab progress note",
    metadata: { chunkType: "heading", level: 1, linkedChunks: [] },
  };
  const intro: Chunk = {
    id: localId(),
    order: 1,
    content:
      "This is both your document and your slides — flip to Slides (top toolbar) " +
      "to see this exact content presented as a deck, no separate file to keep in sync.",
    metadata: { chunkType: "text", linkedChunks: [] },
  };
  const progress: Chunk = {
    id: localId(),
    order: 2,
    content:
      "This week I re-ran the calibration with the new buffer and got a cleaner " +
      "baseline — noise dropped enough that the next dataset should be usable " +
      "without extra smoothing.",
    metadata: { chunkType: "text", linkedChunks: [] },
  };
  const nextSteps: Chunk = {
    id: localId(),
    order: 3,
    content:
      "Next week: repeat the run twice more to check it wasn't a one-off, then " +
      "start drafting the method section while the details are still fresh.",
    metadata: { chunkType: "text", linkedChunks: [] },
  };
  const plot: Chunk = {
    id: localId(),
    order: 4,
    content: WELCOME_EXAMPLE_PLOT_DATA_URL,
    metadata: {
      chunkType: "image",
      summary: "this week's plot",
      imageSource: "local",
      linkedChunks: [],
      contentHistory: [],
    },
  };
  return {
    id: localId(),
    title: "Weekly progress note (example)",
    mode: "editor",
    chunks: [heading, intro, progress, nextSteps, plot],
  };
}

export const useStore = create<AppState & AppActions>((set, get) => {
  /**
   * Apply a structural/undoable mutation, snapshotting history first. By default
   * it also marks the relationship graph stale (A3); pure metadata edits
   * (layout, heading level, summary) pass `{ marksStale: false }` so they don't
   * trip the "out of date" badge.
   */
  const commit = (
    producer: (doc: Document) => Document,
    opts?: { marksStale?: boolean }
  ) => {
    set((state) => {
      const snapshot = state.doc;
      const next = producer(snapshot);
      const past = [...state.past, snapshot].slice(-MAX_HISTORY);
      return {
        doc: next,
        past,
        future: [],
        dirty: true,
        lastEditChunkId: null,
        analysisStale: (opts?.marksStale ?? true) ? true : state.analysisStale,
      };
    });
  };

  /**
   * Route an in-flight-op patch to the tab that OWNS the op (B3). For the active
   * tab it patches the top-level fields; for a background tab it patches that
   * tab's snapshot; if the tab was closed mid-op it is a no-op (no phantom).
   */
  const routeTabPatch = (tabId: string, patch: Partial<TabSnapshot>) =>
    set((s) => {
      if (tabId === s.activeTabId) return patch;
      const snap = s.inactiveTabs[tabId];
      if (!snap) return {};
      return { inactiveTabs: { ...s.inactiveTabs, [tabId]: { ...snap, ...patch } } };
    });

  const mapChunks = (doc: Document, fn: (chunks: Chunk[]) => Chunk[]): Document => {
    // markdownSource stays as the merge baseline (BUG-019b): documentToMarkdown
    // re-serializes only the chunks whose type/level/content changed, so
    // metadata-only commits (notes, layout, ...) never touch the Markdown.
    const next = { ...doc, chunks: fn(doc.chunks) };
    // Markdown mode reads markdownSource verbatim, so fold the edit in now.
    if (doc.mode === "markdown" && doc.markdownSource !== undefined) {
      next.markdownSource = documentToMarkdown({ ...next, mode: "editor" });
    }
    return next;
  };

  const initialDoc = makeInitialDoc();
  return {
    doc: initialDoc,
    filePath: null,
    dirty: false,
    // A brand-new blank tab's baseline is itself — no changes yet (item 1-2).
    savedDoc: initialDoc,
    savedDocIsClean: true,
    docNonce: nextDocNonce(),
    tabOrder: [INITIAL_TAB_ID],
    activeTabId: INITIAL_TAB_ID,
    inactiveTabs: {},
    settings: null,
    hasApiKey: false,
    focusedChunkId: null,
    flashChunkId: null,
    flashChunkIds: [],
    selectedChunkIds: [],
    busyChunks: {},
    globalBusy: null,
    streamingChunkId: null,
    streamingText: "",
    ghostSuggestion: null,
    ghostRequestId: 0,
    aiModelIssue: null,
    aiOpLog: [],
    speakingChunkId: null,
    speakingUtterance: null,
    speechQueue: [],
    analysis: null,
    analysisStale: false,
    networkOpen: false,
    folderTreeOpen: true,
    folderRoot: null,
    markdownZoom: 1,
    markdownOffsetX: 0,
    reviewPanelOpen: false,
    reviewTargetChunkId: null,
    diffPanelOpen: false,
    presentationOpen: false,
    settingsOpen: false,
    settingsFocus: null,
    draftOpen: false,
    helpOpen: false,
    paletteOpen: false,
    find: { ...FIND_INITIAL },
    lastExportReport: null,
    toasts: [],
    past: [],
    future: [],
    lastEditChunkId: null,
    lastEditAt: 0,
    lastAiEditChunkId: null,

    loadDocument: (doc, filePath = null, opts) =>
      set((s) => ({
        doc,
        filePath,
        // B2: drafted/imported docs have no backing file and are unsaved, so they
        // must be dirty — otherwise the tab/quit guards treat irreproducible AI
        // drafts as "clean" and discard them silently.
        dirty: opts?.dirty ?? false,
        // The just-opened/imported document IS the new baseline (item 1-2) even
        // when it's dirty (e.g. a repaired-on-load file, or an AI draft with no
        // backing file yet) — "since last save" reads as "since this doc showed
        // up", not "since an unreachable on-disk state".
        savedDoc: doc,
        // …but only a clean load is a baseline that needs no saving (MISS-12).
        savedDocIsClean: !(opts?.dirty ?? false),
        // A new document identity, even in the same tab (BUG-001b).
        docNonce: nextDocNonce(),
        past: [],
        future: [],
        // Prefer the persisted full graph (paragraph + sentence nodes); fall back
        // to reconstructing a paragraph-only graph from older linkedChunks docs.
        analysis: doc.analysis ?? rebuildAnalysis(doc),
        analysisStale: false,
        focusedChunkId: doc.chunks[0]?.id ?? null,
        lastEditChunkId: null,
        lastEditAt: 0,
        lastAiEditChunkId: null,
        selectedChunkIds: [],
        ...ghostReset(s),
      })),

    // Live streaming snapshot (Draft): replace the document only — no history,
    // no focus churn. Chunks carry stable position ids so React reconciles in
    // place. A streamed partial draft is irreproducible AI output, so the tab
    // is dirty from the first update (BUG-005b) — a failed/abandoned stream
    // still triggers the discard guard. loadDocument()/commitDraftToTab()
    // finalise the stream.
    setStreamingDocument: (doc) => set({ doc, dirty: true }),

    commitDraftToTab: (tabId, docNonce, document) => {
      const s = get();
      const fields = {
        doc: document,
        savedDoc: document,
        savedDocIsClean: false, // B2: an AI draft has no backing file
        dirty: true,
        docNonce: nextDocNonce(),
        past: [] as Document[],
        future: [] as Document[],
        analysis: document.analysis ?? rebuildAnalysis(document),
        analysisStale: false,
        focusedChunkId: document.chunks[0]?.id ?? null,
        lastEditChunkId: null,
        lastEditAt: 0,
      };
      if (tabId === s.activeTabId) {
        if (s.docNonce !== docNonce) return false;
        set({ ...fields, lastAiEditChunkId: null, selectedChunkIds: [], ...ghostReset(s) });
        return true;
      }
      const snap = s.inactiveTabs[tabId];
      if (!snap || snap.docNonce !== docNonce) return false;
      set({ inactiveTabs: { ...s.inactiveTabs, [tabId]: { ...snap, ...fields } } });
      return true;
    },

    // ----- tabs: active tab lives in top-level fields; others as snapshots -----
    newTab: (mode = "editor") =>
      set((s) => {
        const id = localId();
        return {
          inactiveTabs: { ...s.inactiveTabs, [s.activeTabId]: snapshotActive(s) },
          tabOrder: [...s.tabOrder, id],
          activeTabId: id,
          ...freshTabFields(mode),
          ...ghostReset(s),
        };
      }),

    switchTab: (id) =>
      set((s) => {
        if (id === s.activeTabId) return {};
        const target = s.inactiveTabs[id];
        if (!target) return {};
        const inactiveTabs = {
          ...s.inactiveTabs,
          [s.activeTabId]: snapshotActive(s),
        };
        delete inactiveTabs[id];
        return { activeTabId: id, inactiveTabs, ...applySnapshot(target), ...ghostReset(s) };
      }),

    closeTab: (id) =>
      set((s) => {
        if (!s.tabOrder.includes(id)) return {};
        if (s.tabOrder.length <= 1) {
          // Always keep one tab open — by REPLACING the last one (BUG-018) with
          // a fresh untitled tab under a NEW id: late ops routed to the old id
          // (routeTabPatch) or owned by its load (ownsOp) become no-ops.
          const newId = localId();
          return {
            tabOrder: [newId],
            activeTabId: newId,
            inactiveTabs: {},
            ...freshTabFields("editor"),
            ...ghostReset(s),
          };
        }
        const idx = s.tabOrder.indexOf(id);
        const order = s.tabOrder.filter((t) => t !== id);
        if (id !== s.activeTabId) {
          const inactiveTabs = { ...s.inactiveTabs };
          delete inactiveTabs[id];
          return { tabOrder: order, inactiveTabs };
        }
        // Closing the active tab: activate a neighbour (its snapshot).
        const neighbourId = order[Math.min(idx, order.length - 1)];
        const target = s.inactiveTabs[neighbourId];
        const inactiveTabs = { ...s.inactiveTabs };
        delete inactiveTabs[neighbourId];
        return {
          tabOrder: order,
          activeTabId: neighbourId,
          inactiveTabs,
          // applySnapshot also resets speechQueue / ghostSuggestion /
          // lastAiEditChunkId; ghostReset additionally retires in-flight ghost
          // requests (BUG-001d).
          ...(target ? applySnapshot(target) : {}),
          ...ghostReset(s),
        };
      }),

    // Restore a saved multi-tab session (A2). Cannot reuse loadDocument (which
    // collapses to a single tab) — rebuilds the active fields + every background
    // tab's snapshot from the persisted set.
    hydrateSession: (tabs, activeTabId) =>
      set((s) => {
        const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
        if (!active) return {};
        const inactiveTabs: Record<string, TabSnapshot> = {};
        for (const t of tabs) {
          if (t.id === active.id) continue;
          inactiveTabs[t.id] = {
            doc: t.doc,
            filePath: t.filePath,
            dirty: t.dirty,
            // PersistedTab carries no baseline (item 1-2 predates session
            // persistence) — treat the restored doc as its own baseline, same
            // as any other freshly-loaded document. A dirty restored tab's
            // baseline is NOT on disk, so undo can't make it clean (MISS-12).
            savedDoc: t.doc,
            savedDocIsClean: !t.dirty,
            docNonce: nextDocNonce(),
            past: [],
            future: [],
            analysis: t.doc.analysis ?? rebuildAnalysis(t.doc),
            analysisStale: false,
            focusedChunkId: t.doc.chunks[0]?.id ?? null,
            lastEditChunkId: null,
            lastEditAt: 0,
            globalBusy: null,
            streamingChunkId: null,
            streamingText: "",
            busyChunks: {},
          };
        }
        return {
          tabOrder: tabs.map((t) => t.id),
          activeTabId: active.id,
          inactiveTabs,
          doc: active.doc,
          filePath: active.filePath,
          dirty: active.dirty,
          savedDoc: active.doc,
          savedDocIsClean: !active.dirty,
          docNonce: nextDocNonce(),
          past: [],
          future: [],
          analysis: active.doc.analysis ?? rebuildAnalysis(active.doc),
          analysisStale: false,
          focusedChunkId: active.doc.chunks[0]?.id ?? null,
          lastEditChunkId: null,
          lastEditAt: 0,
          lastAiEditChunkId: null,
          flashChunkId: null,
          flashChunkIds: [],
          speechQueue: [],
          selectedChunkIds: [],
          globalBusy: null,
          streamingChunkId: null,
          streamingText: "",
          busyChunks: {},
          ...ghostReset(s),
        };
      }),

    captureOp: () => {
      opCounter += 1;
      const s = get();
      return { opId: opCounter, tabId: s.activeTabId, docNonce: s.docNonce };
    },
    ownsOp: (op) => {
      const s = get();
      return s.activeTabId === op.tabId && s.docNonce === op.docNonce;
    },

    // The Markdown baseline keeps everything but its title line (BUG-019b).
    setTitle: (title) =>
      set((s) => ({
        doc: {
          ...s.doc,
          title,
          markdownSource:
            s.doc.markdownSource === undefined
              ? undefined
              : withMarkdownTitle(s.doc.markdownSource, title),
        },
        dirty: true,
      })),

    // Switch the current document between the "editor", "slide" and
    // "markdown" views. All render the SAME chunk model, so this only flips
    // how they're presented: it never sets `dirty` (BUG-019a). Entering
    // Markdown folds any chunk edits into the source via the merge
    // serializer, which returns the source byte-for-byte when nothing changed.
    setMode: (mode) => {
      const prevMode = get().doc.mode ?? "editor";
      if (prevMode === mode) return;
      set((s) => ({
        doc: {
          ...s.doc,
          mode,
          markdownSource:
            mode === "markdown"
              ? documentToMarkdown(s.doc)
              : s.doc.markdownSource,
        },
      }));
      // Slide→Editor didn't preserve your place (SlideEditor already derives
      // the selected slide from focusedChunkId on the way in, so Editor→Slide
      // was fine). flashChunk scrolls to and briefly highlights it, closing
      // the gap the same way graph/review navigation already does.
      if (prevMode === "slide" && mode === "editor" && get().focusedChunkId) {
        get().flashChunk(get().focusedChunkId as string);
      }
    },

    // CodeMirror owns character-level history while focused; the app-level
    // history coalesces one continuous Markdown typing session into one step,
    // matching the existing per-paragraph editor behavior.
    setMarkdownSource: (source, options) =>
      set((state) => {
        if (documentToMarkdown(state.doc) === source) return state;
        const marker = "__markdown__";
        const startNewUndoStep =
          options?.newUndoStep || state.past.length === 0 || state.lastEditChunkId !== marker;
        return {
          doc: markdownToDocument(state.doc, source),
          past: startNewUndoStep
            ? [...state.past, state.doc].slice(-MAX_HISTORY)
            : state.past,
          future: [],
          dirty: true,
          lastEditChunkId: options?.newUndoStep ? "__markdown_preview__" : marker,
          lastAiEditChunkId: null,
          analysis: null,
          analysisStale: true,
        };
      }),

    // Live typing: coalesce into one undo step per continuous edit session on a
    // chunk. Replaces only the edited chunk object (others keep identity).
    // A session ends (BUG-002) on a different chunk, an explicit `newUndoStep`
    // (selection replace / paste / discrete insert — see undoBoundary.ts), or
    // an idle gap > UNDO_IDLE_MS; `lastEditAt` refreshes on EVERY edit so the
    // idle window slides and continuous typing stays one step. An IME
    // composition continuation (`composing`) never splits on idle — the
    // unconverted kana must not become an undo state of its own.
    updateChunkContent: (id, content, options) =>
      set((state) => {
        const now = Date.now();
        const startNewUndoStep =
          !!options?.newUndoStep ||
          state.past.length === 0 ||
          state.lastEditChunkId !== id ||
          (!options?.composing && now - state.lastEditAt > UNDO_IDLE_MS);
        const past = startNewUndoStep
          ? [...state.past, state.doc].slice(-MAX_HISTORY)
          : state.past;
        return {
          doc: mapChunks(state.doc, (chunks) =>
            chunks.map((c) => (c.id === id ? { ...c, content } : c))
          ),
          past,
          future: [],
          dirty: true,
          lastEditChunkId: id,
          lastEditAt: now,
          // Manual typing dismisses any pending AI-change highlight.
          lastAiEditChunkId: null,
          analysisStale: true, // edited text → graph is out of date (A3)
        };
      }),

    // Replace a chunk's content (AI result). Saves the displaced value into the
    // chunk's `contentHistory` so the previous version can be swapped back, and
    // flags the chunk for the transient "what changed" highlight.
    replaceChunkContent: (id, content) =>
      set((state) => {
        const snapshot = state.doc;
        const next = mapChunks(snapshot, (chunks) =>
          chunks.map((c) => {
            if (c.id !== id) return c;
            const old = c.content;
            const hist = c.metadata.contentHistory ?? [];
            const nextHist =
              old.trim() && hist[hist.length - 1] !== old
                ? [...hist, old].slice(-VERSION_LIMIT)
                : hist;
            return {
              ...c,
              content,
              metadata: { ...c.metadata, contentHistory: nextHist },
            };
          })
        );
        const past = [...state.past, snapshot].slice(-MAX_HISTORY);
        return {
          doc: next,
          past,
          future: [],
          dirty: true,
          lastEditChunkId: null,
          lastAiEditChunkId: id,
          analysisStale: true, // AI-replaced text → graph is out of date (A3)
        };
      }),

    // Swap a chunk to a saved version, keeping the displaced current value
    // reachable in history (so swaps are reversible).
    selectChunkVersion: (id, value) =>
      set((state) => {
        const snapshot = state.doc;
        const next = mapChunks(snapshot, (chunks) =>
          chunks.map((c) => {
            if (c.id !== id || c.content === value) return c;
            const cur = c.content;
            const hist = c.metadata.contentHistory ?? [];
            const nextHist =
              cur.trim() && !hist.includes(cur)
                ? [...hist, cur].slice(-VERSION_LIMIT)
                : hist;
            return {
              ...c,
              content: value,
              metadata: { ...c.metadata, contentHistory: nextHist },
            };
          })
        );
        const past = [...state.past, snapshot].slice(-MAX_HISTORY);
        return {
          doc: next,
          past,
          future: [],
          dirty: true,
          lastEditChunkId: null,
          analysisStale: true, // swapped version → graph is out of date (A3)
        };
      }),

    dismissAiEdit: () => set({ lastAiEditChunkId: null }),

    setChunkSummary: (id, summary) =>
      // Route through commit() so adding/updating a summary is undoable and
      // redo-safe like its metadata peers (B8) — the previous hand-rolled set()
      // cleared `future` but never pushed to `past`, so the edit was lost on
      // undo. A summary is metadata enrichment, so it doesn't invalidate the
      // relationship graph (A3 → marksStale:false). The content hash is stamped
      // alongside so a later edit marks this summary stale (staleSummaryChunkIds).
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === id
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      summary,
                      summaryHash: hashContent(c.content),
                    },
                  }
                : c
            )
          ),
        { marksStale: false }
      ),

    setChunkType: (id, type) =>
      commit((doc) =>
        mapChunks(doc, (chunks) =>
          chunks.map((c) =>
            c.id === id
              ? {
                  ...c,
                  metadata: {
                    ...c.metadata,
                    chunkType: type,
                    format:
                      type === "diagram"
                        ? c.metadata.format ?? "mermaid"
                        : undefined,
                    level: type === "heading" ? c.metadata.level ?? 2 : undefined,
                  },
                }
              : c
          )
        )
      ),

    setHeadingLevel: (id, level) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === id
                ? {
                    ...c,
                    metadata: { ...c.metadata, chunkType: "heading", level },
                  }
                : c
            )
          ),
        { marksStale: false }
      ),

    convertToHeading: (id, level, content) =>
      commit((doc) =>
        mapChunks(doc, (chunks) =>
          chunks.map((c) =>
            c.id === id
              ? {
                  ...c,
                  content,
                  metadata: {
                    ...c.metadata,
                    chunkType: "heading",
                    level: Math.min(Math.max(level, 1), 3),
                    format: undefined,
                  },
                }
              : c
          )
        )
      ),

    addChunkAfter: (id, type = "text") => {
      const newChunk = emptyChunk(0, type);
      commit((doc) =>
        mapChunks(doc, (chunks) => {
          const found = id ? chunks.findIndex((c) => c.id === id) : -1;
          const idx = found >= 0 ? found : chunks.length - 1;
          const next = [...chunks];
          next.splice(idx + 1, 0, newChunk);
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunk.id });
      return newChunk.id;
    },

    insertDiagramAfter: (id, code) => {
      const newChunk: Chunk = { ...emptyChunk(0, "diagram"), content: code };
      commit((doc) =>
        mapChunks(doc, (chunks) => {
          const found = id ? chunks.findIndex((c) => c.id === id) : -1;
          const idx = found >= 0 ? found : chunks.length - 1;
          const next = [...chunks];
          next.splice(idx + 1, 0, newChunk);
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunk.id });
      return newChunk.id;
    },

    insertImageAfter: (id, url, prompt) => {
      const full = prompt.trim();
      const newChunk: Chunk = {
        id: localId(),
        order: 0,
        content: url,
        metadata: {
          chunkType: "image",
          summary: full ? full.slice(0, 200) : undefined,
          // Keep the full prompt so the image can be regenerated, and start an
          // empty version history (alternatives accumulate here).
          imagePrompt: full || undefined,
          imageSource: "ai",
          linkedChunks: [],
          contentHistory: [],
        },
      };
      commit((doc) =>
        mapChunks(doc, (chunks) => {
          const found = id ? chunks.findIndex((c) => c.id === id) : -1;
          const idx = found >= 0 ? found : chunks.length - 1;
          const next = [...chunks];
          next.splice(idx + 1, 0, newChunk);
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunk.id });
      return newChunk.id;
    },

    insertLocalImageAfter: (id, dataUrl, fileName) => {
      const newChunk: Chunk = {
        id: localId(),
        order: 0,
        content: dataUrl,
        metadata: {
          chunkType: "image",
          // The file name is a reasonable caption default; no imagePrompt —
          // there is no generation prompt to "regenerate" from.
          summary: fileName.trim() || undefined,
          imageSource: "local",
          linkedChunks: [],
          contentHistory: [],
        },
      };
      commit((doc) =>
        mapChunks(doc, (chunks) => {
          const found = id ? chunks.findIndex((c) => c.id === id) : -1;
          const idx = found >= 0 ? found : chunks.length - 1;
          const next = [...chunks];
          next.splice(idx + 1, 0, newChunk);
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunk.id });
      return newChunk.id;
    },

    splitChunk: (id, caret) => {
      const chunk = get().doc.chunks.find((c) => c.id === id);
      if (!chunk || chunk.metadata.chunkType !== "text") return null;
      const before = chunk.content.slice(0, caret);
      const after = chunk.content.slice(caret);
      const newChunk: Chunk = { ...emptyChunk(0), content: after };
      commit((doc) =>
        mapChunks(doc, (chunks) => {
          const idx = chunks.findIndex((c) => c.id === id);
          const next = [...chunks];
          next[idx] = { ...next[idx], content: before };
          next.splice(idx + 1, 0, newChunk);
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunk.id });
      return newChunk.id;
    },

    deleteChunk: (id) => {
      const chunks = get().doc.chunks;
      const idx = chunks.findIndex((c) => c.id === id);
      if (idx < 0) return;
      if (chunks.length <= 1) {
        // Keep one writing surface, but REUSE the id so focusedChunkId (and any
        // pending caret) stays valid and the new empty chunk keeps the caret.
        const replacement: Chunk = { ...emptyChunk(0), id };
        commit((doc) =>
          mapChunks(doc, (cs) => cs.map((c) => (c.id === id ? replacement : c)))
        );
        set({ focusedChunkId: id });
        return;
      }
      // Move focus to a sensible neighbour (previous, else next) so the caret
      // doesn't fall through to <body> after the deleted chunk unmounts.
      const neighbour = chunks[idx - 1] ?? chunks[idx + 1];
      const validIds = new Set(chunks.filter((c) => c.id !== id).map((c) => c.id));
      commit((doc) => ({
        ...mapChunks(doc, (cs) => reindex(cs.filter((c) => c.id !== id))),
        // Prune the persisted graph of the deleted paragraph (A3).
        analysis: pruneAnalysis(doc.analysis, validIds) ?? undefined,
      }));
      set({
        focusedChunkId: neighbour ? neighbour.id : null,
        analysis: pruneAnalysis(get().analysis, validIds),
      });
    },

    mergeWithPrevious: (id) => {
      const chunks = get().doc.chunks;
      const idx = chunks.findIndex((c) => c.id === id);
      if (idx <= 0) return null;
      const prev = chunks[idx - 1];
      const cur = chunks[idx];
      if (prev.metadata.chunkType !== "text" || cur.metadata.chunkType !== "text") {
        return null;
      }
      const mergedContent = prev.content + cur.content;
      const caretTarget = prev.id;
      const validIds = new Set(chunks.filter((c) => c.id !== id).map((c) => c.id));
      commit((doc) => ({
        ...mapChunks(doc, (cs) => {
          const i = cs.findIndex((c) => c.id === id);
          const next = [...cs];
          next[i - 1] = { ...next[i - 1], content: mergedContent };
          next.splice(i, 1);
          return reindex(next);
        }),
        analysis: pruneAnalysis(doc.analysis, validIds) ?? undefined,
      }));
      set({
        focusedChunkId: caretTarget,
        analysis: pruneAnalysis(get().analysis, validIds),
      });
      return caretTarget;
    },

    // Merge ≥2 adjacent text chunks into the first of them (item 3/4 —
    // multi-paragraph / partial merge via the selection). Contents join with
    // `mergeSeparator` per boundary; comments of all members are concatenated
    // onto the survivor; its summary/summaryHash are cleared (the text changed);
    // contentHistory stays the survivor's own. Undoable; prunes the graph of
    // the removed ids.
    mergeChunks: (ids) => {
      const doc0 = get().doc;
      if (!canMergeChunks(doc0, ids)) return null;
      const idSet = new Set(ids);
      const members = doc0.chunks.filter((c) => idSet.has(c.id)); // document order
      const first = members[0];
      let mergedContent = first.content;
      for (const m of members.slice(1)) {
        mergedContent += mergeSeparator(mergedContent, m.content) + m.content;
      }
      const mergedComments = members.flatMap((m) => m.metadata.comments ?? []);
      const removed = new Set(members.slice(1).map((m) => m.id));
      const validIds = new Set(
        doc0.chunks.filter((c) => !removed.has(c.id)).map((c) => c.id)
      );
      commit((doc) => ({
        ...mapChunks(doc, (cs) =>
          reindex(
            cs
              .filter((c) => !removed.has(c.id))
              .map((c) =>
                c.id === first.id
                  ? {
                      ...c,
                      content: mergedContent,
                      metadata: {
                        ...c.metadata,
                        summary: undefined,
                        summaryHash: undefined,
                        comments: mergedComments.length ? mergedComments : undefined,
                      },
                    }
                  : c
              )
          )
        ),
        analysis: pruneAnalysis(doc.analysis, validIds) ?? undefined,
      }));
      set({
        focusedChunkId: first.id,
        selectedChunkIds: [],
        analysis: pruneAnalysis(get().analysis, validIds),
      });
      return first.id;
    },

    // ----- slide-level structural ops (used by the slide editor) -----
    // Reorder the whole chunk list to match `orderedIds` (chunks not listed are
    // appended in their existing order, as a safety net). Undoable.
    setChunkOrder: (orderedIds) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) => {
            const byId = new Map(chunks.map((c) => [c.id, c] as const));
            const ordered: Chunk[] = [];
            for (const id of orderedIds) {
              const c = byId.get(id);
              if (c) ordered.push(c);
            }
            if (ordered.length !== chunks.length) {
              const seen = new Set(orderedIds);
              for (const c of chunks) if (!seen.has(c.id)) ordered.push(c);
            }
            return reindex(ordered);
          }),
        // Reordering keeps every id-based relationship intact, so the graph is
        // still valid (A3 — don't false-flag it "out of date").
        { marksStale: false }
      ),

    // Delete a set of chunks at once (e.g. a whole slide). Keeps ≥1 chunk.
    deleteChunks: (ids) => {
      const idSet = new Set(ids);
      const chunks = get().doc.chunks;
      const firstIdx = chunks.findIndex((c) => idSet.has(c.id));
      if (firstIdx < 0) return;
      const remaining = chunks.filter((c) => !idSet.has(c.id));
      if (remaining.length === 0) {
        const replacement = emptyChunk(0);
        const validIds = new Set([replacement.id]);
        commit((doc) => ({
          ...mapChunks(doc, () => [replacement]),
          analysis: pruneAnalysis(doc.analysis, validIds) ?? undefined,
        }));
        set({
          focusedChunkId: replacement.id,
          selectedChunkIds: [],
          analysis: pruneAnalysis(get().analysis, validIds),
        });
        return;
      }
      const neighbour = chunks[firstIdx - 1] ?? remaining[0];
      const validIds = new Set(remaining.map((c) => c.id));
      commit((doc) => ({
        ...mapChunks(doc, (cs) => reindex(cs.filter((c) => !idSet.has(c.id)))),
        analysis: pruneAnalysis(doc.analysis, validIds) ?? undefined,
      }));
      set({
        focusedChunkId: neighbour ? neighbour.id : null,
        selectedChunkIds: [],
        analysis: pruneAnalysis(get().analysis, validIds),
      });
    },

    // Clone the given chunks (fresh ids) and insert the copies — used to
    // duplicate a slide. Graph links/history are not carried over.
    duplicateChunksAfter: (ids) => {
      const idSet = new Set(ids);
      const chunks = get().doc.chunks;
      const group = chunks.filter((c) => idSet.has(c.id)); // document order
      if (group.length === 0) return [];

      const clone = (c: Chunk): Chunk => ({
        ...c,
        id: localId(),
        metadata: { ...c.metadata, linkedChunks: [], contentHistory: undefined },
      });

      // B7: the slide-duplicate caller passes a CONTIGUOUS block; only insert the
      // copies as one block after the last selected chunk when they really are
      // adjacent. For a non-contiguous selection, insert each copy immediately
      // after its own source instead — a copy can never land between unrelated
      // chunks (which would silently re-cut slide boundaries).
      const indices = group.map((c) => chunks.findIndex((x) => x.id === c.id));
      const contiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);

      if (contiguous) {
        const clones = group.map(clone);
        const lastId = group[group.length - 1].id;
        commit((doc) =>
          mapChunks(doc, (cs) => {
            const idx = cs.findIndex((c) => c.id === lastId);
            const next = [...cs];
            next.splice(idx + 1, 0, ...clones);
            return reindex(next);
          })
        );
        set({ focusedChunkId: clones[0]?.id ?? null });
        return clones.map((c) => c.id);
      }

      const cloneBySource = new Map<string, Chunk>();
      for (const c of group) cloneBySource.set(c.id, clone(c));
      commit((doc) =>
        mapChunks(doc, (cs) => {
          const next: Chunk[] = [];
          for (const c of cs) {
            next.push(c);
            const cl = cloneBySource.get(c.id);
            if (cl) next.push(cl);
          }
          return reindex(next);
        })
      );
      const orderedCloneIds = group.map((c) => cloneBySource.get(c.id)!.id);
      set({ focusedChunkId: orderedCloneIds[0] ?? null });
      return orderedCloneIds;
    },

    // Split a slide at a body chunk: insert a new heading chunk immediately
    // BEFORE it, so everything from that chunk down becomes a new slide
    // (headings delimit slides — see groupSlides). Undoable; returns the new
    // heading's id (null if the chunk doesn't exist).
    splitSlideBefore: (chunkId) => {
      if (!get().doc.chunks.some((c) => c.id === chunkId)) return null;
      // The title becomes document content, so it is written in the UI language.
      const heading: Chunk = { ...emptyChunk(0, "heading"), content: tNow("New slide") };
      heading.metadata = { ...heading.metadata, level: 1 };
      commit((doc) =>
        mapChunks(doc, (cs) => {
          const idx = cs.findIndex((c) => c.id === chunkId);
          if (idx < 0) return cs;
          const next = [...cs];
          next.splice(idx, 0, heading);
          return reindex(next);
        })
      );
      set({ focusedChunkId: heading.id });
      return heading.id;
    },

    // Merge a slide into the previous one by DEMOTING its heading to a text
    // chunk (content preserved, level removed) — with the delimiter gone, the
    // slide's chunks fuse into the slide before it. Undoable; a toast-less null
    // no-op when the chunk isn't a heading. The demoted chunk's layout override
    // is dropped too: the merged slide keeps the PREVIOUS slide's layout, and a
    // stale mid-slide override would shadow an Auto host (resolveLayout reads
    // the first override found).
    mergeSlideIntoPrevious: (headingChunkId) => {
      const chunk = get().doc.chunks.find((c) => c.id === headingChunkId);
      if (!chunk || chunk.metadata.chunkType !== "heading") return null;
      commit((doc) =>
        mapChunks(doc, (chunks) =>
          chunks.map((c) =>
            c.id === headingChunkId
              ? {
                  ...c,
                  metadata: {
                    ...c.metadata,
                    chunkType: "text",
                    level: undefined,
                    layout: undefined,
                  },
                }
              : c
          )
        )
      );
      return headingChunkId;
    },

    // Set an explicit slide-layout override on a slide's HOST chunk (heading,
    // else first chunk), or clear it (pass null) to go back to auto-picking from
    // the slide's content — without this there was no way back to "Auto" once a
    // layout had been chosen once. The override must be UNIQUE per slide:
    // `resolveLayout` reads the first override found on ANY of the slide's
    // chunks, so a stale `metadata.layout` on a later chunk (e.g. a former host
    // demoted mid-slide) would keep winning and make "Auto"/a new pick look
    // dead — every other chunk of the slide is therefore cleared too (null
    // clears all of them). Layout is a slide-presentation attribute, unrelated
    // to the relationship graph (A3).
    setChunkLayout: (id, layout) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) => {
            const slide = groupSlides(chunks).find((s) =>
              s.items.some((c) => c.id === id)
            );
            const slideIds = new Set((slide?.items ?? []).map((c) => c.id));
            if (slideIds.size === 0) slideIds.add(id);
            return chunks.map((c) => {
              if (!slideIds.has(c.id)) return c;
              const next = c.id === id ? layout ?? undefined : undefined;
              if (c.metadata.layout === next) return c; // keep identity (§4.1)
              return { ...c, metadata: { ...c.metadata, layout: next } };
            });
          }),
        { marksStale: false }
      ),

    // Flag/unflag a text chunk as a subtitle (Req 3). Presentation-only, so it
    // doesn't invalidate the relationship graph.
    setChunkSubtitle: (id, subtitle) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === id ? { ...c, metadata: { ...c.metadata, subtitle } } : c
            )
          ),
        { marksStale: false }
      ),

    // Personal RAG (開発.txt Stage 3, item 3-1) auto-accumulation (Q11/Q16):
    // presentation/workflow metadata like `subtitle` above, not a content
    // edit, so it doesn't invalidate the relationship graph.
    setChunkConfirmed: (id, confirmed) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === id ? { ...c, metadata: { ...c.metadata, confirmed } } : c
            )
          ),
        { marksStale: false }
      ),

    // Detach/re-link a slide (Req 2): store custom `slideBody` lines on the
    // slide's lead chunk (detach), or pass null to clear it (re-link to prose).
    setSlideBody: (leadId, body) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === leadId
                ? { ...c, metadata: { ...c.metadata, slideBody: body ?? undefined } }
                : c
            )
          ),
        { marksStale: false }
      ),

    // Set a slide's speaker notes on its heading chunk (item 1-1). Presentation-
    // only, so it doesn't invalidate the relationship graph — same rationale as
    // setChunkSubtitle/setSlideBody. A blank (after-trim) string is stored as
    // `undefined`, mirroring the Rust normalize() rule that collapses an
    // empty-after-trim notes string to `None` so it never round-trips as `Some("")`.
    setChunkNotes: (id, notes) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === id
                ? { ...c, metadata: { ...c.metadata, notes: notes.trim() ? notes : undefined } }
                : c
            )
          ),
        { marksStale: false }
      ),

    // Replace a set of chunks with fresh text chunks (one per string), inserted
    // at the position of the first removed chunk. Used by AI "Bulletize" to turn
    // a slide's prose into separate bullet chunks. Keeps ≥1 chunk overall.
    replaceChunksWithTexts: (ids, texts) => {
      const idSet = new Set(ids);
      const newChunks: Chunk[] = texts.map((t) => ({ ...emptyChunk(0), content: t }));
      commit((doc) =>
        mapChunks(doc, (cs) => {
          const next: Chunk[] = [];
          let inserted = false;
          for (const c of cs) {
            if (idSet.has(c.id)) {
              if (!inserted) {
                next.push(...newChunks);
                inserted = true;
              }
            } else {
              next.push(c);
            }
          }
          if (!inserted) next.push(...newChunks);
          if (next.length === 0) next.push(emptyChunk(0));
          return reindex(next);
        })
      );
      set({ focusedChunkId: newChunks[0]?.id ?? null });
    },

    moveChunk: (id, dir) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) => {
            const idx = chunks.findIndex((c) => c.id === id);
            const target = idx + dir;
            if (idx < 0 || target < 0 || target >= chunks.length) return chunks;
            const next = [...chunks];
            [next[idx], next[target]] = [next[target], next[idx]];
            return reindex(next);
          }),
        { marksStale: false } // a reorder leaves id-based relationships intact (A3)
      ),

    setFocused: (id) => set({ focusedChunkId: id }),
    flashChunk: (id) => {
      // Guard against stale graph nodes: after a delete/merge the persisted
      // analysis can reference a chunk id that no longer exists. Notify rather
      // than silently no-op (and don't blank whatever chunk is currently
      // focused by pointing focusedChunkId at a dead id).
      if (!get().doc.chunks.some((c) => c.id === id)) {
        get().notify(
          tNow("That paragraph no longer exists — re-analyze to refresh the graph."),
          "info"
        );
        return;
      }
      set({ flashChunkId: id, focusedChunkId: id });
      setTimeout(() => {
        if (get().flashChunkId === id) set({ flashChunkId: null });
      }, 1600);
    },
    flashChunks: (ids) => {
      // Multi-target variant of flashChunk (e.g. both endpoints of a graph
      // edge). Same dead-id guard, one shared 1600ms clear.
      const valid = new Set(get().doc.chunks.map((c) => c.id));
      const hits = [...new Set(ids)].filter((id) => valid.has(id));
      if (hits.length === 0) {
        get().notify(
          tNow("Those paragraphs no longer exist — re-analyze to refresh the graph."),
          "info"
        );
        return;
      }
      set({ flashChunkIds: hits, focusedChunkId: hits[0] });
      setTimeout(() => {
        if (get().flashChunkIds === hits) set({ flashChunkIds: [] });
      }, 1600);
    },
    toggleSelectChunk: (id) =>
      set((s) => ({
        selectedChunkIds: s.selectedChunkIds.includes(id)
          ? s.selectedChunkIds.filter((x) => x !== id)
          : [...s.selectedChunkIds, id],
      })),
    clearSelection: () => set({ selectedChunkIds: [] }),
    setBusyChunk: (id, busy, tabId) => {
      const t = tabId ?? get().activeTabId;
      const s = get();
      const cur = t === s.activeTabId ? s.busyChunks : s.inactiveTabs[t]?.busyChunks ?? {};
      const busyChunks = { ...cur };
      if (busy) busyChunks[id] = true;
      else delete busyChunks[id];
      routeTabPatch(t, { busyChunks });
    },
    setGlobalBusy: (label, tabId) =>
      routeTabPatch(tabId ?? get().activeTabId, { globalBusy: label }),
    beginChunkStream: (id, tabId) =>
      routeTabPatch(tabId ?? get().activeTabId, { streamingChunkId: id, streamingText: "" }),
    updateChunkStream: (text, tabId) =>
      routeTabPatch(tabId ?? get().activeTabId, { streamingText: text }),
    endChunkStream: (tabId) =>
      routeTabPatch(tabId ?? get().activeTabId, {
        streamingChunkId: null,
        streamingText: "",
      }),

    // Ghost-text (開発.txt Stage 2, item 2-4). Not per-tab and not routed
    // through routeTabPatch: the suggestion itself is ephemeral UI state (like
    // `flashChunkId`) scoped to the active tab + load, and is reset on every
    // document transition. Only `acceptGhostSuggestion` touches `doc`, as an
    // ordinary undoable edit.
    startGhostRequest: () => {
      const next = get().ghostRequestId + 1;
      set({ ghostRequestId: next });
      return next;
    },
    setGhostSuggestion: (ctxOrChunkId, text, requestId) => {
      const s = get();
      // Discard a result from a superseded request (last-request-wins) — the
      // guard the spec asks for. Document transitions bump the id too.
      if (requestId !== s.ghostRequestId) return;
      const ctx: GhostContext =
        typeof ctxOrChunkId === "string"
          ? {
              chunkId: ctxOrChunkId,
              prefix: s.doc.chunks.find((c) => c.id === ctxOrChunkId)?.content ?? "",
              tabId: s.activeTabId,
              docNonce: s.docNonce,
            }
          : ctxOrChunkId;
      // Never show a suggestion for another tab/load, or for text that has
      // changed since the request was built (BUG-001a/d).
      if (ctx.tabId !== s.activeTabId || ctx.docNonce !== s.docNonce) return;
      const live = s.doc.chunks.find((c) => c.id === ctx.chunkId);
      if (!live || live.content !== ctx.prefix) return;
      set({
        ghostSuggestion: {
          chunkId: ctx.chunkId,
          text,
          prefix: ctx.prefix,
          tabId: ctx.tabId,
          docNonce: ctx.docNonce,
        },
      });
    },
    // Tab-accept (BUG-001a). Validates everything the suggestion was generated
    // for, then commits prefix + text as a DISCRETE undo step (never merged
    // into the typing session before or after it), marks the doc dirty and
    // retires the request id so a late delta can't resurrect it. Logged to
    // aiOpLog (opId = the current ghost request id).
    acceptGhostSuggestion: (chunkId) => {
      const s = get();
      const g = s.ghostSuggestion;
      if (!g) return false;
      const live = s.doc.chunks.find((c) => c.id === chunkId);
      const reason =
        g.chunkId !== chunkId || !live
          ? "chunk-mismatch"
          : !g.text.trim()
            ? "empty" // nothing to insert — let Tab fall through
          : g.tabId !== s.activeTabId
            ? "tab-changed"
            : g.docNonce !== s.docNonce
              ? "doc-changed"
              : live.content !== g.prefix
                ? "text-changed"
                : null;
      const log = { opId: s.ghostRequestId, action: "ghost", tabId: s.activeTabId, docNonce: s.docNonce, chunkId };
      if (reason) {
        set(ghostReset(s));
        get().logAiOp({ ...log, phase: "discard", reason });
        return false;
      }
      const content = g.prefix + g.text;
      set((state) => ({
        doc: mapChunks(state.doc, (chunks) =>
          chunks.map((c) => (c.id === chunkId ? { ...c, content } : c))
        ),
        past: [...state.past, state.doc].slice(-MAX_HISTORY),
        future: [],
        dirty: true,
        // Typing after the accept starts yet another step.
        lastEditChunkId: null,
        lastAiEditChunkId: null,
        analysisStale: true, // edited text → graph is out of date (A3)
        ...ghostReset(state),
      }));
      get().logAiOp({ ...log, phase: "commit" });
      return true;
    },
    // Bumping `ghostRequestId` here (not just clearing the suggestion) is
    // load-bearing: the backend stream for the request that produced the
    // now-dismissed/accepted suggestion is NOT server-cancelled (it is a
    // background nicety — see `cancelChunkAction`'s comment on the same
    // pattern for one-click actions), so it keeps delivering deltas, and
    // eventually its final `.then(finalText => ...)`, after Escape/Tab. Every
    // one of those callbacks captured the OLD requestId and calls
    // `setGhostSuggestion` with it. Without the bump, that id still matched
    // `ghostRequestId` (only `startGhostRequest` used to advance it), so a
    // late delta silently resurrected a dismissed/already-accepted suggestion
    // — visibly reappearing after Escape, or, worse, letting a second Tab
    // duplicate content that was already merged in on accept. Bumping here
    // makes every in-flight callback's id stale immediately, the same
    // guard `setGhostSuggestion` already enforces for keystroke-driven
    // supersession.
    clearGhostSuggestion: () =>
      set({ ghostSuggestion: null, ghostRequestId: get().ghostRequestId + 1 }),

    // Read-aloud (UI3): a single global "currently speaking" chunk + the backend
    // utterance id, so a `speech-done` for an older utterance can't clear a newer
    // one (and finishing/stopping one chunk never affects another).
    beginSpeaking: (chunkId, utterance) =>
      set({ speakingChunkId: chunkId, speakingUtterance: utterance }),
    endSpeaking: (utterance) =>
      set((s) => {
        if (utterance !== undefined && s.speakingUtterance !== utterance) return {};
        return { speakingChunkId: null, speakingUtterance: null };
      }),
    // Multi-chunk read-aloud queue (item 14). Pure list mechanics — the actual
    // speak_text call lives in aiActions (advanceSpeechQueue), keeping these
    // testable without Tauri.
    setSpeechQueue: (ids) => set({ speechQueue: ids }),
    shiftSpeechQueue: () => {
      const q = get().speechQueue;
      if (q.length === 0) return null;
      const [head, ...rest] = q;
      set({ speechQueue: rest });
      return head;
    },

    // A model issue names the model that failed; once another model is the
    // active one the issue no longer applies (BUG-013c). Same-model saves
    // (sidebar width, preview background…) keep it.
    setSettings: (settings) =>
      set((s) =>
        settings.model !== s.settings?.model
          ? { settings, aiModelIssue: null }
          : { settings }
      ),
    setAiModelIssue: (issue) => set({ aiModelIssue: issue }),
    logAiOp: (e) =>
      set((s) => {
        // Copy whitelisted fields one by one — never spread the input, so a
        // caller can't smuggle content/keys into the log (MISS-01).
        const entry: AiOpLogEntry = {
          ts: Date.now(),
          opId: e.opId,
          phase: e.phase,
          action: e.action,
          tabId: e.tabId,
          docNonce: e.docNonce,
        };
        if (e.chunkId !== undefined) entry.chunkId = e.chunkId;
        if (e.reason !== undefined) entry.reason = e.reason;
        return { aiOpLog: [...s.aiOpLog, entry].slice(-AI_OP_LOG_MAX) };
      }),
    // See the AppActions doc comment above for the contract. Guarded the same
    // way fileActions.ts's `activeIsPristine` guards "reuse this tab or open a
    // new one" — a blank, untitled, not-yet-dirty single-paragraph editor tab
    // with no backing file — so this can never clobber a restored session or
    // anything the user already started typing before settings finished
    // loading.
    loadWelcomeExampleIfFirstRun: (settings) => {
      if (settings.hasSeenWelcomeExample) return false;
      const s = get();
      const c = s.doc.chunks;
      const pristine =
        (s.doc.mode ?? "editor") === "editor" &&
        !s.dirty &&
        !s.filePath &&
        c.length === 1 &&
        !c[0].content.trim();
      if (!pristine) return false;
      // Loaded as dirty: it's a fabricated example with no backing file, same
      // as an AI draft (B2) — otherwise the quit guard would let it vanish
      // silently, and there'd be nothing marking it as "not yet saved".
      get().loadDocument(makeWelcomeExampleDoc(), null, { dirty: true });
      return true;
    },
    setHasApiKey: (has) => set({ hasApiKey: has }),
    openSettings: (focus) =>
      set({ settingsOpen: true, settingsFocus: focus === "model-catalog" ? focus : null }),
    closeSettings: () => set({ settingsOpen: false, settingsFocus: null }),
    openDraft: () => set({ draftOpen: true }),
    closeDraft: () => set({ draftOpen: false }),
    openHelp: () => set({ helpOpen: true }),
    closeHelp: () => set({ helpOpen: false }),
    togglePalette: (open) =>
      set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
    openFind: (mode, seed) =>
      set((s) => ({
        find: {
          ...s.find,
          open: true,
          mode,
          query: seed ?? s.find.query,
          current: -1,
          hit: null,
          focusNonce: s.find.focusNonce + 1,
          replacePending: false,
        },
      })),
    closeFind: () => set((s) => ({ find: { ...s.find, open: false, replacePending: false } })),
    setFind: (patch) =>
      set((s) => {
        // Editing a find field ends the "⌘Z undoes the replace" window.
        const edited = patch.query !== undefined || patch.replacement !== undefined;
        return { find: { ...s.find, ...(edited ? { replacePending: false } : {}), ...patch } };
      }),
    replaceAllInChunks: (query, replacement, opts) => {
      let count = 0;
      const results = new Map<string, string>();
      for (const c of get().doc.chunks) {
        if (!isSearchableChunk(c)) continue;
        const r = replaceAll(c.content, query, replacement, opts);
        if (r.count > 0) {
          results.set(c.id, r.output);
          count += r.count;
        }
      }
      if (count === 0) return 0;
      commit((doc) =>
        mapChunks(doc, (chunks) =>
          chunks.map((c) => {
            const output = results.get(c.id);
            return output === undefined ? c : { ...c, content: output };
          })
        )
      );
      return count;
    },
    replaceMatchInChunk: (chunkId, from, to, replacement) => {
      const target = get().doc.chunks.find((c) => c.id === chunkId);
      if (!target || !isSearchableChunk(target)) return false;
      if (from < 0 || to < from || to > target.content.length) return false;
      const content = target.content.slice(0, from) + replacement + target.content.slice(to);
      commit((doc) =>
        mapChunks(doc, (chunks) => chunks.map((c) => (c.id === chunkId ? { ...c, content } : c)))
      );
      return true;
    },
    replaceAllInMarkdown: (query, replacement, opts) => {
      const r = replaceAll(documentToMarkdown(get().doc), query, replacement, opts);
      if (r.count > 0) get().setMarkdownSource(r.output, { newUndoStep: true });
      return r.count;
    },
    setLastExportReport: (format, warnings) =>
      set({ lastExportReport: { format, warnings, at: Date.now() } }),

    applyAnalysis: (result, sent) =>
      set((state) => {
        // state-async-4: what the analysis actually saw. A chunk edited while
        // Analyze ran keeps a summaryHash of the SENT text, so
        // staleSummaryChunkIds flags it and refreshStaleSummaries repairs it.
        const sentDoc = sent ?? state.doc;
        const sentContent = new Map(sentDoc.chunks.map((c) => [c.id, c.content]));
        const analyzable = (d: Document) =>
          d.chunks.filter((c) => c.metadata.chunkType === "text" || c.metadata.chunkType === "heading");
        const sentText = analyzable(sentDoc);
        const liveText = analyzable(state.doc);
        const textChanged =
          sentText.length !== liveText.length ||
          sentText.some((c, i) => c.id !== liveText[i].id || c.content !== liveText[i].content);
        // Stamp when this graph was computed — drives the freshness UI
        // ("analyzed 5 min ago" in ChunkAiMenu / NetworkPanel).
        const stamped: AnalysisResult = { ...result, analyzedAt: Date.now() };
        // Persist the graph into the document model: each edge becomes a
        // `linkedChunks` entry on its source chunk, and node summaries fill in
        // `metadata.summary`. This honours spec §5 and lets the graph survive a
        // save/reopen instead of being re-fetched from the API every session.
        const linksBySource: Record<string, string[]> = {};
        for (const e of result.edges) {
          (linksBySource[e.source] ??= []);
          if (!linksBySource[e.source].includes(e.target)) {
            linksBySource[e.source].push(e.target);
          }
        }
        const summaryById: Record<string, string> = {};
        for (const n of result.nodes) {
          if (n.summary) summaryById[n.id] = n.summary;
        }
        // Chunks the analysis covered (it emits a node per text paragraph).
        const analyzed = new Set(result.nodes.map((n) => n.id));
        const chunks = state.doc.chunks.map((c) => {
          const prevLinks = c.metadata.linkedChunks ?? [];
          // Replace links wholesale for every analyzed chunk so a paragraph that
          // lost all its relations is CLEARED, not left with stale edges.
          // Chunks outside the analyzed set keep whatever they had.
          const nextLinks = analyzed.has(c.id)
            ? linksBySource[c.id] ?? []
            : prevLinks;
          const linksChanged =
            nextLinks.length !== prevLinks.length ||
            nextLinks.some((t, i) => t !== prevLinks[i]);
          const fromAnalysis = summaryById[c.id];
          const nextSummary = fromAnalysis ?? c.metadata.summary;
          const summaryChanged = nextSummary !== c.metadata.summary;
          // The analysis summarized the chunk's SENT content, so re-stamp the
          // freshness hash from that text (even when the summary text happens
          // to be identical to the previous one).
          const nextHash =
            fromAnalysis !== undefined
              ? hashContent(sentContent.get(c.id) ?? c.content)
              : c.metadata.summaryHash;
          const hashChanged = nextHash !== c.metadata.summaryHash;
          if (!linksChanged && !summaryChanged && !hashChanged) return c;
          return {
            ...c,
            metadata: {
              ...c.metadata,
              linkedChunks: linksChanged ? nextLinks : prevLinks,
              summary: nextSummary,
              summaryHash: nextHash,
            },
          };
        });
        // BUG-015a: an empty result on a never-analyzed doc that changed no
        // chunk records nothing — keep it in memory only (the panel can say
        // "no relations") without dirtying the doc or burning an undo step.
        // A graph rebuilt from persisted links counts as a previous analysis,
        // so clearing it stays a real, undoable change.
        // An EMPTY graph (e.g. from a previous no-op press) is not a previous
        // analysis, so a second press stays a no-op too.
        const hasGraph = (a: AnalysisResult | null | undefined) =>
          !!a && (a.nodes.length > 0 || a.edges.length > 0);
        const nothingToRecord =
          result.nodes.length === 0 &&
          result.edges.length === 0 &&
          !hasGraph(state.analysis) &&
          !hasGraph(state.doc.analysis) &&
          chunks.every((c, i) => c === state.doc.chunks[i]);
        if (nothingToRecord) return { analysis: stamped, analysisStale: textChanged };
        return {
          // Persist the full graph on the document so it survives save/reopen
          // (single source of truth; also keep linkedChunks for the §5 model).
          doc: { ...state.doc, chunks, analysis: stamped },
          analysis: stamped,
          // Snapshot so Analyze is a discrete, undoable step (B4)…
          past: [...state.past, state.doc].slice(-MAX_HISTORY),
          dirty: true,
          future: [],
          // …and the freshly-built graph matches the document (A3) — unless
          // the text moved on while the analysis ran (state-async-4).
          analysisStale: textChanged || structurallyStale({ ...state.doc, chunks, analysis: stamped }),
        };
      }),

    toggleNetwork: (open) =>
      set((s) => ({ networkOpen: open ?? !s.networkOpen })),

    toggleFolderTree: (open) =>
      set((s) => ({ folderTreeOpen: open ?? !s.folderTreeOpen })),

    setFolderRoot: (path) => set({ folderRoot: path }),

    // Clamped to a range that stays readable at both ends, and rounded to whole
    // percent so the on-screen readout can't show floating-point noise.
    setMarkdownZoom: (zoom) =>
      set(() => {
        if (!Number.isFinite(zoom)) return {};
        return {
          markdownZoom: Math.round(Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, zoom)) * 100) / 100,
        };
      }),

    setMarkdownOffsetX: (offset) =>
      set(() => (Number.isFinite(offset) ? { markdownOffsetX: Math.round(offset) } : {})),

    toggleReviewPanel: (open) =>
      set((s) => {
        const next = open ?? !s.reviewPanelOpen;
        // Closing the panel drops the composer target so a stale "comment on
        // paragraph X" composer can't greet the next open.
        return next
          ? { reviewPanelOpen: true }
          : { reviewPanelOpen: false, reviewTargetChunkId: null };
      }),

    setReviewTarget: (id) => set({ reviewTargetChunkId: id }),

    toggleDiffPanel: (open) =>
      set((s) => ({ diffPanelOpen: open ?? !s.diffPanelOpen })),

    // Window-filling presentation overlay (item 1-3) — plain open/close (not a
    // toggle) so the palette entry and the Slide editor's Present button both
    // read as an unambiguous "start"/"stop", matching openSettings/closeSettings.
    openPresentation: () => set({ presentationOpen: true }),
    closePresentation: () => set({ presentationOpen: false }),

    // ----- review comments (persisted in chunk metadata; spec mismatch §2) -----
    addComment: (chunkId, text, author = "user", kind) => {
      if (!get().doc.chunks.some((c) => c.id === chunkId)) return null;
      const comment: ReviewComment = {
        id: localId(),
        text,
        createdAt: Date.now(),
        author,
        kind,
      };
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === chunkId
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      comments: [...(c.metadata.comments ?? []), comment],
                    },
                  }
                : c
            )
          ),
        { marksStale: false }
      );
      return comment.id;
    },

    updateComment: (chunkId, commentId, text) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === chunkId
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      comments: (c.metadata.comments ?? []).map((cm) =>
                        cm.id === commentId ? { ...cm, text } : cm
                      ),
                    },
                  }
                : c
            )
          ),
        { marksStale: false }
      ),

    deleteComment: (chunkId, commentId) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === chunkId
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      comments: (c.metadata.comments ?? []).filter(
                        (cm) => cm.id !== commentId
                      ),
                    },
                  }
                : c
            )
          ),
        { marksStale: false }
      ),

    toggleCommentResolved: (chunkId, commentId) =>
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) =>
              c.id === chunkId
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      comments: (c.metadata.comments ?? []).map((cm) =>
                        cm.id === commentId
                          ? { ...cm, resolved: !cm.resolved }
                          : cm
                      ),
                    },
                  }
                : c
            )
          ),
        { marksStale: false }
      ),

    // Remove AI-authored comments (optionally only one kind) before an AI pass
    // regenerates them. User comments are never touched; a doc with nothing to
    // clear is a no-op (no undo step burned). Untouched chunks keep identity.
    clearAiComments: (kind) => {
      const matches = (cm: ReviewComment) =>
        cm.author === "ai" && (kind === undefined || cm.kind === kind);
      const hasAny = get().doc.chunks.some((c) =>
        (c.metadata.comments ?? []).some(matches)
      );
      if (!hasAny) return;
      commit(
        (doc) =>
          mapChunks(doc, (chunks) =>
            chunks.map((c) => {
              const comments = c.metadata.comments;
              if (!comments?.length) return c;
              const kept = comments.filter((cm) => !matches(cm));
              if (kept.length === comments.length) return c; // keep identity (§4.1)
              return { ...c, metadata: { ...c.metadata, comments: kept } };
            })
          ),
        { marksStale: false }
      );
    },

    notify: (message, kind = "info") =>
      set((s) => {
        toastCounter += 1;
        return { toasts: [...s.toasts, { id: toastCounter, message, kind }] };
      }),
    dismissToast: (id) =>
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    undo: () =>
      set((state) => {
        if (state.past.length === 0) return state;
        const past = [...state.past];
        const previous = past.pop()!;
        return {
          doc: previous,
          past,
          future: [state.doc, ...state.future].slice(0, MAX_HISTORY),
          // Back at the saved state → clean again (MISS-12); an unsaved
          // baseline (AI draft, repaired file) stays dirty.
          dirty: !(state.savedDocIsClean && sameDocument(previous, state.savedDoc)),
          lastEditChunkId: null,
          // Re-derive the graph for the restored doc so NetworkPanel + the saved
          // .aix don't keep showing the pre-undo relationships (B4); recompute the
          // staleness badge for the restored structure (A3).
          analysis: previous.analysis ?? rebuildAnalysis(previous),
          analysisStale: structurallyStale(previous),
        };
      }),

    redo: () =>
      set((state) => {
        if (state.future.length === 0) return state;
        const [next, ...rest] = state.future;
        return {
          doc: next,
          past: [...state.past, state.doc].slice(-MAX_HISTORY),
          future: rest,
          dirty: !(state.savedDocIsClean && sameDocument(next, state.savedDoc)),
          lastEditChunkId: null,
          analysis: next.analysis ?? rebuildAnalysis(next),
          analysisStale: structurallyStale(next),
        };
      }),

    markClean: (filePath, savedDocument) =>
      set((s) => ({
        dirty: false,
        filePath: filePath === undefined ? s.filePath : filePath,
        // The just-saved document IS the new baseline (item 1-2). Callers pass
        // the EXACT doc they wrote so a keystroke can never be silently
        // promoted into the baseline — see the `savedDocument` param doc. (The
        // async save paths use markTabClean, state-async-3.)
        savedDoc: savedDocument ?? s.doc,
        savedDocIsClean: true,
        // A save ends the typing session, so undo can land exactly on the
        // saved state (MISS-12) instead of jumping past it.
        lastEditChunkId: null,
      })),

    markTabClean: (tabId, docNonce, filePath, savedDocument) => {
      const s = get();
      const patchFor = (live: Document, path: string | null) => ({
        dirty: !sameDocument(live, savedDocument),
        filePath: filePath === undefined ? path : filePath,
        savedDoc: savedDocument,
        savedDocIsClean: true,
        lastEditChunkId: null,
      });
      if (tabId === s.activeTabId) {
        if (s.docNonce !== docNonce) return false;
        set(patchFor(s.doc, s.filePath));
        return true;
      }
      const snap = s.inactiveTabs[tabId];
      if (!snap || snap.docNonce !== docNonce) return false;
      set({ inactiveTabs: { ...s.inactiveTabs, [tabId]: { ...snap, ...patchFor(snap.doc, snap.filePath) } } });
      return true;
    },
  };
});

/** Module-level form of `captureOp` for aiActions/fileActions (BUG-001b). */
export function captureOp(): OpTicket {
  return useStore.getState().captureOp();
}

/** Module-level form of `ownsOp`: same tab active AND same document load. */
export function ownsOp(op: OpTicket): boolean {
  return useStore.getState().ownsOp(op);
}
