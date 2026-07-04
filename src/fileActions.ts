// File menu orchestration. The dialog plugin only picks paths; the actual
// read/write happens in Rust (commands.rs).

import { open, save } from "@tauri-apps/plugin-dialog";
import { aiReady } from "./aiActions";
import { api } from "./api";
import { renderMermaidToPng, renderMermaidToSvg } from "./mermaidRender";
import { useStore } from "./store";
import type { Document, ExportFormat } from "./types";

const NATIVE_EXT = "aix";

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * After a save, if no tab has unsaved changes any more, drop the crash-recovery
 * session so it isn't offered on next launch (A2). Called from the save paths so
 * saving your work clears the "restore?" prompt; the startup-restore race is
 * avoided because we never clear during startup.
 */
function clearSessionIfAllSaved(): void {
  const st = useStore.getState();
  const dirtyLeft = st.dirty || Object.values(st.inactiveTabs).some((t) => t.dirty);
  if (!dirtyLeft) void api.clearSession().catch(() => {});
}

function safeName(title: string): string {
  const base = title.trim() || "Untitled";
  return base.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * True if the active tab is an untouched blank EDITOR document we can reuse.
 * Slide-mode tabs are never reused for opened/imported/drafted (editor) content,
 * so a tab's mode stays fixed for its lifetime.
 */
function activeIsPristine(): boolean {
  const s = useStore.getState();
  const c = s.doc.chunks;
  return (
    (s.doc.mode ?? "editor") === "editor" &&
    !s.dirty &&
    !s.filePath &&
    c.length === 1 &&
    !c[0].content.trim()
  );
}

/** Open a document in a new tab (or reuse the current blank one). */
function openInTab(doc: Document, filePath: string | null, dirty = false): void {
  if (!activeIsPristine()) useStore.getState().newTab();
  useStore.getState().loadDocument(doc, filePath, { dirty });
}

/**
 * Generate a fresh document draft on a theme into a new tab, streaming the
 * result into the editor in real time.
 */
export async function draftDocument(
  theme: string,
  targetWords?: number,
  reference?: string
): Promise<void> {
  const s = useStore.getState();
  if (!aiReady()) {
    s.notify("Set your OpenRouter API key in Settings first.", "error");
    s.openSettings();
    return;
  }
  if (!theme.trim()) return;
  // Draft into a new tab (reuse a blank one) so current work is preserved.
  if (!activeIsPristine()) useStore.getState().newTab();
  // Stream only while the draft's own tab stays active (the user may switch).
  const draftTab = useStore.getState().activeTabId;
  const onDraftTab = () => useStore.getState().activeTabId === draftTab;
  // B3: scope the busy spinner to the draft's own tab, so switching away during
  // generation doesn't strand a "Drafting…" spinner (which would also trip the
  // Analyze/Draft busy guards) on that tab or clear the foreground tab's spinner.
  useStore.getState().setGlobalBusy("Drafting…", draftTab);
  try {
    await api.aiDraftStream(theme.trim(), targetWords, reference, (e) => {
      if (!onDraftTab()) return; // user switched tabs — don't write elsewhere
      if (e.kind === "update") {
        useStore.getState().setStreamingDocument(e.document);
      } else if (e.kind === "done") {
        // B2: a fresh AI draft is unsaved & irreproducible — mark it dirty so the
        // tab/quit guards protect it.
        useStore.getState().loadDocument(e.document, null, { dirty: true });
      }
    });
    if (onDraftTab()) {
      const n = useStore.getState().doc.chunks.length;
      useStore.getState().notify(`Draft created — ${n} chunks.`, "success");
    }
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  } finally {
    useStore.getState().setGlobalBusy(null, draftTab);
  }
}

export async function importDocument(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Text documents", extensions: ["txt", "md", "markdown", "rtf"] },
      ],
    });
    if (typeof selected !== "string") return;
    const doc = await api.importDocument(selected);
    openInTab(doc, null, true); // imported doc has no .aix backing → dirty (B2)
    useStore.getState().notify("Document imported.", "success");
  } catch (e) {
    useStore.getState().notify(message(e), "error");
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build a clean, print-ready HTML document from the current document. */
async function buildPrintHtml(doc: Document): Promise<string> {
  const parts: string[] = [];
  for (const c of doc.chunks) {
    const type = c.metadata.chunkType;
    if (type === "heading") {
      const lv = Math.min(Math.max(c.metadata.level ?? 1, 1), 3);
      parts.push(`<h${lv}>${escapeHtml(c.content)}</h${lv}>`);
    } else if (type === "image") {
      const cap = c.metadata.summary
        ? `<figcaption>${escapeHtml(c.metadata.summary)}</figcaption>`
        : "";
      if (c.content) parts.push(`<figure><img src="${c.content}" />${cap}</figure>`);
    } else if (type === "diagram") {
      // Reuse the already-rendered Mermaid SVG from the live DOM when present;
      // for unmounted chunks (backgrounded slide, virtualized view) render it
      // off-screen instead — the raw source <pre> is only a last resort.
      const live = document.querySelector(`#chunk-${c.id} svg`);
      if (live) {
        parts.push(`<figure class="diagram">${live.outerHTML}</figure>`);
      } else {
        const svg = c.content.trim() ? await renderMermaidToSvg(c.content) : null;
        if (svg) parts.push(`<figure class="diagram">${svg}</figure>`);
        else parts.push(`<pre>${escapeHtml(c.content)}</pre>`);
      }
    } else {
      // text
      parts.push(`<p>${escapeHtml(c.content)}</p>`);
    }
  }
  const body = parts.join("\n");

  const title = escapeHtml(doc.title.trim() || "Untitled");
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  @page { margin: 20mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Hiragino Mincho ProN", "Yu Mincho", serif;
         color: #1a1a1a; line-height: 1.8; max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 1.4em 0 .5em; }
  h2 { font-size: 1.5rem; margin: 1.2em 0 .4em; }
  h3 { font-size: 1.2rem; margin: 1em 0 .3em; }
  p { margin: 0 0 1em; white-space: pre-wrap; word-break: break-word; }
  figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
  figure img { max-width: 100%; }
  figure.diagram svg { max-width: 100%; height: auto; }
  figcaption { font-size: .85rem; color: #666; font-style: italic; margin-top: .4em; }
  pre { background: #f6f6f6; padding: .8em; border-radius: 6px; overflow-x: auto;
        white-space: pre-wrap; font-size: .85rem; }
</style></head>
<body>${doc.title.trim() ? `<h1>${title}</h1>` : ""}${body}</body></html>`;
}

/**
 * Export to PDF via the OS print dialog ("Save as PDF"). Printing through the
 * webview lets the OS handle font rendering — crucially for CJK text, which
 * pure-Rust PDF generators render as missing glyphs.
 */
export async function exportPdf(): Promise<void> {
  const s = useStore.getState();
  try {
    const html = await buildPrintHtml(s.doc);
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    Object.assign(iframe.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "0",
      height: "0",
      border: "0",
    });
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument;
    const iwin = iframe.contentWindow;
    if (!idoc || !iwin) {
      iframe.remove();
      s.notify("Could not prepare the PDF view.", "error");
      return;
    }
    idoc.open();
    idoc.write(html);
    idoc.close();

    // Wait for images (data/remote URLs) to settle so they aren't clipped, then
    // print. Clean the iframe up after printing (or after a safety timeout).
    const imgs = Array.from(idoc.images);
    await Promise.race([
      Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((res) => {
                img.onload = () => res();
                img.onerror = () => res();
              })
        )
      ),
      new Promise<void>((res) => setTimeout(res, 2500)),
    ]);

    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      setTimeout(() => iframe.remove(), 500);
    };
    iwin.onafterprint = cleanup;
    iwin.focus();
    iwin.print();
    setTimeout(cleanup, 60000); // safety net if onafterprint never fires
    s.notify('Choose "Save as PDF" in the print dialog.', "info");
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
    // RTF embeds diagram snapshots (PNG); txt is placeholder-by-design and md
    // keeps the mermaid fences, so neither needs the (costly) render pass.
    const payload = format === "rtf" ? await withRenderedDiagrams(s.doc) : s.doc;
    await api.exportDocument(payload, path, format);
    s.setLastExportReport(format, []);
    s.notify(`Exported as ${format.toUpperCase()}.`, "success");
  } catch (e) {
    s.notify(message(e), "error");
  }
}

/**
 * Export the document as a PowerPoint deck (.pptx). The document is turned into
 * slides on the Rust side (headings → slides, paragraphs → bullets, images
 * embedded); this only picks the destination path.
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
    const payload = await withRenderedDiagrams(s.doc);
    const report = await api.exportPptx(payload, path);
    // Keep the warnings reviewable in the health bar (提案2) — a toast alone
    // disappears in seconds and silently-lost content was the report's core
    // complaint (ズレ①).
    s.setLastExportReport("pptx", report.warnings);
    if (report.warnings.length > 0) {
      s.notify(
        `Exported ${report.slides} slide(s) as PPTX. ${report.warnings.join(" ")}`,
        "info"
      );
    } else {
      s.notify(`Exported ${report.slides} slide(s) as PPTX.`, "success");
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
      filters: [{ name: "AIX Document", extensions: [NATIVE_EXT] }],
    });
    if (typeof selected !== "string") return;
    const { document, notes } = await api.openDocumentJson(selected);
    // If the file had to be repaired on load (A1), open it dirty so the cleaned
    // version can be saved back, and tell the user exactly what changed.
    openInTab(document, selected, notes.length > 0);
    if (notes.length > 0) {
      useStore.getState().notify(`Opened and repaired this file: ${notes.join(" ")}`, "info");
    } else {
      useStore.getState().notify("Document opened.", "success");
    }
  } catch (e) {
    useStore.getState().notify(message(e), "error");
  }
}

export async function saveNativeAs(): Promise<void> {
  const s = useStore.getState();
  try {
    const path = await save({
      defaultPath: `${safeName(s.doc.title)}.${NATIVE_EXT}`,
      filters: [{ name: "AIX Document", extensions: [NATIVE_EXT] }],
    });
    if (!path) return;
    await api.saveDocumentJson(s.doc, path);
    s.markClean(path);
    clearSessionIfAllSaved();
    s.notify("Document saved.", "success");
  } catch (e) {
    s.notify(message(e), "error");
  }
}

export async function saveNative(): Promise<void> {
  const s = useStore.getState();
  if (!s.filePath) {
    await saveNativeAs();
    return;
  }
  try {
    await api.saveDocumentJson(s.doc, s.filePath);
    s.markClean();
    clearSessionIfAllSaved();
    s.notify("Document saved.", "success");
  } catch (e) {
    s.notify(message(e), "error");
  }
}
