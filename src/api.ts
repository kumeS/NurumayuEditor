// Typed wrappers around the Tauri command surface (src-tauri/src/commands.rs).
// All argument keys are single words, so JS camelCase maps directly to the Rust
// snake_case parameter names.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AiRequest,
  AnalysisResult,
  BibtexImportResult,
  CitationEntry,
  CitationLookupResult,
  CitationStyleName,
  Document,
  DraftEvent,
  ExportFormat,
  NetworkStats,
  OpenedDocument,
  PptxReport,
  RagSearchHit,
  RagSourceInfo,
  SessionData,
  Settings,
} from "./types";

export const api = {
  importDocument: (path: string) =>
    invoke<Document>("import_document", { path }),

  exportDocument: (document: Document, path: string, format: ExportFormat) =>
    invoke<void>("export_document", { document, path, format }),

  /** Export the document as a PowerPoint deck (.pptx); returns a slide count + notes. */
  exportPptx: (document: Document, path: string) =>
    invoke<PptxReport>("export_pptx", { document, path }),

  saveDocumentJson: (document: Document, path: string) =>
    invoke<void>("save_document_json", { document, path }),

  openDocumentJson: (path: string) =>
    invoke<OpenedDocument>("open_document_json", { path }),

  getSettings: () => invoke<Settings>("get_settings"),

  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings", { settings }),

  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),

  hasApiKey: () => invoke<boolean>("has_api_key"),

  deleteApiKey: () => invoke<void>("delete_api_key"),

  /** "Zero external transmission" visibility (開発.txt Stage 2, item 2-2):
   * counts of actual LLM calls and reference/image fetches this session. */
  getNetworkStats: () => invoke<NetworkStats>("get_network_stats"),

  aiProcess: (request: AiRequest) =>
    invoke<string>("ai_process", { request }),

  /** Streaming variant; `onDelta` gets the full accumulated text, resolves with final. */
  aiProcessStream: (request: AiRequest, onDelta: (text: string) => void) => {
    const channel = new Channel<string>();
    channel.onmessage = onDelta;
    return invoke<string>("ai_process_stream", { request, onDelta: channel });
  },

  /**
   * Ghost-text inline completion (開発.txt Stage 2, item 2-4): stream a short
   * continuation of `prefix` (text immediately before the cursor), with an
   * optional cheap `contextHint` (e.g. section heading — never a full
   * document map). `onDelta` gets the full accumulated text; resolves with
   * the final text. Rejects (silently, per the caller's contract) when the
   * user's "limit to local model" privacy setting is on and the configured
   * endpoint isn't local.
   */
  aiGhostCompleteStream: (
    prefix: string,
    contextHint: string,
    onDelta: (text: string) => void
  ) => {
    const channel = new Channel<string>();
    channel.onmessage = onDelta;
    return invoke<string>("ai_ghost_complete_stream", {
      prefix,
      contextHint,
      onDelta: channel,
    });
  },

  /** Stream a draft; `onEvent` fires with live snapshots then the final document. */
  aiDraftStream: (
    theme: string,
    targetWords: number | undefined,
    reference: string | undefined,
    onEvent: (e: DraftEvent) => void
  ) => {
    const channel = new Channel<DraftEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_draft_stream", {
      theme,
      targetWords: targetWords ?? null,
      reference: reference ?? null,
      onEvent: channel,
    });
  },

  aiGenerateImage: (prompt: string) =>
    invoke<string>("ai_generate_image", { prompt }),

  aiGenerateDiagram: (text: string, instruction?: string) =>
    invoke<string>("ai_generate_diagram", {
      text,
      instruction: instruction ?? null,
    }),

  aiAnalyzeDocument: (document: Document) =>
    invoke<AnalysisResult>("ai_analyze_document", { document }),

  readReferenceFile: (path: string) =>
    invoke<string>("read_reference_file", { path }),

  fetchUrlText: (url: string) => invoke<string>("fetch_url_text", { url }),

  /**
   * Personal RAG (開発.txt Stage 3, item 3-1): add a local file (txt/md/rtf/
   * pdf) to the on-device personal knowledge base. Rejects if the setting is
   * off. Returns the number of passages indexed.
   */
  ragAddSource: (path: string) => invoke<number>("rag_add_source", { path }),

  /** Remove a previously added source's passages; returns the count removed. */
  ragRemoveSource: (path: string) =>
    invoke<number>("rag_remove_source", { path }),

  /** List every currently-indexed source (empty when the setting is off). */
  ragListSources: () => invoke<RagSourceInfo[]>("rag_list_sources"),

  /**
   * Search the personal knowledge base for the `topK` passages most similar
   * to `query`. Used both by the manual search/preview panel and by
   * `aiActions.ts`'s grounding-context assembly.
   */
  ragSearch: (query: string, topK: number) =>
    invoke<RagSearchHit[]>("rag_search", { query, topK }),

  // ----- Citation management (開発.txt Stage 3, item 3-2) -------------------
  // "Bring your own references and format them" — NOT a literature search
  // engine. The library is stored per-document (a JSON sidecar next to the
  // `.aix` file), so every call below takes `documentPath`: a document that
  // has never been saved has nowhere to keep one yet (see CitationsPanel.tsx's
  // empty state for how that's surfaced).

  /** Import a `.bib` file (chosen via a native file dialog) into the citation
   * library for `documentPath`, merging by BibTeX key (a re-import of the
   * same file replaces matching entries rather than duplicating them).
   * Returns the newly added entries plus any per-entry warnings (e.g. an
   * entry missing a required title was skipped). */
  citationsImportBibtex: (documentPath: string, bibPath: string) =>
    invoke<BibtexImportResult>("citations_import_bibtex", {
      documentPath,
      bibPath,
    }),

  /** List every citation entry currently imported for `documentPath` (empty
   * if nothing has been imported yet — not an error). */
  citationsList: (documentPath: string) =>
    invoke<CitationEntry[]>("citations_list", { documentPath }),

  /** Add one entry (manually filled in) to the library. */
  citationsAddEntry: (documentPath: string, entry: CitationEntry) =>
    invoke<CitationEntry>("citations_add_entry", { documentPath, entry }),

  /** Convert a lookup result into a full entry (assigning it a fresh id) and
   * add it to the library in one step — the common "look up, then add as-is"
   * path. `key` becomes the entry's display key (the DOI or arXiv id). */
  citationsAddLookupResult: (
    documentPath: string,
    result: CitationLookupResult,
    key: string
  ) =>
    invoke<CitationEntry>("citations_add_lookup_result", {
      documentPath,
      result,
      key,
    }),

  /** Remove one citation entry by id; resolves true if an entry was actually removed. */
  citationsRemoveEntry: (documentPath: string, entryId: string) =>
    invoke<boolean>("citations_remove_entry", { documentPath, entryId }),

  /** Look up a DOI via the free CrossRef REST API for auto-filling a new
   * citation entry. Does not add it to the library — review, then call
   * `citationsAddLookupResult`. */
  citationsLookupDoi: (doi: string) =>
    invoke<CitationLookupResult>("citations_lookup_doi", { doi }),

  /** Look up an arXiv id via the arXiv Atom API. */
  citationsLookupArxiv: (arxivId: string) =>
    invoke<CitationLookupResult>("citations_lookup_arxiv", { arxivId }),

  /** Format one citation entry in the given style. `index` is this entry's
   * 1-based position in the bibliography being built (IEEE's numbered-bracket
   * style needs it; APA ignores it). */
  citationsFormat: (
    documentPath: string,
    entryId: string,
    style: CitationStyleName,
    index: number
  ) =>
    invoke<string>("citations_format", {
      documentPath,
      entryId,
      style,
      index,
    }),

  /** Build an end-of-document bibliography/references list from the given
   * entry ids (the ones actually cited), in the given style. */
  citationsBibliography: (
    documentPath: string,
    entryIds: string[],
    style: CitationStyleName
  ) =>
    invoke<string[]>("citations_bibliography", {
      documentPath,
      entryIds,
      style,
    }),

  /** Start read-aloud; resolves with an utterance id matched by the `speech-done` event (UI3). */
  speakText: (text: string, voice?: string) =>
    invoke<number>("speak_text", { text, voice: voice ?? null }),

  stopSpeaking: () => invoke<void>("stop_speaking"),

  // Session autosave / crash recovery (A2).
  saveSession: (session: SessionData) => invoke<void>("save_session", { session }),
  loadSession: () => invoke<SessionData | null>("load_session"),
  clearSession: () => invoke<void>("clear_session"),

  /** Quit the whole app (Cmd+Q). Window close only hides the window (macOS). */
  quitApp: () => invoke<void>("quit_app"),
};
