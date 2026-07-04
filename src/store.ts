// Central application state (Zustand).
//
// Performance note (spec §4.1 / Phase 5): chunk mutations are immutable and
// preserve the object identity of *unchanged* chunks. Combined with per-chunk
// selectors in the components, editing one paragraph re-renders only that
// paragraph — not the whole document.

import { create } from "zustand";
import { groupSlides } from "./slides";
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

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
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
  past: Document[];
  future: Document[];
  analysis: AnalysisResult | null;
  analysisStale: boolean;
  focusedChunkId: string | null;
  lastEditChunkId: string | null;
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
    past: s.past,
    future: s.future,
    analysis: s.analysis,
    analysisStale: s.analysisStale,
    focusedChunkId: s.focusedChunkId,
    lastEditChunkId: s.lastEditChunkId,
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
    past: snap.past,
    future: snap.future,
    analysis: snap.analysis,
    analysisStale: snap.analysisStale,
    focusedChunkId: snap.focusedChunkId,
    lastEditChunkId: snap.lastEditChunkId,
    globalBusy: snap.globalBusy,
    streamingChunkId: snap.streamingChunkId,
    streamingText: snap.streamingText,
    busyChunks: snap.busyChunks,
    flashChunkId: null,
    flashChunkIds: [],
    selectedChunkIds: [],
    lastAiEditChunkId: null,
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
  // Review comments panel (right dock, like networkOpen — not per-tab). The
  // target chunk is the one the panel's "add comment" composer points at (set
  // when the panel is opened from a chunk's gutter comment button).
  reviewPanelOpen: boolean;
  reviewTargetChunkId: string | null;
  settingsOpen: boolean;
  draftOpen: boolean;
  helpOpen: boolean;
  // Command palette (提案1 — ⌘K).
  paletteOpen: boolean;
  // The most recent export's warning report (提案2): exports used to surface
  // warnings only as a 3.5s toast; the health bar keeps them reviewable.
  lastExportReport: { format: string; warnings: string[]; at: number } | null;

  toasts: Toast[];

  // history (undo/redo) — snapshots of the document
  past: Document[];
  future: Document[];
  lastEditChunkId: string | null;
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
  newTab: (mode?: DocMode) => void;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  hydrateSession: (tabs: PersistedTab[], activeTabId: string) => void;
  setTitle: (title: string) => void;
  setMode: (mode: DocMode) => void;

  updateChunkContent: (id: string, content: string) => void;
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
  setSlideBody: (leadId: string, body: string[] | null) => void;
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
  // Read-aloud lifecycle (UI3).
  beginSpeaking: (chunkId: string, utterance: number) => void;
  endSpeaking: (utterance?: number) => void;
  // Multi-chunk read-aloud queue (item 14). `shiftSpeechQueue` pops the head
  // (null when empty) — the api call itself lives in aiActions so these pure
  // mechanics stay testable.
  setSpeechQueue: (ids: string[]) => void;
  shiftSpeechQueue: () => string | null;

  setSettings: (settings: Settings) => void;
  setHasApiKey: (has: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openDraft: () => void;
  closeDraft: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  togglePalette: (open?: boolean) => void;
  setLastExportReport: (format: string, warnings: string[]) => void;

  applyAnalysis: (result: AnalysisResult) => void;
  toggleNetwork: (open?: boolean) => void;
  toggleReviewPanel: (open?: boolean) => void;
  setReviewTarget: (id: string | null) => void;

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

  markClean: (filePath?: string | null) => void;
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

  const mapChunks = (doc: Document, fn: (chunks: Chunk[]) => Chunk[]): Document => ({
    ...doc,
    chunks: fn(doc.chunks),
  });

  return {
    doc: makeInitialDoc(),
    filePath: null,
    dirty: false,
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
    speakingChunkId: null,
    speakingUtterance: null,
    speechQueue: [],
    analysis: null,
    analysisStale: false,
    networkOpen: false,
    reviewPanelOpen: false,
    reviewTargetChunkId: null,
    settingsOpen: false,
    draftOpen: false,
    helpOpen: false,
    paletteOpen: false,
    lastExportReport: null,
    toasts: [],
    past: [],
    future: [],
    lastEditChunkId: null,
    lastAiEditChunkId: null,

    loadDocument: (doc, filePath = null, opts) =>
      set({
        doc,
        filePath,
        // B2: drafted/imported docs have no backing file and are unsaved, so they
        // must be dirty — otherwise the tab/quit guards treat irreproducible AI
        // drafts as "clean" and discard them silently.
        dirty: opts?.dirty ?? false,
        past: [],
        future: [],
        // Prefer the persisted full graph (paragraph + sentence nodes); fall back
        // to reconstructing a paragraph-only graph from older linkedChunks docs.
        analysis: doc.analysis ?? rebuildAnalysis(doc),
        analysisStale: false,
        focusedChunkId: doc.chunks[0]?.id ?? null,
        lastEditChunkId: null,
        lastAiEditChunkId: null,
        selectedChunkIds: [],
      }),

    // Live streaming snapshot (Draft): replace the document only — no history,
    // no dirty/focus churn. Chunks carry stable position ids so React reconciles
    // in place. loadDocument() finalises the stream.
    setStreamingDocument: (doc) => set({ doc }),

    // ----- tabs: active tab lives in top-level fields; others as snapshots -----
    newTab: (mode = "editor") =>
      set((s) => {
        const id = localId();
        const fresh = makeInitialDoc(mode);
        return {
          inactiveTabs: { ...s.inactiveTabs, [s.activeTabId]: snapshotActive(s) },
          tabOrder: [...s.tabOrder, id],
          activeTabId: id,
          doc: fresh,
          filePath: null,
          dirty: false,
          past: [],
          future: [],
          analysis: null,
          analysisStale: false,
          focusedChunkId: fresh.chunks[0]?.id ?? null,
          lastEditChunkId: null,
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
        return { activeTabId: id, inactiveTabs, ...applySnapshot(target) };
      }),

    closeTab: (id) =>
      set((s) => {
        if (s.tabOrder.length <= 1) return {}; // always keep one tab open
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
          ...(target ? applySnapshot(target) : {}),
        };
      }),

    // Restore a saved multi-tab session (A2). Cannot reuse loadDocument (which
    // collapses to a single tab) — rebuilds the active fields + every background
    // tab's snapshot from the persisted set.
    hydrateSession: (tabs, activeTabId) =>
      set(() => {
        const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
        if (!active) return {};
        const inactiveTabs: Record<string, TabSnapshot> = {};
        for (const t of tabs) {
          if (t.id === active.id) continue;
          inactiveTabs[t.id] = {
            doc: t.doc,
            filePath: t.filePath,
            dirty: t.dirty,
            past: [],
            future: [],
            analysis: t.doc.analysis ?? rebuildAnalysis(t.doc),
            analysisStale: false,
            focusedChunkId: t.doc.chunks[0]?.id ?? null,
            lastEditChunkId: null,
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
          past: [],
          future: [],
          analysis: active.doc.analysis ?? rebuildAnalysis(active.doc),
          analysisStale: false,
          focusedChunkId: active.doc.chunks[0]?.id ?? null,
          lastEditChunkId: null,
          lastAiEditChunkId: null,
          flashChunkId: null,
          flashChunkIds: [],
          speechQueue: [],
          selectedChunkIds: [],
          globalBusy: null,
          streamingChunkId: null,
          streamingText: "",
          busyChunks: {},
        };
      }),

    setTitle: (title) =>
      set((s) => ({ doc: { ...s.doc, title }, dirty: true })),

    // Switch the current document between "editor" (prose) and "slide" (deck)
    // views. Both render the SAME chunk model — a slide is just the chunks under
    // a heading — so this only flips how they're presented; no content migration.
    setMode: (mode) => {
      const prevMode = get().doc.mode ?? "editor";
      if (prevMode === mode) return;
      set((s) => ({ doc: { ...s.doc, mode }, dirty: true }));
      // Slide→Editor didn't preserve your place (SlideEditor already derives
      // the selected slide from focusedChunkId on the way in, so Editor→Slide
      // was fine). flashChunk scrolls to and briefly highlights it, closing
      // the gap the same way graph/review navigation already does.
      if (prevMode === "slide" && mode === "editor" && get().focusedChunkId) {
        get().flashChunk(get().focusedChunkId as string);
      }
    },

    // Live typing: coalesce into one undo step per continuous edit session on a
    // chunk. Replaces only the edited chunk object (others keep identity).
    updateChunkContent: (id, content) =>
      set((state) => {
        const startNewUndoStep =
          state.past.length === 0 || state.lastEditChunkId !== id;
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
      const heading: Chunk = { ...emptyChunk(0, "heading"), content: "New slide" };
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
          "That paragraph no longer exists — re-analyze to refresh the graph.",
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
          "Those paragraphs no longer exist — re-analyze to refresh the graph.",
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

    setSettings: (settings) => set({ settings }),
    setHasApiKey: (has) => set({ hasApiKey: has }),
    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),
    openDraft: () => set({ draftOpen: true }),
    closeDraft: () => set({ draftOpen: false }),
    openHelp: () => set({ helpOpen: true }),
    closeHelp: () => set({ helpOpen: false }),
    togglePalette: (open) =>
      set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
    setLastExportReport: (format, warnings) =>
      set({ lastExportReport: { format, warnings, at: Date.now() } }),

    applyAnalysis: (result) =>
      set((state) => {
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
          // The analysis just summarized the chunk's CURRENT content, so
          // re-stamp the freshness hash even when the summary text happens to
          // be identical to the previous one.
          const nextHash =
            fromAnalysis !== undefined
              ? hashContent(c.content)
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
        return {
          // Persist the full graph on the document so it survives save/reopen
          // (single source of truth; also keep linkedChunks for the §5 model).
          doc: { ...state.doc, chunks, analysis: stamped },
          analysis: stamped,
          // Snapshot so Analyze is a discrete, undoable step (B4)…
          past: [...state.past, state.doc].slice(-MAX_HISTORY),
          dirty: true,
          future: [],
          // …and the freshly-built graph matches the document (A3).
          analysisStale: false,
        };
      }),

    toggleNetwork: (open) =>
      set((s) => ({ networkOpen: open ?? !s.networkOpen })),

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
          dirty: true,
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
          dirty: true,
          lastEditChunkId: null,
          analysis: next.analysis ?? rebuildAnalysis(next),
          analysisStale: structurallyStale(next),
        };
      }),

    markClean: (filePath) =>
      set((s) => ({
        dirty: false,
        filePath: filePath === undefined ? s.filePath : filePath,
      })),
  };
});
