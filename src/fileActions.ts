// File menu orchestration. The dialog plugin only picks paths; the actual
// read/write happens in Rust (commands.rs).

import { open, save } from "@tauri-apps/plugin-dialog";
import { aiReady } from "./aiActions";
import { localizeAiError } from "./aiErrors";
import { askUnsaved } from "./confirm";
import { draftDoneMessage, draftLengthWarning, draftProgressLabel, measureDraft } from "./draftLength";
import { samePath } from "./folderTree";
import { api } from "./api";
import { resolveImageSource } from "./localImages";
import { localizeExportWarning } from "./exportWarnings";
import { localizeImageError } from "./imageErrors";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { renderMermaidToPng } from "./mermaidRender";
import { tf, tNow, uiLangFor } from "./i18n";
import { captureOp, ownsOp, useStore, type OpTicket } from "./store";
import type { Document, ExportFormat } from "./types";

const NATIVE_EXT = "aix";

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * TS is the single owner of the Markdown → chunk projection in the GUI
 * (BUG-019d): a Markdown import from Rust is re-projected with
 * markdownToDocument (images, frontmatter) before it is shown. Pure.
 */
function projectMarkdownImport(doc: Document): Document {
  if (doc.mode !== "markdown" || doc.markdownSource === undefined) return doc;
  return markdownToDocument({ ...doc, chunks: [] }, doc.markdownSource);
}

/**
 * The payload for writing a .md file: the TS merge serializer's text in
 * markdown mode, so Rust `document_to_md` writes exactly it (BUG-019b).
 */
function markdownSavePayload(doc: Document): Document {
  return { ...doc, mode: "markdown", markdownSource: documentToMarkdown(doc) };
}

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * After a save or a tab close, if no tab has unsaved changes any more, drop the
 * crash-recovery session so it isn't offered on next launch (A2). Called from
 * the save paths and from requestCloseTab (so a discarded document is not
 * offered for restore after a crash — BUG-018); the startup-restore race is
 * avoided because we never clear during startup. The call is serialized with
 * autosaves by api.ts's session queue.
 */
function clearSessionIfAllSaved(): void {
  const st = useStore.getState();
  const dirtyLeft = st.dirty || Object.values(st.inactiveTabs).some((t) => t.dirty);
  if (!dirtyLeft) void api.clearSession().catch(() => {});
}

/**
 * Personal RAG (開発.txt Stage 3, item 3-1) auto-accumulation (Q11/Q16): after
 * a successful save, push every chunk the user has marked `metadata.confirmed`
 * (with non-empty content) into the on-device personal library, keyed by a
 * stable per-chunk synthetic path derived from the just-saved document path —
 * so re-saving an edited confirmed chunk updates its indexed passages rather
 * than duplicating them (`rag_sync_confirmed_chunks`/`Index::add_source`'s
 * existing replace-not-accumulate behavior).
 *
 * Mirrors `aiActions.ts::gatherRagSnippets`'s zero-overhead-when-disabled
 * pattern: the setting check happens before assembling anything, so a
 * document with confirmed chunks costs nothing extra on save while the
 * setting is off — but for symmetry with `rag_sync_confirmed_chunks` (which
 * ALSO no-ops when the setting is off) this is a belt-and-suspenders guard,
 * not the only one. Best-effort: any failure (index error, model not ready)
 * is swallowed with an "info" notice rather than treated as a failed save —
 * the document is already safely on disk by the time this runs.
 */
export async function syncConfirmedChunksToRag(doc: Document, path: string): Promise<void> {
  const s = useStore.getState();
  if (!s.settings?.personalRagEnabled) return;

  const pairs: Array<[string, string]> = doc.chunks
    .filter((c) => c.metadata.confirmed && c.content.trim())
    .map((c) => [c.id, c.content]);
  if (pairs.length === 0) return;

  try {
    await api.ragSyncConfirmedChunks(path, pairs);
  } catch (e) {
    useStore.getState().notify(
      tf("Saved, but couldn't update your personal library: {error}", { error: message(e) }),
      "info"
    );
  }
}

function safeName(title: string): string {
  const base = title.trim() || "Untitled";
  return base.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * True if the active tab is an untouched, idle blank document we can reuse.
 */
function activeIsPristine(): boolean {
  const s = useStore.getState();
  const c = s.doc.chunks;
  return (
    (s.doc.mode ?? "editor") !== "slide" &&
    !s.dirty &&
    !s.filePath &&
    c.length === 1 &&
    !c[0].content.trim() &&
    // A tab with an AI op in flight is never reused (BUG-001c): its late
    // results are routed by tab id, so a document loaded into it would be
    // overwritten.
    !s.globalBusy &&
    Object.keys(s.busyChunks).length === 0 &&
    !s.streamingChunkId
  );
}

/** Open a document in a new tab (or reuse the current blank one). */
function openInTab(doc: Document, filePath: string | null, dirty = false): void {
  if (!activeIsPristine()) useStore.getState().newTab();
  useStore.getState().loadDocument(doc, filePath, { dirty });
}

/** The tab already showing the file at `path` (active or background), if any. */
export function tabIdForPath(path: string): string | null {
  const s = useStore.getState();
  if (s.filePath && samePath(s.filePath, path)) return s.activeTabId;
  for (const id of s.tabOrder) {
    const snap = s.inactiveTabs[id];
    if (id !== s.activeTabId && snap?.filePath && samePath(snap.filePath, path)) return id;
  }
  return null;
}

/** Bring an already-open file's tab forward instead of opening it twice. */
function focusExisting(path: string): boolean {
  const id = tabIdForPath(path);
  if (id === null) return false;
  useStore.getState().switchTab(id);
  useStore.getState().notify(tNow("Already open — switched to its tab."), "info");
  return true;
}

/**
 * Open one file at `path` in a new tab, dispatching by extension. Shared by
 * `openNative()` (the file picker) and the folder tree sidebar's file click —
 * ONE implementation, so the two surfaces can never drift on how a file gets
 * opened.
 */
export async function openPath(path: string): Promise<void> {
  // A file is open in at most one tab: opening it again switches to that tab
  // (its unsaved edits stay; nothing is re-read over them).
  if (focusExisting(path)) return;
  try {
    if (isMarkdownPath(path)) {
      const document = projectMarkdownImport(await api.importDocument(path));
      // Re-check: a second click may have opened it while this one was reading.
      if (focusExisting(path)) return;
      openInTab(document, path, false);
      useStore.getState().notify(tNow("Markdown document opened."), "success");
      return;
    }
    const { document, notes } = await api.openDocumentJson(path);
    if (focusExisting(path)) return;
    // If the file had to be repaired on load (A1), open it dirty so the cleaned
    // version can be saved back, and tell the user exactly what changed.
    openInTab(document, path, notes.length > 0);
    if (notes.length > 0) {
      useStore.getState().notify(tf("Opened and repaired this file: {notes}", { notes: notes.join(" ") }), "info");
    } else {
      useStore.getState().notify(tNow("Document opened."), "success");
    }
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  }
}

/** How a Draft attempt ended (BUG-014). `error` is localized ("" when there is
 *  nothing to show); `hadContent` says whether a draft tab was created. */
export type DraftOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not-ready" | "no-theme" | "busy" | "detached" | "failed";
      error: string;
      hadContent: boolean;
    };

/** A draft still waiting for its first content (at most one — double-submit
 *  guard). Once content arrives the draft owns a tab and its tab-scoped busy
 *  label takes over. */
let pendingDraft: { detached: boolean } | null = null;

/** Give up on the draft that is still waiting for its first content: its
 *  result is ignored and no tab is created. The backend request itself is not
 *  aborted (same as a chunk action's Stop). No-op once content has arrived. */
export function detachPendingDraft(): void {
  if (pendingDraft) pendingDraft.detached = true;
  pendingDraft = null;
}

// Progress label repaint interval: at most 4 updates per second (BUG-005c).
const DRAFT_PROGRESS_INTERVAL_MS = 250;

/**
 * Generate a fresh document draft on a theme, streaming it into the editor.
 *
 * The draft tab is created lazily on the FIRST content event (reusing the
 * active tab only if it is pristine and idle), so a failure before any content
 * leaves the tab set untouched (BUG-014) and there is no blank placeholder for
 * Open to hijack (BUG-001c). Updates are painted only while the draft still
 * owns the active tab; the final document is committed to its own tab, active
 * or background (BUG-005b). The achieved length is reported against the
 * target in the shared unit (BUG-005a); a miss beyond ±20%, or a failure after
 * partial content, also goes to the persistent export report.
 */
export async function draftDocument(
  theme: string,
  targetWords?: number,
  reference?: string,
  onFirstContent?: () => void
): Promise<DraftOutcome> {
  const s = useStore.getState();
  if (!aiReady()) {
    const error = tNow("Set your OpenRouter API key in Settings first.");
    s.notify(error, "error");
    s.openSettings();
    return { ok: false, reason: "not-ready", error, hadContent: false };
  }
  if (!theme.trim()) return { ok: false, reason: "no-theme", error: "", hadContent: false };
  if (pendingDraft) {
    return { ok: false, reason: "busy", error: tNow("A draft is already being generated."), hadContent: false };
  }
  const handle = { detached: false };
  pendingDraft = handle;
  const release = () => {
    if (pendingDraft === handle) pendingDraft = null;
  };
  const lang = () => uiLangFor(useStore.getState().settings?.defaultTargetLanguage);

  let op: OpTicket | null = null; // set once the draft owns a tab
  let settled = false;
  let lastPaint = -Infinity;
  const ensureTab = (): OpTicket => {
    if (op) return op;
    if (!activeIsPristine()) useStore.getState().newTab();
    const ticket = captureOp();
    op = ticket;
    release();
    // B3: the busy label is scoped to the draft's own tab.
    useStore.getState().setGlobalBusy(tNow("Drafting…"), ticket.tabId);
    onFirstContent?.();
    return ticket;
  };

  try {
    await api.aiDraftStream(theme.trim(), targetWords, reference, (e) => {
      if (handle.detached) return;
      // After the invoke settled: never create a tab (the outcome was already
      // reported as empty/failed) and never re-set a cleared busy label.
      if (settled && (!op || e.kind === "update")) return;
      const ticket = ensureTab();
      if (e.kind === "update") {
        if (!ownsOp(ticket)) return; // backgrounded or replaced: don't paint elsewhere
        useStore.getState().setStreamingDocument(e.document); // marks the tab dirty
        const now = Date.now();
        if (now - lastPaint >= DRAFT_PROGRESS_INTERVAL_MS) {
          lastPaint = now;
          const label = draftProgressLabel(measureDraft(e.document.chunks, targetWords), lang());
          useStore.getState().setGlobalBusy(label, ticket.tabId);
        }
      } else if (e.kind === "done") {
        // B2: a fresh AI draft is unsaved & irreproducible — committed dirty.
        if (!useStore.getState().commitDraftToTab(ticket.tabId, ticket.docNonce, e.document)) return;
        const m = measureDraft(e.document.chunks, targetWords);
        useStore.getState().notify(draftDoneMessage(m, e.document.chunks.length, lang()), "success");
        const warning = draftLengthWarning(m, lang());
        if (warning) useStore.getState().setLastExportReport("draft", [warning]);
      }
    });
    settled = true;
    if (handle.detached) return { ok: false, reason: "detached", error: "", hadContent: false };
    if (!op) {
      // Empty streams fail loudly (rust.md rule 8) — nothing was created.
      const error = tNow("The model returned an empty response. Try again, or switch models in Settings.");
      return { ok: false, reason: "failed", error, hadContent: false };
    }
    return { ok: true };
  } catch (e) {
    settled = true;
    if (handle.detached) return { ok: false, reason: "detached", error: "", hadContent: false };
    const loc = localizeAiError(message(e), lang());
    if (loc.kind === "model-unavailable" && loc.model) {
      useStore.getState().setAiModelIssue({ model: loc.model });
    }
    const draftTab = (op as OpTicket | null)?.tabId;
    if (draftTab !== undefined) {
      // The dialog has closed; the partial draft stays (dirty) in its tab —
      // unless the user already closed that tab, so the report can't say so.
      useStore.getState().notify(loc.text, "error");
      if (useStore.getState().tabOrder.includes(draftTab)) {
        useStore.getState().setLastExportReport("draft", [
          tf("The draft stopped before it finished: {error} The partial draft is kept in its tab (unsaved).", {
            error: loc.text,
          }),
        ]);
      }
    }
    return { ok: false, reason: "failed", error: loc.text, hadContent: draftTab !== undefined };
  } finally {
    release();
    // `op` is assigned inside the stream callback; TS can't see that here.
    const ticket = op as OpTicket | null;
    if (ticket) useStore.getState().setGlobalBusy(null, ticket.tabId);
  }
}

export async function importDocument(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: tNow("Text documents"), extensions: ["txt", "md", "markdown", "rtf"] },
      ],
    });
    if (typeof selected !== "string") return;
    const doc = projectMarkdownImport(await api.importDocument(selected));
    openInTab(doc, null, true); // imported doc has no .aix backing → dirty (B2)
    useStore.getState().notify(tNow("Document imported."), "success");
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  }
}

/**
 * File-picker entry point for inserting a local image (v1 "No.1" priority
 * feature): open a native file dialog filtered to image extensions, read the
 * chosen file via the Rust `read_local_image` command (the webview never
 * reads disk directly), and insert it as an image chunk after `chunkId` (or
 * at the end when `chunkId` is null). The other two entry points — drag-drop
 * and paste — read the in-memory File/Blob client-side instead, since that
 * content already arrived in the browser and isn't a disk path.
 */
export async function pickAndInsertLocalImage(chunkId: string | null): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: tNow("Images"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
      ],
    });
    if (typeof selected !== "string") return;
    const dataUrl = await api.readLocalImage(selected);
    const fileName = selected.split(/[/\\]/).pop() ?? "";
    useStore.getState().insertLocalImageAfter(chunkId, dataUrl, fileName);
    useStore.getState().notify(tNow("Image inserted."), "success");
  } catch (e) {
    const lang = uiLangFor(useStore.getState().settings?.defaultTargetLanguage);
    useStore.getState().notify(localizeImageError(message(e), lang), "error");
  }
}

/**
 * Snapshot every diagram chunk's rendered graph into `metadata.renderedImage`
 * (a 2x PNG data URL) on a clone of the document, for EXPORT payloads only —
 * the editor's own document is never mutated. Rust embeds the PNG in RTF/PPTX;
 * a chunk whose render fails is left untouched (Rust warns + falls back).
 */
async function withRenderedDiagrams(doc: Document): Promise<Document> {
  const chunks = [...doc.chunks];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.metadata.chunkType !== "diagram" || !c.content.trim()) continue;
    const png = await renderMermaidToPng(c.content, { scale: 2, background: "white" });
    if (!png) continue;
    chunks[i] = { ...c, metadata: { ...c.metadata, renderedImage: png } };
  }
  return { ...doc, chunks };
}

/**
 * Inline every image chunk that references a local file (a path relative to
 * the document's folder, an absolute path or a `file:` URL) as a data URL, on
 * a clone of the document, for EXPORT payloads only — the editor's own
 * document is never mutated. Uses the SAME resolver as the preview
 * (`resolveImageSource` + Rust `read_local_image`), so preview and export
 * agree on which file a figure is. A figure that can't be read is left as-is:
 * the PPTX exporter reports it as a local image that couldn't be read (G11),
 * and the RTF exporter keeps an "[Image: …]" placeholder and counts it in its
 * `RtfReport` (fileio.rs), whose warnings land on the health bar's report.
 */
async function withEmbeddedLocalImages(doc: Document, filePath: string | null): Promise<Document> {
  const chunks = [...doc.chunks];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.metadata.chunkType !== "image") continue;
    const src = resolveImageSource(c.content, filePath);
    if (src.kind !== "local") continue;
    try {
      chunks[i] = { ...c, content: await api.readLocalImage(src.path) };
    } catch {
      // Left unresolved: pptx.rs and fileio.rs (RTF) each count it under
      // their own specific "local image(s) couldn't be read" warning.
    }
  }
  return { ...doc, chunks };
}

/**
 * Export to PDF: the native save dialog picks a `.pdf` path, Rust renders an
 * A4 PDF with an embedded system Unicode font (CJK included — see pdf.rs) and
 * writes it atomically. What the PDF cannot carry (images → text placeholders,
 * diagrams → source text, literal Markdown markup) comes back as counted
 * warnings that stay on the health bar's export report. There is no print
 * dialog: printing from the webview is a separate, planned command.
 */
export async function exportPdf(): Promise<void> {
  const s = useStore.getState();
  try {
    const path = await save({
      defaultPath: `${safeName(s.doc.title)}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return;
    const report = await api.exportPdf(s.doc, path);
    s.setLastExportReport("pdf", report.warnings);
    s.notify(tNow("Exported as PDF."), "success");
  } catch (e) {
    s.notify(message(e), "error");
  }
}

export async function exportDocument(format: ExportFormat): Promise<void> {
  const s = useStore.getState();
  try {
    const path = await save({
      defaultPath: `${safeName(s.doc.title)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    // RTF embeds diagram snapshots and PNG/JPEG figures (fileio.rs
    // rtf_picture_group), so document-relative figures are inlined the same
    // way PPTX does it; txt is placeholder-by-design and md keeps the mermaid
    // fences and figure references, so neither needs these (costly) passes.
    const payload =
      format === "rtf"
        ? await withEmbeddedLocalImages(await withRenderedDiagrams(s.doc), s.filePath)
        : s.doc;
    // RTF returns its lossy report (fileio.rs RtfReport); txt/md return null.
    const report = await api.exportDocument(payload, path, format);
    s.setLastExportReport(format, report?.warnings ?? []);
    s.notify(tf("Exported as {format}.", { format: format.toUpperCase() }), "success");
  } catch (e) {
    s.notify(message(e), "error");
  }
}

/**
 * Export the document as a PowerPoint deck (.pptx). The document is turned into
 * slides on the Rust side (headings → slides, paragraphs → bullets, images
 * embedded); this picks the destination path and prepares the payload
 * (diagram snapshots, local figures inlined from the document's folder).
 */
export async function exportPptx(): Promise<void> {
  const s = useStore.getState();
  try {
    const path = await save({
      defaultPath: `${safeName(s.doc.title)}.pptx`,
      filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
    });
    if (!path) return;
    // Snapshot diagrams to PNG so the deck embeds real graphs (ズレ① FE half).
    // Inline document-relative figures the preview shows (G11).
    const payload = await withEmbeddedLocalImages(
      await withRenderedDiagrams(s.doc),
      s.filePath
    );
    const report = await api.exportPptx(payload, path);
    // Keep the warnings reviewable in the health bar (提案2) — a toast alone
    // disappears in seconds and silently-lost content was the report's core
    // complaint (ズレ①).
    s.setLastExportReport("pptx", report.warnings);
    const done = tf("Exported {n} slide(s) as PPTX.", { n: report.slides });
    if (report.warnings.length > 0) {
      const lang = uiLangFor(useStore.getState().settings?.defaultTargetLanguage);
      const warnings = report.warnings.map((w) => localizeExportWarning(w, lang));
      s.notify(`${done} ${warnings.join(" ")}`, "info");
    } else {
      s.notify(done, "success");
    }
  } catch (e) {
    s.notify(message(e), "error");
  }
}

export async function openNative(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: tNow("NurumayuEditor documents"), extensions: [NATIVE_EXT, "md", "markdown"] },
      ],
    });
    if (typeof selected !== "string") return;
    await openPath(selected);
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  }
}

/** Open Folder…: pick a directory and show it in the folder tree sidebar. */
export async function openFolder(): Promise<void> {
  try {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected !== "string") return;
    const s = useStore.getState();
    s.setFolderRoot(selected);
    s.toggleFolderTree(true);
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  }
}

/**
 * Save the ACTIVE tab under a path picked in the save dialog. Resolves true
 * only once the file is written and the tab marked clean; false when the
 * dialog is cancelled, the path is open in another tab, the write fails
 * (failures are still reported as a toast), or the tab was closed/reloaded
 * during the write. Close/quit rely on this outcome.
 *
 * state-async-3: the save is pinned to the tab + load it started on (an
 * OpTicket); the tab bar stays live during the write, so the clean mark is
 * routed to THAT tab (markTabClean), never to whichever tab is active when
 * the write resolves.
 */
export async function saveNativeAs(): Promise<boolean> {
  const s = useStore.getState();
  const ticket = captureOp();
  let saved = false;
  try {
    // Both formats are always offered — Save is no longer locked to .aix for
    // Editor/Slide-mode docs — but the DEFAULT (pre-selected filter and
    // suggested filename) still follows the doc's mode, preserving today's
    // one-click behavior for anyone who doesn't change it.
    const markdownDefault = (s.doc.mode ?? "editor") === "markdown";
    const nativeFilter = { name: tNow("NurumayuEditor Document"), extensions: [NATIVE_EXT] };
    const markdownFilter = { name: "Markdown", extensions: ["md", "markdown"] };
    const path = await save({
      defaultPath: `${safeName(s.doc.title)}.${markdownDefault ? "md" : NATIVE_EXT}`,
      filters: markdownDefault ? [markdownFilter, nativeFilter] : [nativeFilter, markdownFilter],
    });
    if (!path) return false;
    // One file, one tab: writing over a file another tab has open would leave
    // two tabs claiming it (and the other's next save would silently win).
    const holder = tabIdForPath(path);
    if (holder !== null && holder !== ticket.tabId) {
      s.notify(tNow("That file is open in another tab. Close that tab first, or save under a different name."), "error");
      return false;
    }
    // Capture the exact document being written — the save is awaited without
    // blocking the editor, so `useStore.getState().doc` could advance (another
    // keystroke) before this resolves. markTabClean anchors the new baseline
    // to what actually reached disk, not to whatever is live when it returns.
    const written = s.doc;
    // Which format to WRITE is decided by the extension the user actually
    // chose, not by mode — that's what makes Save As able to write .md for a
    // non-Markdown-mode document (rust.md rule 4 / CLAUDE.md invariant 5:
    // this is a lossy, one-way conversion for those modes — mode and any
    // slide-only metadata don't round-trip — so it's reported as a warning on
    // the persistent health-bar surface, not silently degraded).
    const savingAsMarkdown = isMarkdownPath(path);
    if (savingAsMarkdown) {
      await api.exportDocument(markdownSavePayload(written), path, "md");
      if ((written.mode ?? "editor") !== "markdown") {
        s.setLastExportReport("md", [
          "Saved as Markdown — view mode and any slide-only details won't round-trip; reopening this file will load it as a Markdown document.",
        ]);
      }
    } else {
      await api.saveDocumentJson(written, path);
    }
    if (!useStore.getState().markTabClean(ticket.tabId, ticket.docNonce, path, written)) return false;
    saved = true;
    clearSessionIfAllSaved();
    s.notify(tNow("Document saved."), "success");
    await syncConfirmedChunksToRag(written, path);
  } catch (e) {
    s.notify(message(e), "error");
  }
  return saved;
}

/**
 * Whether saving `doc` would write exactly what the last save (or open) did —
 * compared in the format actually written, so e.g. a Markdown file is
 * unchanged when its Markdown is, whatever the in-memory chunk ids.
 */
export function unchangedSinceSave(doc: Document, savedDoc: Document | null, asMarkdown: boolean): boolean {
  if (!savedDoc) return false;
  if (doc === savedDoc) return true;
  return asMarkdown
    ? documentToMarkdown(doc) === documentToMarkdown(savedDoc)
    : JSON.stringify(doc) === JSON.stringify(savedDoc);
}

/**
 * Save the ACTIVE tab to its file (Save As when it has none). Same outcome
 * contract as saveNativeAs: true only after the write and the routed clean
 * mark on the tab + load the save started on (state-async-3).
 */
export async function saveNative(): Promise<boolean> {
  const s = useStore.getState();
  const path = s.filePath;
  if (!path) return saveNativeAs();
  const ticket = captureOp();
  let saved = false;
  try {
    const written = s.doc;
    // Saving again with nothing changed still writes (the file on disk stays
    // authoritative), but quietly: "Document saved." only when it says news.
    const unchanged = unchangedSinceSave(written, s.savedDoc, isMarkdownPath(path));
    if (isMarkdownPath(path)) {
      await api.exportDocument(markdownSavePayload(written), path, "md");
    } else {
      await api.saveDocumentJson(written, path);
    }
    if (!useStore.getState().markTabClean(ticket.tabId, ticket.docNonce, undefined, written)) return false;
    saved = true;
    clearSessionIfAllSaved();
    if (!unchanged) s.notify(tNow("Document saved."), "success");
    await syncConfirmedChunksToRag(written, path);
  } catch (e) {
    s.notify(message(e), "error");
  }
  return saved;
}

/** Dirty flag and title of a tab, active or in the background. */
function tabState(id: string): { open: boolean; dirty: boolean; title: string } {
  const st = useStore.getState();
  if (id === st.activeTabId) return { open: true, dirty: st.dirty, title: st.doc.title };
  const snap = st.inactiveTabs[id];
  return snap
    ? { open: true, dirty: !!snap.dirty, title: snap.doc.title }
    : { open: false, dirty: false, title: "" };
}

/**
 * Resolve a tab's unsaved changes before it goes away (BUG-011). True means it
 * is safe to proceed: the tab is clean (no dialog), the user chose Don't Save,
 * or Save succeeded. False on Cancel / a dismissed dialog, or when the save
 * did not complete (Save As cancelled, refused, or the write failed) — the
 * tab then stays open and dirty. Saving a background tab switches to it first,
 * since the save functions act on the active tab.
 */
export async function resolveDirtyTab(id: string, scope: "tab" | "quit" = "tab"): Promise<boolean> {
  const before = tabState(id);
  if (!before.open || !before.dirty) return true;
  const choice = await askUnsaved(scope, before.title);
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  // The tab may have been closed while the dialog was up: nothing to save.
  if (!tabState(id).open) return false;
  if (useStore.getState().activeTabId !== id) useStore.getState().switchTab(id);
  return saveNative();
}

/**
 * The single close path for the tab X, ⌘W and the palette's Close tab
 * (BUG-018): resolve unsaved work, close (the last tab is replaced by a fresh
 * untitled one), then drop the crash-recovery session if nothing dirty is
 * left. Resolves false when the tab stays open.
 */
export async function requestCloseTab(id: string): Promise<boolean> {
  if (!(await resolveDirtyTab(id, "tab"))) return false;
  useStore.getState().closeTab(id);
  clearSessionIfAllSaved();
  return true;
}

/**
 * ⌘Q review (BUG-011): ask about each dirty tab in tab order, like macOS
 * "Review changes", and stop at the first Cancel or failed save. True when
 * the quit may proceed. Tabs answered Don't Save stay open (and dirty) if a
 * later tab cancels the quit.
 *
 * state-async-5: the tab list is re-read after every dialog, so a tab created
 * or dirtied while a dialog was up (e.g. a Draft's first content) is asked
 * about too. Each tab is asked at most once per quit.
 */
export async function resolveDirtyTabsForQuit(): Promise<boolean> {
  const asked = new Set<string>();
  for (;;) {
    const id = useStore
      .getState()
      .tabOrder.find((t) => !asked.has(t) && tabState(t).dirty);
    if (id === undefined) return true;
    asked.add(id);
    if (!(await resolveDirtyTab(id, "quit"))) return false;
  }
}
