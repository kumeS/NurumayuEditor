import { beforeEach, describe, expect, it, vi } from "vitest";

// `syncConfirmedChunksToRag` calls `api.ragSyncConfirmedChunks` (Tauri IPC) —
// mocked here so this stays a hermetic, fast unit test, and so the
// "zero-overhead-when-disabled" / "only confirmed+non-empty chunks reach the
// call" assertions below can inspect exactly what was sent. The open/save
// paths below need the rest of the Tauri surface (dialog + document IPC)
// mocked the same way.
const ragSyncConfirmedChunks = vi.fn();
const importDocument = vi.fn();
const openDocumentJson = vi.fn();
const exportDocument = vi.fn();
const saveDocumentJson = vi.fn();
const exportPdfApi = vi.fn();
const exportPptxApi = vi.fn();
const readLocalImage = vi.fn();
vi.mock("./api", () => ({
  api: {
    exportPdf: (...args: unknown[]) => exportPdfApi(...args),
    exportPptx: (...args: unknown[]) => exportPptxApi(...args),
    readLocalImage: (...args: unknown[]) => readLocalImage(...args),
    ragSyncConfirmedChunks: (...args: unknown[]) => ragSyncConfirmedChunks(...args),
    importDocument: (...args: unknown[]) => importDocument(...args),
    openDocumentJson: (...args: unknown[]) => openDocumentJson(...args),
    exportDocument: (...args: unknown[]) => exportDocument(...args),
    saveDocumentJson: (...args: unknown[]) => saveDocumentJson(...args),
    clearSession: (...args: unknown[]) => clearSession(...args),
  },
}));
// Always returns a promise: clearSessionIfAllSaved chains .catch on it.
const clearSession = vi.fn((..._args: unknown[]) => Promise.resolve());

const dialogOpen = vi.fn();
const dialogSave = vi.fn();
const dialogMessage = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
  save: (...args: unknown[]) => dialogSave(...args),
  message: (...args: unknown[]) => dialogMessage(...args),
}));

import {
  exportDocument as exportDocumentAction,
  exportPdf,
  exportPptx,
  importDocument as importDocumentAction,
  openFolder,
  openNative,
  openPath,
  requestCloseTab,
  resolveDirtyTabsForQuit,
  saveNative,
  saveNativeAs,
  syncConfirmedChunksToRag,
  tabIdForPath,
  unchangedSinceSave,
} from "./fileActions";
import { markdownToDocument } from "./markdown";
import { useStore } from "./store";
import type { Chunk, Document } from "./types";

function chunk(id: string, content: string, confirmed?: boolean): Chunk {
  return {
    id,
    order: 0,
    content,
    metadata: { chunkType: "text", linkedChunks: [], confirmed },
  };
}
function doc(chunks: Chunk[]): Document {
  return { id: "d", title: "T", chunks, mode: "editor" };
}

const baseSettings = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "m",
  models: ["m"],
  imageModel: "im",
  imageModels: ["im"],
  defaultTargetLanguage: "English",
  writingTone: "",
  temperature: 0.3,
};

describe("syncConfirmedChunksToRag — auto-accumulation of confirmed content (Q11/Q16)", () => {
  beforeEach(() => {
    ragSyncConfirmedChunks.mockReset();
    ragSyncConfirmedChunks.mockResolvedValue(2);
    useStore.setState({ toasts: [], settings: null });
  });

  it("is a true no-op when the personal-RAG setting is off", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: false } });
    await syncConfirmedChunksToRag(
      doc([chunk("c1", "Confirmed text.", true)]),
      "/Users/me/paper.aix"
    );
    expect(ragSyncConfirmedChunks).not.toHaveBeenCalled();
  });

  it("is a true no-op when settings haven't loaded yet", async () => {
    useStore.setState({ settings: null });
    await syncConfirmedChunksToRag(
      doc([chunk("c1", "Confirmed text.", true)]),
      "/Users/me/paper.aix"
    );
    expect(ragSyncConfirmedChunks).not.toHaveBeenCalled();
  });

  it("sends only confirmed, non-empty chunks — unconfirmed and blank-confirmed chunks are excluded", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    await syncConfirmedChunksToRag(
      doc([
        chunk("c1", "First confirmed paragraph.", true),
        chunk("c2", "Not confirmed.", false),
        chunk("c3", "   ", true), // confirmed but blank — nothing to index
        chunk("c4", "Second confirmed paragraph.", true),
      ]),
      "/Users/me/paper.aix"
    );
    expect(ragSyncConfirmedChunks).toHaveBeenCalledTimes(1);
    expect(ragSyncConfirmedChunks).toHaveBeenCalledWith("/Users/me/paper.aix", [
      ["c1", "First confirmed paragraph."],
      ["c4", "Second confirmed paragraph."],
    ]);
  });

  it("skips the call entirely when there is nothing confirmed to sync", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    await syncConfirmedChunksToRag(doc([chunk("c1", "Not confirmed.", false)]), "/Users/me/paper.aix");
    expect(ragSyncConfirmedChunks).not.toHaveBeenCalled();
  });

  it("never throws — a sync failure surfaces an info notice, not a rejected promise", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    ragSyncConfirmedChunks.mockRejectedValue(new Error("index error"));
    await expect(
      syncConfirmedChunksToRag(doc([chunk("c1", "Confirmed text.", true)]), "/Users/me/paper.aix")
    ).resolves.toBeUndefined();
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("info");
    expect(toasts[0].message).toContain("index error");
  });
});

describe("openPath — the dispatch shared by Open… and the folder tree", () => {
  beforeEach(() => {
    importDocument.mockReset();
    openDocumentJson.mockReset();
    useStore.setState({ toasts: [] });
  });

  it("opens a .md file via importDocument", async () => {
    importDocument.mockResolvedValue(doc([chunk("c1", "hi")]));
    await openPath("/Users/me/notes/todo.md");
    expect(importDocument).toHaveBeenCalledWith("/Users/me/notes/todo.md");
    expect(openDocumentJson).not.toHaveBeenCalled();
    expect(useStore.getState().doc.chunks[0].content).toBe("hi");
    expect(useStore.getState().filePath).toBe("/Users/me/notes/todo.md");
  });

  it("opens a .aix file via openDocumentJson and surfaces repair notes as a dirty tab", async () => {
    openDocumentJson.mockResolvedValue({
      document: doc([chunk("c1", "hi")]),
      notes: ["fixed a dangling link"],
    });
    await openPath("/Users/me/paper.aix");
    expect(openDocumentJson).toHaveBeenCalledWith("/Users/me/paper.aix");
    expect(useStore.getState().dirty).toBe(true);
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1].message).toContain("fixed a dangling link");
  });

  // BUG-019d: the Rust importer's chunk projection has no image chunks; the
  // GUI re-projects with the TS parser so every view agrees from the start.
  it("opened .md is projected with the TS parser (image chunk, dirty unchanged)", async () => {
    const source = "# T\n\n![a](figures/x.png)\n";
    importDocument.mockResolvedValue({
      id: "d",
      title: "T",
      mode: "markdown",
      markdownSource: source,
      chunks: [chunk("c1", "![a](figures/x.png)")],
    });
    await openPath("/d/a.md");
    const s = useStore.getState();
    expect(s.doc.chunks.map((c) => [c.metadata.chunkType, c.content])).toEqual([
      ["image", "figures/x.png"],
    ]);
    expect(s.doc.markdownSource).toBe(source);
    expect(s.dirty).toBe(false);
  });

  it("File ▸ Import of a .md uses the same TS projection", async () => {
    dialogOpen.mockReset();
    dialogOpen.mockResolvedValue("/d/b.md");
    importDocument.mockResolvedValue({
      id: "d",
      title: "b",
      mode: "markdown",
      markdownSource: "---\nk: v\n---\n\n![a](x.png)\n",
      chunks: [chunk("c1", "---\nk: v\n---"), chunk("c2", "![a](x.png)")],
    });
    await importDocumentAction();
    expect(useStore.getState().doc.chunks.map((c) => c.metadata.chunkType)).toEqual(["image"]);
  });

  it("surfaces an error toast when the underlying command rejects, instead of throwing", async () => {
    importDocument.mockRejectedValue(new Error("boom"));
    await expect(openPath("/Users/me/broken.md")).resolves.toBeUndefined();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: "error", message: "boom" });
  });
});

describe("a file is open in at most one tab", () => {
  const NOTE = "/Users/me/研究/note_図表レビュー.md";
  beforeEach(() => {
    importDocument.mockReset();
    openDocumentJson.mockReset();
    dialogSave.mockReset();
    exportDocument.mockReset();
    exportDocument.mockResolvedValue(undefined);
    useStore.setState({ toasts: [] });
    // Start from a single blank tab.
    const st = useStore.getState();
    for (const id of st.tabOrder.filter((id) => id !== st.activeTabId)) useStore.getState().closeTab(id);
    useStore.getState().loadDocument(doc([chunk("c0", "")]), null, { dirty: false });
  });

  it("opening an already-open file switches to its tab instead of opening a second copy", async () => {
    importDocument.mockResolvedValue(doc([chunk("c1", "from disk")]));
    await openPath(NOTE);
    const noteTab = useStore.getState().activeTabId;
    useStore.getState().newTab("markdown"); // user moves to another tab
    const tabsBefore = useStore.getState().tabOrder.length;

    await openPath(NOTE);

    expect(useStore.getState().tabOrder).toHaveLength(tabsBefore);
    expect(useStore.getState().activeTabId).toBe(noteTab);
    expect(importDocument).toHaveBeenCalledTimes(1); // not re-read over the open tab
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1].message).toBe("Already open — switched to its tab.");
  });

  it("matches the same file whether its name arrives NFC or NFD (macOS)", async () => {
    importDocument.mockResolvedValue(doc([chunk("c1", "x")]));
    await openPath(NOTE.normalize("NFC"));
    expect(tabIdForPath(NOTE.normalize("NFD"))).toBe(useStore.getState().activeTabId);
    expect(tabIdForPath("/Users/me/研究/other.md")).toBeNull();
  });

  it("a double click racing two reads still ends with one tab", async () => {
    importDocument.mockResolvedValue(doc([chunk("c1", "x")]));
    const tabsBefore = useStore.getState().tabOrder.length;
    await Promise.all([openPath(NOTE), openPath(NOTE)]);
    const withPath = useStore.getState().tabOrder.filter((id) => {
      const st = useStore.getState();
      const fp = id === st.activeTabId ? st.filePath : st.inactiveTabs[id]?.filePath;
      return fp === NOTE;
    });
    expect(withPath).toHaveLength(1);
    expect(useStore.getState().tabOrder.length).toBeLessThanOrEqual(tabsBefore + 1);
  });

  it("Save As refuses to write over a file another tab has open", async () => {
    importDocument.mockResolvedValue(doc([chunk("c1", "x")]));
    await openPath(NOTE);
    useStore.getState().newTab("markdown");
    dialogSave.mockResolvedValue(NOTE);
    // BUG-011: the refusal is reported as "not saved", so close never proceeds.
    expect(await saveNativeAs()).toBe(false);
    expect(exportDocument).not.toHaveBeenCalled();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: "error" });
    expect(useStore.getState().filePath).toBeNull();
  });
});

describe("openNative — unchanged file-open behavior, now delegating to openPath", () => {
  beforeEach(() => {
    dialogOpen.mockReset();
    importDocument.mockReset();
    openDocumentJson.mockReset();
    useStore.setState({ toasts: [] });
  });

  it("does nothing when the user cancels the file picker", async () => {
    dialogOpen.mockResolvedValue(null);
    await openNative();
    expect(importDocument).not.toHaveBeenCalled();
    expect(openDocumentJson).not.toHaveBeenCalled();
  });

  it("opens whatever file the picker returns via the shared dispatch", async () => {
    dialogOpen.mockResolvedValue("/Users/me/notes/todo.md");
    importDocument.mockResolvedValue(doc([chunk("c1", "hi")]));
    await openNative();
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ directory: false })
    );
    expect(importDocument).toHaveBeenCalledWith("/Users/me/notes/todo.md");
  });
});

describe("openFolder — the new Open Folder… action", () => {
  beforeEach(() => {
    dialogOpen.mockReset();
    useStore.setState({ toasts: [], folderRoot: null, folderTreeOpen: false });
  });

  it("sets the folder root and shows the sidebar when a folder is chosen", async () => {
    dialogOpen.mockResolvedValue("/Users/me/notes");
    await openFolder();
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true })
    );
    expect(useStore.getState().folderRoot).toBe("/Users/me/notes");
    expect(useStore.getState().folderTreeOpen).toBe(true);
  });

  it("does nothing when the user cancels the folder picker", async () => {
    dialogOpen.mockResolvedValue(null);
    await openFolder();
    expect(useStore.getState().folderRoot).toBeNull();
    expect(useStore.getState().folderTreeOpen).toBe(false);
  });
});

describe("saveNativeAs — Save As offers both .aix and Markdown regardless of mode", () => {
  beforeEach(() => {
    dialogSave.mockReset();
    exportDocument.mockReset();
    saveDocumentJson.mockReset();
    exportDocument.mockResolvedValue(undefined);
    saveDocumentJson.mockResolvedValue(undefined);
    useStore.setState({ toasts: [], lastExportReport: null });
  });

  it("offers both .aix and Markdown as filter choices even for an Editor-mode document", async () => {
    useStore.setState({ doc: { id: "d", title: "T", mode: "editor", chunks: [chunk("c1", "hi")] } });
    dialogSave.mockResolvedValue(null); // cancel — only inspecting the offered filters
    await saveNativeAs();
    const opts = dialogSave.mock.calls[0][0] as { filters: Array<{ extensions: string[] }> };
    const extensions = opts.filters.flatMap((f) => f.extensions);
    expect(extensions).toEqual(expect.arrayContaining(["aix", "md", "markdown"]));
  });

  it("writes Markdown (not .aix) when the user picks a .md path for an Editor-mode document, and warns it's lossy", async () => {
    useStore.setState({ doc: { id: "d", title: "T", mode: "editor", chunks: [chunk("c1", "hi")] } });
    dialogSave.mockResolvedValue("/Users/me/notes/paper.md");
    await saveNativeAs();
    // BUG-019b (flipped from `mode: "editor"`): the payload carries the
    // TS-produced Markdown in markdown mode, so Rust writes exactly it.
    expect(exportDocument).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "markdown", markdownSource: "# T\n\nhi\n" }),
      "/Users/me/notes/paper.md",
      "md"
    );
    expect(useStore.getState().doc.mode).toBe("editor"); // the view is untouched
    expect(saveDocumentJson).not.toHaveBeenCalled();
    const report = useStore.getState().lastExportReport;
    expect(report?.warnings.length).toBeGreaterThan(0);
  });

  it("writes .aix with no lossy warning when the user keeps the native format", async () => {
    useStore.setState({ doc: { id: "d", title: "T", mode: "editor", chunks: [chunk("c1", "hi")] } });
    dialogSave.mockResolvedValue("/Users/me/notes/paper.aix");
    await saveNativeAs();
    expect(saveDocumentJson).toHaveBeenCalled();
    expect(exportDocument).not.toHaveBeenCalled();
    expect(useStore.getState().lastExportReport).toBeNull();
  });

  it("does not warn when a Markdown-mode document is saved as .md (that's not lossy)", async () => {
    useStore.setState({
      doc: { id: "d", title: "T", mode: "markdown", chunks: [chunk("c1", "hi")], markdownSource: "hi" },
    });
    dialogSave.mockResolvedValue("/Users/me/notes/paper.md");
    await saveNativeAs();
    expect(useStore.getState().lastExportReport).toBeNull();
  });
});

describe("saveNative — 'Document saved.' only when something changed", () => {
  const PATH = "/Users/me/notes/note.md";
  const savedToasts = () => useStore.getState().toasts.filter((t) => t.message === "Document saved.");
  beforeEach(() => {
    exportDocument.mockReset();
    exportDocument.mockResolvedValue(undefined);
    importDocument.mockReset();
    useStore.setState({ toasts: [] });
    useStore.getState().loadDocument(doc([chunk("c1", "first")]), PATH, { dirty: false });
  });

  it("an edit then ⌘S says 'Document saved.'", async () => {
    useStore.getState().loadDocument(doc([chunk("c1", "edited")]), PATH, { dirty: true });
    useStore.setState({ savedDoc: doc([chunk("c1", "first")]) });
    await saveNative();
    expect(exportDocument).toHaveBeenCalledTimes(1);
    expect(savedToasts()).toHaveLength(1);
  });

  it("⌘S again with nothing changed still writes, but shows no toast", async () => {
    useStore.getState().loadDocument(doc([chunk("c1", "edited")]), PATH, { dirty: true });
    useStore.setState({ savedDoc: doc([chunk("c1", "first")]) });
    await saveNative();
    await saveNative();
    await saveNative();
    expect(exportDocument).toHaveBeenCalledTimes(3);
    expect(savedToasts()).toHaveLength(1);
  });

  it("md save payload carries the merged source in markdown mode (Editor-mode edit)", async () => {
    const S = "# T\n\n\nfirst  \n\n#### deep\n";
    const opened = markdownToDocument(doc([]), S);
    useStore.getState().loadDocument(opened, PATH, { dirty: false });
    useStore.getState().setMode("editor");
    const firstId = useStore.getState().doc.chunks.find((c) => c.content === "first")!.id;
    useStore.getState().updateChunkContent(firstId, "changed");
    await saveNative();
    const payload = exportDocument.mock.calls[0][0] as Document;
    expect(exportDocument.mock.calls[0][1]).toBe(PATH);
    expect(payload.mode).toBe("markdown");
    expect(payload.markdownSource).toBe("# T\n\n\nchanged\n\n#### deep\n");
  });

  it("a notes-only edit on a .md is 'unchanged' in the written format", () => {
    const opened = { ...markdownToDocument(doc([]), "# T\n\n\nbody  \n"), mode: "slide" as const };
    const noted = {
      ...opened,
      chunks: opened.chunks.map((c) => ({ ...c, metadata: { ...c.metadata, notes: "n" } })),
    };
    expect(unchangedSinceSave(noted, opened, true)).toBe(true);
    const edited = { ...opened, chunks: opened.chunks.map((c) => ({ ...c, content: "x" })) };
    expect(unchangedSinceSave(edited, opened, true)).toBe(false);
  });

  it("compares in the written format (Markdown: same text = unchanged, even as different objects)", () => {
    const a = doc([chunk("c1", "same text")]);
    const b = doc([chunk("c9", "same text")]);
    expect(unchangedSinceSave(a, b, true)).toBe(true);
    expect(unchangedSinceSave(a, doc([chunk("c1", "other")]), true)).toBe(false);
    expect(unchangedSinceSave(a, b, false)).toBe(false); // .aix keeps chunk ids
    expect(unchangedSinceSave(a, null, true)).toBe(false);
  });
});

describe("exportPdf — native save dialog → Rust PDF writer → persistent export report (BUG-003)", () => {
  const report = {
    pages: 1,
    warnings: ["1 image was replaced by a text placeholder (image embedding in PDF is planned)."],
    imagesOmitted: 1,
    diagramsAsSource: 0,
    markdownAsPlainText: 0,
  };
  beforeEach(() => {
    exportPdfApi.mockReset();
    exportPdfApi.mockResolvedValue(report);
    dialogSave.mockReset();
    useStore.setState({ toasts: [], lastExportReport: null });
    useStore.getState().loadDocument(doc([chunk("c1", "Body")]), null, { dirty: false });
  });

  it("asks for a .pdf destination named after the title", async () => {
    dialogSave.mockResolvedValue(null);
    await exportPdf();
    expect(dialogSave).toHaveBeenCalledWith({
      defaultPath: "T.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  });

  it("writes the PDF through the Rust exporter and records its warnings on the export report", async () => {
    dialogSave.mockResolvedValue("/tmp/out.pdf");
    await exportPdf();
    expect(exportPdfApi).toHaveBeenCalledWith(
      expect.objectContaining({ title: "T" }),
      "/tmp/out.pdf"
    );
    expect(useStore.getState().lastExportReport).toMatchObject({
      format: "pdf",
      warnings: report.warnings,
    });
    // Success is quiet and never mentions a print dialog; the warnings live
    // on the health bar's export report, not in a transient toast.
    const toasts = useStore.getState().toasts;
    expect(toasts.map((t) => [t.message, t.kind])).toEqual([["Exported as PDF.", "success"]]);
  });

  it("a cancelled save dialog writes nothing, records no report and shows no toast", async () => {
    dialogSave.mockResolvedValue(null);
    await exportPdf();
    expect(exportPdfApi).not.toHaveBeenCalled();
    expect(useStore.getState().lastExportReport).toBeNull();
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("a Rust failure (e.g. no Unicode font) surfaces as an error toast and no report", async () => {
    dialogSave.mockResolvedValue("/tmp/out.pdf");
    exportPdfApi.mockRejectedValue("PDF export needs a Unicode TTF font on this system");
    await exportPdf();
    expect(useStore.getState().lastExportReport).toBeNull();
    expect(useStore.getState().toasts.map((t) => [t.message, t.kind])).toEqual([
      ["PDF export needs a Unicode TTF font on this system", "error"],
    ]);
  });
});

describe("exportPptx — document-relative figures are embedded like the preview shows them (G11)", () => {
  const img = (id: string, content: string): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType: "image", linkedChunks: [], imageSource: "local" },
  });
  const sentImages = () =>
    (exportPptxApi.mock.calls[0][0] as Document).chunks
      .filter((c) => c.metadata.chunkType === "image")
      .map((c) => c.content);
  const storeImages = () =>
    useStore
      .getState()
      .doc.chunks.filter((c) => c.metadata.chunkType === "image")
      .map((c) => c.content);

  beforeEach(() => {
    exportPptxApi.mockReset();
    exportPptxApi.mockResolvedValue({ slides: 1, warnings: [] });
    readLocalImage.mockReset();
    dialogSave.mockReset();
    dialogSave.mockResolvedValue("/tmp/out.pptx");
    useStore.setState({ toasts: [], lastExportReport: null });
  });

  it("embeds relative local images from the document folder (same resolver as the preview)", async () => {
    readLocalImage.mockResolvedValue("data:image/png;base64,AAA");
    useStore.getState().loadDocument(
      doc([chunk("t", "Body"), img("i", "figures/f.png")]),
      "/docs/a.md",
      { dirty: false }
    );
    await exportPptx();
    expect(readLocalImage).toHaveBeenCalledWith("/docs/figures/f.png");
    expect(sentImages()).toEqual(["data:image/png;base64,AAA"]);
    // Export payload only — the editor's document is never mutated.
    expect(storeImages()).toEqual(["figures/f.png"]);
    expect(useStore.getState().dirty).toBe(false);
  });

  it("an unreadable figure is left as-is (Rust warns) and the export still runs", async () => {
    readLocalImage.mockRejectedValue("No such file");
    useStore.getState().loadDocument(doc([img("i", "figures/missing.png")]), "/docs/a.md", {
      dirty: false,
    });
    await exportPptx();
    expect(exportPptxApi).toHaveBeenCalledTimes(1);
    expect(sentImages()).toEqual(["figures/missing.png"]);
  });

  it("an unsaved document never reads disk for a relative figure", async () => {
    useStore.getState().loadDocument(doc([img("i", "figures/f.png")]), null, { dirty: false });
    await exportPptx();
    expect(readLocalImage).not.toHaveBeenCalled();
    expect(sentImages()).toEqual(["figures/f.png"]);
  });

  it("inline data: and http(s) images are passed through untouched", async () => {
    useStore.getState().loadDocument(
      doc([img("a", "data:image/png;base64,BBB"), img("b", "https://e.x/i.png")]),
      "/docs/a.md",
      { dirty: false }
    );
    await exportPptx();
    expect(readLocalImage).not.toHaveBeenCalled();
    expect(sentImages()).toEqual(["data:image/png;base64,BBB", "https://e.x/i.png"]);
  });
});

describe("exportDocument — RTF embeds document-relative figures; success toast is localized (w4-polish)", () => {
  const img = (id: string, content: string): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType: "image", linkedChunks: [], imageSource: "local" },
  });
  const sentImages = () =>
    (exportDocument.mock.calls[0][0] as Document).chunks
      .filter((c) => c.metadata.chunkType === "image")
      .map((c) => c.content);
  const prevSettings = useStore.getState().settings;

  beforeEach(() => {
    exportDocument.mockReset();
    exportDocument.mockResolvedValue(undefined);
    readLocalImage.mockReset();
    dialogSave.mockReset();
    useStore.setState({ toasts: [], lastExportReport: null, settings: prevSettings });
  });

  it("RTF inlines a relative figure as a data URL (same resolver as the preview and PPTX)", async () => {
    dialogSave.mockResolvedValue("/tmp/out.rtf");
    readLocalImage.mockResolvedValue("data:image/png;base64,AAA");
    useStore.getState().loadDocument(
      doc([chunk("t", "Body"), img("i", "figures/f.png")]),
      "/docs/a.md",
      { dirty: false }
    );
    await exportDocumentAction("rtf");
    expect(readLocalImage).toHaveBeenCalledWith("/docs/figures/f.png");
    expect(exportDocument.mock.calls[0][1]).toBe("/tmp/out.rtf");
    expect(exportDocument.mock.calls[0][2]).toBe("rtf");
    expect(sentImages()).toEqual(["data:image/png;base64,AAA"]);
    // Export payload only — the editor's document is never mutated.
    expect(
      useStore.getState().doc.chunks.filter((c) => c.metadata.chunkType === "image").map((c) => c.content)
    ).toEqual(["figures/f.png"]);
  });

  it("an unreadable RTF figure is left as-is and the export still runs", async () => {
    dialogSave.mockResolvedValue("/tmp/out.rtf");
    readLocalImage.mockRejectedValue("No such file");
    useStore.getState().loadDocument(doc([img("i", "figures/missing.png")]), "/docs/a.md", {
      dirty: false,
    });
    await exportDocumentAction("rtf");
    expect(exportDocument).toHaveBeenCalledTimes(1);
    expect(sentImages()).toEqual(["figures/missing.png"]);
  });

  it("the RTF report's warnings stay on the health bar's export report (w5-rust)", async () => {
    const warning =
      "1 local image(s) couldn't be read from the document's folder and were exported as text placeholders.";
    exportDocument.mockResolvedValue({
      warnings: [warning],
      imagesNotDownloaded: 0,
      localImagesUnresolved: 1,
      imagesNotEmbeddable: 0,
      diagramsAsSource: 0,
    });
    dialogSave.mockResolvedValue("/tmp/out.rtf");
    readLocalImage.mockRejectedValue("No such file");
    useStore.getState().loadDocument(doc([img("i", "figures/missing.png")]), "/docs/a.md", {
      dirty: false,
    });
    await exportDocumentAction("rtf");
    const report = useStore.getState().lastExportReport;
    expect(report?.format).toBe("rtf");
    expect(report?.warnings).toEqual([warning]);

    // txt/md return null from Rust: an empty report, never a crash.
    exportDocument.mockResolvedValue(null);
    dialogSave.mockResolvedValue("/tmp/out.txt");
    await exportDocumentAction("txt");
    expect(useStore.getState().lastExportReport?.format).toBe("txt");
    expect(useStore.getState().lastExportReport?.warnings).toEqual([]);
  });

  it("txt and md never read local images (placeholder / keep the reference)", async () => {
    useStore.getState().loadDocument(doc([img("i", "figures/f.png")]), "/docs/a.md", {
      dirty: false,
    });
    dialogSave.mockResolvedValue("/tmp/out.txt");
    await exportDocumentAction("txt");
    dialogSave.mockResolvedValue("/tmp/out.md");
    await exportDocumentAction("md");
    expect(readLocalImage).not.toHaveBeenCalled();
    expect(exportDocument).toHaveBeenCalledTimes(2);
  });

  it("the success toast follows the UI language", async () => {
    dialogSave.mockResolvedValue("/tmp/out.rtf");
    useStore.getState().loadDocument(doc([chunk("t", "Body")]), null, { dirty: false });
    useStore.setState({
      settings: { ...(prevSettings ?? baseSettings), defaultTargetLanguage: "日本語" } as typeof prevSettings,
    });
    await exportDocumentAction("rtf");
    expect(useStore.getState().toasts.map((t) => [t.message, t.kind])).toEqual([
      ["RTFとして書き出しました。", "success"],
    ]);
    useStore.setState({
      toasts: [],
      settings: { ...(prevSettings ?? baseSettings), defaultTargetLanguage: "English" } as typeof prevSettings,
    });
    await exportDocumentAction("txt");
    expect(useStore.getState().toasts.map((t) => [t.message, t.kind])).toEqual([
      ["Exported as TXT.", "success"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// BUG-011 / BUG-018: closing a tab (and quitting) resolves unsaved work with a
// three-way Save / Don't Save / Cancel dialog, and the last tab can be closed.
// ---------------------------------------------------------------------------

/** Start every scenario from exactly one tab holding `d`. */
function singleTab(d: Document, path: string | null, dirty: boolean): string {
  const st = useStore.getState();
  for (const id of st.tabOrder.filter((id) => id !== st.activeTabId)) useStore.getState().closeTab(id);
  useStore.getState().loadDocument(d, path, { dirty });
  return useStore.getState().activeTabId;
}
const lastToast = () => {
  const toasts = useStore.getState().toasts;
  return toasts[toasts.length - 1];
};

describe("save functions report their outcome (BUG-011)", () => {
  beforeEach(() => {
    dialogSave.mockReset();
    saveDocumentJson.mockReset();
    saveDocumentJson.mockResolvedValue(undefined);
    useStore.setState({ toasts: [], settings: null });
  });

  it("saveNativeAs: a cancelled dialog is false, a successful write is true", async () => {
    singleTab(doc([chunk("c1", "x")]), null, true);
    dialogSave.mockResolvedValue(null);
    expect(await saveNativeAs()).toBe(false);
    expect(useStore.getState().dirty).toBe(true);
    dialogSave.mockResolvedValue("/tmp/new.aix");
    expect(await saveNativeAs()).toBe(true);
    expect(useStore.getState().dirty).toBe(false);
  });

  it("saveNativeAs: a failed WRITE is false and the tab stays dirty (C3a)", async () => {
    singleTab(doc([chunk("c1", "x")]), null, true);
    dialogSave.mockResolvedValue("/tmp/new.aix");
    saveDocumentJson.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveNativeAs()).toBe(false);
    expect(lastToast()).toMatchObject({ kind: "error", message: "disk full" });
    expect(useStore.getState().dirty).toBe(true);
    expect(useStore.getState().filePath).toBeNull();
  });

  it("saveNative: a failed write is false (and still reported), a good one is true", async () => {
    singleTab(doc([chunk("c1", "x")]), "/tmp/a.aix", true);
    saveDocumentJson.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveNative()).toBe(false);
    expect(lastToast()).toMatchObject({ kind: "error", message: "disk full" });
    expect(useStore.getState().dirty).toBe(true);
    expect(await saveNative()).toBe(true);
  });
});

describe("state-async-3 — a save marks clean only the tab + load it wrote", () => {
  function gate() {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    return { p, release };
  }
  beforeEach(() => {
    dialogSave.mockReset();
    saveDocumentJson.mockReset();
    exportDocument.mockReset();
    clearSession.mockClear();
    useStore.setState({ toasts: [], settings: null });
  });

  it("switching tabs while ⌘S writes: B stays dirty with its own baseline; A's snapshot is clean", async () => {
    const a = singleTab(doc([chunk("c1", "A text")]), "/tmp/a.aix", true);
    const written = useStore.getState().doc;
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "B text")]), "/tmp/b.aix", { dirty: true });
    const b = useStore.getState().activeTabId;
    const bSaved = useStore.getState().savedDoc;
    useStore.getState().switchTab(a);
    const g = gate();
    saveDocumentJson.mockImplementation(() => g.p);
    const run = saveNative();
    useStore.getState().switchTab(b); // user clicks tab B mid-write
    g.release();
    expect(await run).toBe(true);
    const st = useStore.getState();
    expect(st.activeTabId).toBe(b);
    expect(st.dirty).toBe(true);
    expect(st.savedDoc).toBe(bSaved);
    expect(st.filePath).toBe("/tmp/b.aix");
    expect(st.inactiveTabs[a].dirty).toBe(false);
    expect(st.inactiveTabs[a].savedDoc).toBe(written);
    expect(st.inactiveTabs[a].savedDocIsClean).toBe(true);
    expect(clearSession).not.toHaveBeenCalled(); // B is still dirty
  });

  it("Save As + tab switch: B's file path never changes; A gets the new path", async () => {
    const a = singleTab(doc([chunk("c1", "A text")]), null, true);
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "B text")]), "/tmp/b.aix", { dirty: true });
    const b = useStore.getState().activeTabId;
    useStore.getState().switchTab(a);
    dialogSave.mockResolvedValue("/tmp/new.aix");
    const g = gate();
    saveDocumentJson.mockImplementation(() => g.p);
    const run = saveNativeAs();
    await vi.waitFor(() => expect(saveDocumentJson).toHaveBeenCalled());
    useStore.getState().switchTab(b);
    g.release();
    expect(await run).toBe(true);
    const st = useStore.getState();
    expect(st.filePath).toBe("/tmp/b.aix");
    expect(st.dirty).toBe(true);
    expect(st.inactiveTabs[a].filePath).toBe("/tmp/new.aix");
    expect(st.inactiveTabs[a].dirty).toBe(false);
  });

  it("a keystroke during the write keeps the tab dirty (baseline = what was written)", async () => {
    singleTab(doc([chunk("c1", "before")]), "/tmp/a.aix", true);
    const written = useStore.getState().doc;
    const g = gate();
    saveDocumentJson.mockImplementation(() => g.p);
    const run = saveNative();
    useStore.getState().updateChunkContent("c1", "before, typed during the save");
    g.release();
    expect(await run).toBe(true);
    expect(useStore.getState().savedDoc).toBe(written);
    expect(useStore.getState().dirty).toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("a tab closed (or reloaded) during the write is not marked, and the save reports false", async () => {
    const a = singleTab(doc([chunk("c1", "A text")]), "/tmp/a.aix", true);
    useStore.getState().newTab();
    const b = useStore.getState().activeTabId;
    useStore.getState().switchTab(a);
    const g = gate();
    saveDocumentJson.mockImplementation(() => g.p);
    const run = saveNative();
    useStore.getState().closeTab(a);
    g.release();
    expect(await run).toBe(false);
    expect(useStore.getState().tabOrder).toEqual([b]);
    expect(useStore.getState().filePath).toBeNull();
  });
});

describe("requestCloseTab — one close path for the tab X, ⌘W and the palette", () => {
  beforeEach(() => {
    dialogMessage.mockReset();
    dialogSave.mockReset();
    saveDocumentJson.mockReset();
    saveDocumentJson.mockResolvedValue(undefined);
    exportDocument.mockReset();
    exportDocument.mockResolvedValue(undefined);
    clearSession.mockClear();
    useStore.setState({ toasts: [], settings: null }); // English labels
  });

  it("a clean last tab closes without a dialog and is replaced by a fresh untitled tab", async () => {
    const id = singleTab(doc([chunk("c1", "内容")]), "/tmp/a.aix", false);
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
    const st = useStore.getState();
    expect(st.tabOrder).toHaveLength(1);
    expect(st.activeTabId).not.toBe(id);
    expect(st.filePath).toBeNull();
    expect(st.doc.chunks.map((c) => c.content).join("")).toBe("");
  });

  it("Cancel (or a dismissed dialog) changes nothing", async () => {
    const id = singleTab(doc([chunk("c1", "下書き")]), "/tmp/a.aix", true);
    dialogMessage.mockResolvedValue("Cancel");
    expect(await requestCloseTab(id)).toBe(false);
    expect(useStore.getState().activeTabId).toBe(id);
    expect(useStore.getState().dirty).toBe(true);
    expect(saveDocumentJson).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("Don't Save closes without writing anything", async () => {
    const id = singleTab(doc([chunk("c1", "下書き")]), "/tmp/a.aix", true);
    dialogMessage.mockResolvedValue("Don't Save");
    expect(await requestCloseTab(id)).toBe(true);
    expect(saveDocumentJson).not.toHaveBeenCalled();
    expect(exportDocument).not.toHaveBeenCalled();
    expect(dialogSave).not.toHaveBeenCalled();
    expect(useStore.getState().tabOrder).not.toContain(id);
  });

  it("discarding the last dirty tab clears the crash-recovery session", async () => {
    const id = singleTab(doc([chunk("c1", "下書き")]), null, true);
    dialogMessage.mockResolvedValue("Don't Save");
    await requestCloseTab(id);
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("closing one dirty tab while another stays dirty keeps the session", async () => {
    singleTab(doc([chunk("c1", "残す")]), null, true);
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "捨てる")]), null, { dirty: true });
    const second = useStore.getState().activeTabId;
    dialogMessage.mockResolvedValue("Don't Save");
    expect(await requestCloseTab(second)).toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("Save on an untitled tab whose Save As is cancelled keeps the tab open and dirty", async () => {
    const id = singleTab(doc([chunk("c1", "未保存")]), null, true);
    dialogMessage.mockResolvedValue("Save");
    dialogSave.mockResolvedValue(null);
    expect(await requestCloseTab(id)).toBe(false);
    expect(dialogSave).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabOrder).toContain(id);
    expect(useStore.getState().dirty).toBe(true);
  });

  it("Save whose write fails keeps the tab open, with the error toast", async () => {
    const id = singleTab(doc([chunk("c1", "未保存")]), "/tmp/a.aix", true);
    dialogMessage.mockResolvedValue("Save");
    saveDocumentJson.mockRejectedValue(new Error("disk full"));
    expect(await requestCloseTab(id)).toBe(false);
    expect(useStore.getState().tabOrder).toContain(id);
    expect(useStore.getState().dirty).toBe(true);
    expect(lastToast()).toMatchObject({ kind: "error", message: "disk full" });
  });

  it("Save on an untitled tab whose Save As WRITE fails keeps the tab open and dirty (C3a)", async () => {
    const id = singleTab(doc([chunk("c1", "未保存")]), null, true);
    dialogMessage.mockResolvedValue("Save");
    dialogSave.mockResolvedValue("/tmp/new.aix");
    saveDocumentJson.mockRejectedValue(new Error("disk full"));
    expect(await requestCloseTab(id)).toBe(false);
    expect(useStore.getState().tabOrder).toContain(id);
    expect(useStore.getState().dirty).toBe(true);
  });

  it("a tab closed while its Save dialog was up saves nothing and reports false (C3f)", async () => {
    const a = singleTab(doc([chunk("c1", "A")]), "/tmp/a.aix", true);
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "B")]), "/tmp/b.aix", { dirty: true });
    let answer!: (v: string) => void;
    dialogMessage.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const run = requestCloseTab(a);
    await vi.waitFor(() => expect(dialogMessage).toHaveBeenCalled());
    useStore.getState().closeTab(a); // closed some other way meanwhile
    answer("Save");
    expect(await run).toBe(false);
    expect(saveDocumentJson).not.toHaveBeenCalled();
    expect(dialogSave).not.toHaveBeenCalled();
    expect(useStore.getState().dirty).toBe(true); // B untouched
  });

  it("Save on an INACTIVE dirty tab writes THAT tab's document, then closes it", async () => {
    const a = singleTab(doc([chunk("c1", "未保存保護テスト_日本語ABC")]), "/tmp/a.aix", true);
    useStore.getState().newTab(); // B is active, A is in the background
    const b = useStore.getState().activeTabId;
    dialogMessage.mockResolvedValue("Save");
    expect(await requestCloseTab(a)).toBe(true);
    expect(saveDocumentJson).toHaveBeenCalledTimes(1);
    const [written, path] = saveDocumentJson.mock.calls[0] as [Document, string];
    expect(written.chunks[0].content).toBe("未保存保護テスト_日本語ABC");
    expect(path).toBe("/tmp/a.aix");
    expect(dialogSave).not.toHaveBeenCalled();
    expect(useStore.getState().tabOrder).toEqual([b]);
    expect(useStore.getState().activeTabId).toBe(b);
  });

  it("a clean INACTIVE tab closes without a dialog and leaves the active tab alone", async () => {
    const a = singleTab(doc([chunk("c1", "x")]), "/tmp/a.aix", false);
    useStore.getState().newTab();
    const b = useStore.getState().activeTabId;
    expect(await requestCloseTab(a)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
    expect(useStore.getState().tabOrder).toEqual([b]);
  });
});

describe("resolveDirtyTabsForQuit — ⌘Q reviews each dirty tab in order (BUG-011)", () => {
  beforeEach(() => {
    dialogMessage.mockReset();
    dialogSave.mockReset();
    saveDocumentJson.mockReset();
    saveDocumentJson.mockResolvedValue(undefined);
    useStore.setState({ toasts: [], settings: null });
  });

  it("nothing dirty: proceeds without asking", async () => {
    singleTab(doc([chunk("c1", "x")]), "/tmp/a.aix", false);
    useStore.getState().newTab();
    expect(await resolveDirtyTabsForQuit()).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it("asks once per dirty tab, in tab order, and aborts on the first Cancel", async () => {
    singleTab({ ...doc([chunk("c1", "一")]), title: "First" }, null, true);
    useStore.getState().newTab(); // clean tab in between: never asked about
    useStore.getState().newTab();
    useStore.getState().loadDocument({ ...doc([chunk("c2", "二")]), title: "Second" }, null, { dirty: true });
    useStore.getState().newTab();
    useStore.getState().loadDocument({ ...doc([chunk("c3", "三")]), title: "Third" }, null, { dirty: true });
    dialogMessage.mockResolvedValueOnce("Don't Save").mockResolvedValueOnce("Cancel");
    expect(await resolveDirtyTabsForQuit()).toBe(false);
    expect(dialogMessage).toHaveBeenCalledTimes(2);
    expect(dialogMessage.mock.calls[0][0]).toContain("“First”");
    expect(dialogMessage.mock.calls[1][0]).toContain("“Second”");
  });

  it("a failed save aborts the quit before asking about later tabs", async () => {
    singleTab(doc([chunk("c1", "一")]), "/tmp/a.aix", true);
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "二")]), null, { dirty: true });
    dialogMessage.mockResolvedValue("Save");
    saveDocumentJson.mockRejectedValue(new Error("disk full"));
    expect(await resolveDirtyTabsForQuit()).toBe(false);
    expect(dialogMessage).toHaveBeenCalledTimes(1);
  });

  it("a dirty tab created while a quit dialog is up is asked about too (state-async-5)", async () => {
    singleTab({ ...doc([chunk("c1", "一")]), title: "First" }, null, true);
    let answer!: (v: string) => void;
    dialogMessage
      .mockImplementationOnce(() => new Promise<string>((r) => (answer = r)))
      .mockResolvedValueOnce("Cancel");
    const run = resolveDirtyTabsForQuit();
    await vi.waitFor(() => expect(dialogMessage).toHaveBeenCalledTimes(1));
    // e.g. a Draft's first content arrives in a new tab while the dialog is up
    useStore.getState().newTab();
    useStore.getState().loadDocument({ ...doc([chunk("d1", "下書き")]), title: "Draft" }, null, { dirty: true });
    answer("Don't Save");
    expect(await run).toBe(false);
    expect(dialogMessage).toHaveBeenCalledTimes(2);
    expect(dialogMessage.mock.calls[1][0]).toContain("“Draft”");
  });

  it("Don't Save on every dirty tab lets the quit proceed", async () => {
    singleTab(doc([chunk("c1", "一")]), null, true);
    useStore.getState().newTab();
    useStore.getState().loadDocument(doc([chunk("c2", "二")]), null, { dirty: true });
    dialogMessage.mockResolvedValue("Don't Save");
    expect(await resolveDirtyTabsForQuit()).toBe(true);
    expect(dialogMessage).toHaveBeenCalledTimes(2);
    expect(saveDocumentJson).not.toHaveBeenCalled();
  });
});
