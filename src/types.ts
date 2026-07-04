// TypeScript mirror of the Rust data model (src-tauri/src/models.rs, ai.rs,
// settings.rs). All Rust structs use `#[serde(rename_all = "camelCase")]`, so
// these field names line up 1:1 across the IPC boundary.

export type ChunkType = "text" | "diagram" | "heading" | "image";

/** A review/feedback note attached to a chunk (user- or AI-authored). */
export interface ReviewComment {
  id: string;
  text: string;
  createdAt: number; // ms epoch
  author?: "user" | "ai";
  kind?: string;
  resolved?: boolean;
}

export interface ChunkMetadata {
  chunkType: ChunkType;
  format?: string; // e.g. "mermaid" when chunkType === "diagram"
  level?: number; // 1–3 when chunkType === "heading"
  summary?: string;
  linkedChunks: string[];
  imagePrompt?: string; // image chunks: prompt used, for "regenerate"
  contentHistory?: string[]; // prior content values (text versions / image URLs)
  layout?: SlideLayout; // slide lead chunk: explicit slide-layout override
  subtitle?: boolean; // text chunk flagged as a subtitle (Req 3)
  slideBody?: string[]; // slide-only body override — "detach" from prose (Req 2)
  // Diagram chunks: PNG data URL of the rendered graph. Injected by the
  // frontend into EXPORT payloads only (never persisted from the editor UI).
  renderedImage?: string;
  comments?: ReviewComment[]; // review comments on this chunk
  // Hex hash of the chunk content at the time metadata.summary was written
  // (frontend computes; Rust only persists) — detects stale summaries.
  summaryHash?: string;
  // Optional ordering index for a slide's images (lower renders first; ties
  // broken by document order — see `slideImages` in slides.ts).
  slot?: number;
}

export interface Chunk {
  id: string;
  order: number;
  content: string;
  metadata: ChunkMetadata;
}

/**
 * View mode of a document/tab: how the same chunk model is presented — prose
 * paragraphs, or a deck (headings → slide titles). Switchable at any time from
 * the toolbar's Editor/Slides toggle or the command palette; switching never
 * migrates or drops content, it only changes presentation. Older .aix files
 * without the field load as "editor".
 */
export type DocMode = "editor" | "slide";

export interface Document {
  id: string;
  title: string;
  chunks: Chunk[];
  mode?: DocMode; // defaults to "editor" when absent (back-compat)
  analysis?: AnalysisResult; // persisted relationship graph (spec §3.4)
}

/** Result of opening a `.aix` file: the document plus any repairs made on load (A1). */
export interface OpenedDocument {
  document: Document;
  notes: string[];
}

/** One tab persisted for crash recovery / session restore (A2). */
export interface PersistedTab {
  id: string;
  doc: Document;
  filePath: string | null;
  dirty: boolean;
}

/** The autosaved multi-tab working set (A2). */
export interface SessionData {
  tabs: PersistedTab[];
  activeTabId: string;
  savedAt: number;
}

// Slide deck model (v1.2.0). A slide reuses editor Chunks (heading = title,
// text = bullets, image, diagram) plus a layout; decks export to .pptx.
// Auto-pick (see `autoLayout` in slides.ts / deck.rs) only ever produces
// "section" | "title-content" | "title-image" — the "-left"/"-top" image
// variants are manual-choice only (an explicit override), never guessed.
export type SlideLayout =
  | "section"
  | "title-content"
  | "title-image"
  | "title-image-left"
  | "image-top";

export interface Slide {
  id: string;
  order: number;
  layout: SlideLayout;
  chunks: Chunk[];
  notes: string; // speaker notes (reserved; not yet emitted to PPTX)
}

export interface Deck {
  id: string;
  title: string;
  slides: Slide[];
}

/** Result of a PPTX export: slide count and any non-fatal notes. */
export interface PptxReport {
  slides: number;
  warnings: string[];
}

export interface Settings {
  endpoint: string;
  model: string; // active text model id
  models: string[]; // selectable text-model list (persisted)
  imageModel: string; // active image-generation model id
  imageModels: string[]; // selectable image-model list (persisted)
  defaultTargetLanguage: string; // "Default language" — global output language
  writingTone: string; // global writing tone applied to writing actions
  temperature: number;
  editorFontFamily?: "serif" | "sans" | "mono"; // editor body font (default "serif")
  editorFontSize?: number; // editor body font size in px (default 17; clamped 12..=28 on load)
  removedModels?: string[]; // built-in model ids the user removed from the pickers (default [])
}

export type AiAction =
  | "translate"
  | "proofread"
  | "summarize"
  | "expand"
  | "detailed"
  | "concentrate"
  | "focus"
  | "harmonize"
  | "custom";

export interface AiRequest {
  action: AiAction;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  targetLanguage?: string;
  style?: string; // target writing style for "proofread"
  instruction?: string;
  outputLanguage?: string; // pin output to the configured default language
  tone?: string; // global writing tone
  // T1 — whole-document context: the section heading the chunk lives under, a
  // compact document outline (headings + summaries), and graph-linked material.
  sectionHeading?: string;
  documentMap?: string;
  linkedContent?: string;
}

export type AnalysisNodeKind = "paragraph" | "sentence";

export interface AnalysisNode {
  id: string;
  label: string;
  summary: string;
  kind?: AnalysisNodeKind; // defaults to "paragraph"
  parent?: string; // owning paragraph id, for sentence nodes
}

export interface AnalysisEdge {
  source: string;
  target: string;
  relation: string;
}

export interface AnalysisResult {
  nodes: AnalysisNode[];
  edges: AnalysisEdge[];
  analyzedAt?: number; // ms epoch — when this graph was computed
}

export type ExportFormat = "txt" | "md" | "rtf";

/** Streaming draft events from the `ai_draft_stream` command channel. */
export type DraftEvent =
  | { kind: "update"; document: Document } // live snapshot (position-based ids)
  | { kind: "done"; document: Document }; // final document (real ids)
