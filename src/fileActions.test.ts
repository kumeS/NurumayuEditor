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
vi.mock("./api", () => ({
  api: {
    ragSyncConfirmedChunks: (...args: unknown[]) => ragSyncConfirmedChunks(...args),
    importDocument: (...args: unknown[]) => importDocument(...args),
    openDocumentJson: (...args: unknown[]) => openDocumentJson(...args),
    exportDocument: (...args: unknown[]) => exportDocument(...args),
    saveDocumentJson: (...args: unknown[]) => saveDocumentJson(...args),
  },
}));

const dialogOpen = vi.fn();
const dialogSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
  save: (...args: unknown[]) => dialogSave(...args),
}));

import { openFolder, openNative, openPath, saveNativeAs, syncConfirmedChunksToRag } from "./fileActions";
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

  it("surfaces an error toast when the underlying command rejects, instead of throwing", async () => {
    importDocument.mockRejectedValue(new Error("boom"));
    await expect(openPath("/Users/me/broken.md")).resolves.toBeUndefined();
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: "error", message: "boom" });
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
    expect(exportDocument).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "editor" }),
      "/Users/me/notes/paper.md",
      "md"
    );
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
