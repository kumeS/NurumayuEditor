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
  // image chunks: "ai" (generated) or "local" (inserted from a file the user
  // picked/dropped/pasted). Mirrors Rust's ChunkMetadata::image_source; older
  // documents loaded from disk are repaired to "ai" by Document::normalize on
  // the Rust side before reaching the frontend.
  imageSource?: "ai" | "local";
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
  // Speaker notes for the slide this chunk leads: read only from a slide's
  // lead chunk (its heading, or the first chunk of a heading-less leading
  // slide — see slides.ts slideNotes). Mirrors Rust's ChunkMetadata::notes.
  notes?: string;
  // Personal RAG (開発.txt Stage 3, item 3-1) auto-accumulation (Q11/Q16): the
  // user has explicitly marked this chunk's content as vetted enough to feed
  // into their own personal library. On save, every confirmed chunk with
  // non-empty content is (re-)indexed under a stable per-chunk source path so
  // edits keep that passage fresh rather than duplicating it (see
  // fileActions.ts's save flow and Rust `rag_sync_confirmed_chunks`). Mirrors
  // Rust's ChunkMetadata::confirmed; defaults to false/absent.
  confirmed?: boolean;
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
export type DocMode = "editor" | "markdown" | "slide";

export interface Document {
  id: string;
  title: string;
  chunks: Chunk[];
  mode?: DocMode; // defaults to "editor" when absent (back-compat)
  analysis?: AnalysisResult; // persisted relationship graph (spec §3.4)
  /**
   * Canonical Markdown text of a Markdown-backed document. In "markdown"
   * mode it is current and read verbatim. In "editor"/"slide" mode it is the
   * merge baseline: TS `documentToMarkdown` keeps the original bytes of every
   * block the chunks still contain and re-serializes only edited chunks
   * (chunk edits and setMode keep it; setTitle rewrites only its H1 line).
   * GUI .md saves send `{mode: "markdown", markdownSource: <merged text>}`,
   * so Rust `document_to_md` writes it verbatim; Rust has no merge and
   * ignores this field outside "markdown" mode (CLI/MCP regeneration).
   */
  markdownSource?: string;
}

/** Result of opening a `.aix` file: the document plus any repairs made on load (A1). */
export interface OpenedDocument {
  document: Document;
  notes: string[];
}

/** One entry in the folder tree sidebar. */
export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** True for files the app can open (`.aix`/`.md`/`.markdown`). Directories
   * are never directly "openable" — the tree expands them instead. */
  isOpenable: boolean;
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
  notes: string; // speaker notes, derived from the slide's lead chunk's metadata.notes (deck.rs)
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

/** Result of a PDF export (mirror of Rust `pdf::PdfReport`; the field lists
 * are kept equal by src/pdfExport.test.ts): page count plus a counted warning
 * per lossy class — images as text placeholders, diagrams as source text, and
 * Markdown-mode paragraphs whose markup prints literally. */
export interface PdfReport {
  pages: number;
  warnings: string[];
  imagesOmitted: number;
  diagramsAsSource: number;
  markdownAsPlainText: number;
}

/** Result of an RTF export (mirror of Rust `fileio::RtfReport`; the field
 * lists are kept equal by src/rtfReport.test.ts): one counted warning per
 * lossy class — images kept as "[Image: …]" text placeholders (not downloaded,
 * local file unreadable, or a format RTF can't embed) and diagrams written as
 * source text. `export_document` returns it for "rtf" and null for txt/md. */
export interface RtfReport {
  warnings: string[];
  imagesNotDownloaded: number;
  localImagesUnresolved: number;
  imagesNotEmbeddable: number;
  diagramsAsSource: number;
}

/** "Zero external transmission" visibility (開発.txt Stage 2, item 2-2):
 * process-wide counters mirroring `commands::NetworkStats` — LLM calls
 * (ai.rs) and fetches through net.rs (reference/image/citation lookups and
 * the OpenRouter model list) are two separate chokepoints, so they stay as
 * two distinct pairs of numbers. */
export interface NetworkStats {
  aiCalls: number;
  aiBytes: number;
  fetchCalls: number;
  fetchBytes: number;
}

/** OpenRouter prices as the API's decimal USD strings, verbatim (mirror of
 * Rust `openrouter_models::OpenRouterPricing`; field names and nullability
 * are contract-tested in openrouter_models.rs). `null` = absent/unusable. */
export interface OpenRouterPricing {
  prompt: string | null;
  completion: string | null;
  request: string | null;
  image: string | null;
  imageOutput: string | null;
}

/** One OpenRouter catalog entry (mirror of Rust
 * `openrouter_models::OpenRouterModel`). `name` falls back to `id`. */
export interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: OpenRouterPricing;
}

/** Result of `list_openrouter_models` (mirror of Rust
 * `openrouter_models::OpenRouterCatalog`): usable models plus the count of
 * dropped rows (no id / duplicate id) and one message per dropped class. */
export interface OpenRouterCatalog {
  models: OpenRouterModel[];
  skipped: number;
  warnings: string[];
}

/** Markdown preview background tones (see previewBackground.ts). */
export type PreviewBackground = "white" | "warm" | "gray" | "paper" | "mint" | "blue";

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
  // Ghost-text inline completion (開発.txt Stage 2, item 2-4): when true, only
  // fire completion requests if the configured endpoint is local (privacy
  // preference) — enforced backend-side in commands::ai_ghost_complete_stream,
  // not just here. Default false: the local-only RESTRICTION is opt-in; ghost
  // text itself is on whenever aiReady(). Mirrors Rust `Settings`.
  limitCompletionToLocalModel?: boolean;
  // Grant-application beachhead (開発.txt Stage 2, item 2-1): global
  // character-limit warning threshold — "warn me when any paragraph exceeds
  // N characters". Generic (any length-constrained writing), not tied to any
  // specific bundled form. `undefined`/absent = off (default); the frontend
  // computes each chunk's character count live from `chunk.content` (CJK-
  // aware) rather than persisting counts. Mirrors Rust `Settings.char_limit_warning`.
  charLimitWarning?: number;
  // Personal RAG (開発.txt Stage 3, item 3-1): opt-in to grounding AI writing/
  // revision actions against the user's own local knowledge base of past
  // papers/notes — fully on-device (rag.rs: fastembed + sqlite-vec). Off by
  // default; enabling this alone does not download the embedding model or
  // create an index — both happen lazily on the first add-source/search
  // call. Mirrors Rust `Settings.personal_rag_enabled`.
  personalRagEnabled?: boolean;
  // Blindspot QA v1 (project.md Q13): true once the one-time first-run worked
  // example (progress note → slides → own-figure) has been shown. The app
  // checks this on startup; while false/absent it replaces the blank first
  // document with the worked example, then persists this as true via
  // api.saveSettings so it only ever shows once. Mirrors Rust
  // `Settings.has_seen_welcome_example`.
  hasSeenWelcomeExample?: boolean;
  // MCP write gate (開発.txt §9 Q12/D6): opt-in to letting a connected MCP
  // agent insert a small retrieved-reference chunk into one of your own
  // .aix documents via mcp.rs's `search_and_summarize` tool. Off by default;
  // every other MCP tool (read-only) is unaffected by this setting. Mirrors
  // Rust `Settings.mcp_write_enabled`.
  mcpWriteEnabled?: boolean;
  /**
   * Whether an API key exists in the OS keychain — the existence boolean only,
   * never the key. Cached here so launching the app doesn't open the keychain
   * (every read is a macOS permission prompt); `undefined` means "never
   * determined" and triggers one real read on the Rust side.
   */
  apiKeyPresent?: boolean;
  /** Markdown preview background tone; absent = "white". Mirrors Rust
   * `Settings.preview_background` (unknown values are reset on load). */
  previewBackground?: PreviewBackground;
  /** Files sidebar width in px; absent = default. Mirrors Rust
   * `Settings.sidebar_width` (clamped to its bounds on load). */
  sidebarWidth?: number;
}

/** One indexed source file in the personal knowledge base (rag.rs). */
export interface RagSourceInfo {
  path: string;
  passageCount: number;
}

/** One personal-library search hit: source file + matched snippet + distance
 * (cosine distance from the query; lower = more similar). */
export interface RagSearchHit {
  sourcePath: string;
  snippet: string;
  distance: number;
}

// ----- Citation management (開発.txt Stage 3, item 3-2) --------------------
// Mirrors src-tauri/src/citations.rs's `CitationEntry`/`CitationStyle`/
// `LookupResult` 1:1. Deliberately "bring your own references and format
// them" — NOT a literature-search engine (see that module's doc comment).
// Only two citation styles are supported: APA (7th ed., author-date) and
// IEEE (numbered bracket) — not a general Citation Style Language engine.

/** One imported/looked-up citation entry, persisted per-document (a JSON
 * sidecar next to the `.aix` file — see citations.rs's module doc). */
export interface CitationEntry {
  id: string;
  bibtexKey: string;
  entryType: string; // "article" | "inproceedings" | "book" | … (BibTeX/BibLaTeX type)
  authors: string[];
  title: string;
  year?: number;
  venue?: string; // journal / booktitle / publisher / venue, whichever applies
  doi?: string;
  volume?: string;
  number?: string;
  pages?: string;
  publisher?: string;
  url?: string;
}

/** Result of `citations_import_bibtex`: newly added entries plus any
 * per-entry warnings (e.g. an entry missing a required title was skipped —
 * "warn, don't block", shown on a persistent surface, never toast-only). */
export interface BibtexImportResult {
  added: CitationEntry[];
  warnings: string[];
}

/** Exactly the two supported citation styles — see this file's section doc. */
export type CitationStyleName = "apa" | "ieee";

/** Metadata fetched from a DOI (CrossRef) or arXiv id lookup, for reviewing
 * before adding as a new citation entry (`citations_add_lookup_result`). */
export interface CitationLookupResult {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  abstractText?: string;
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
  // Personal RAG (開発.txt Stage 3, item 3-1): top personal-library matches for
  // this chunk (see `aiActions.ts::gatherRagSnippets`), empty/omitted whenever
  // the setting is off or nothing is indexed. Mirrors Rust `AiRequest.ragSnippets`
  // (ai.rs), which folds every non-empty snippet into a "[From your personal
  // library]" prompt section — this is live grounding context, not a dropped
  // field. Which source(s) were attached is then surfaced to the user near the
  // result (see aiActions.ts's `notifyRagSources`).
  ragSnippets?: RagSearchHit[];
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
