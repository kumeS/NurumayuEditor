import { beforeEach, describe, expect, it, vi } from "vitest";

// BUG-007 (QA 20261003), step 3: typing a speaker note and clicking the tab's
// close button once must go straight to the Save / Don't Save / Cancel
// prompt. The old notes field committed only on blur, so the store was still
// clean when the close path asked — the first click did not prompt (and in
// the real app was spent on the blur commit). The SpeakerNotes field now
// writes through updateChunkNotes on every change (wiring guarded in
// slideEditorWiring.test.ts); this drives that store write and the shared
// close path (requestCloseTab) together. Tauri dialog + IPC are mocked the
// same way as fileActions.test.ts.

const saveDocumentJson = vi.fn();
const clearSession = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./api", () => ({
  api: {
    saveDocumentJson: (...args: unknown[]) => saveDocumentJson(...args),
    clearSession: (...args: unknown[]) => clearSession(...args),
    ragSyncConfirmedChunks: () => Promise.resolve(),
  },
}));
const dialogMessage = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: (...args: unknown[]) => dialogMessage(...args),
}));

import { requestCloseTab } from "./fileActions";
import { useStore } from "./store";
import type { Chunk, Document } from "./types";

const heading = (id: string, content: string): Chunk => ({
  id,
  order: 0,
  content,
  metadata: { chunkType: "heading", level: 1, linkedChunks: [] },
});
const deck = (): Document => ({ id: "d", title: "発表", mode: "slide", chunks: [heading("h1", "一枚目")] });

/** One clean slide tab backed by a file, as after opening a deck. */
function openDeck(): string {
  const st = useStore.getState();
  for (const id of st.tabOrder.filter((t) => t !== st.activeTabId)) useStore.getState().closeTab(id);
  useStore.getState().loadDocument(deck(), "/tmp/deck.aix");
  return useStore.getState().activeTabId;
}

describe("BUG-007 — one close click after typing a note asks to save", () => {
  beforeEach(() => {
    dialogMessage.mockReset();
    saveDocumentJson.mockReset();
    clearSession.mockClear();
    useStore.setState({ toasts: [], settings: null });
  });

  it("control: an untouched deck closes without a prompt", async () => {
    const id = openDeck();
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it("typing a note (no blur) → the first close click prompts; Cancel keeps the tab and the note", async () => {
    const id = openDeck();
    // What SpeakerNotes' onChange does for each keystroke.
    for (const v of ["発", "発表", "発表者ノート"]) useStore.getState().updateChunkNotes("h1", v);
    dialogMessage.mockResolvedValue("Cancel");
    expect(await requestCloseTab(id)).toBe(false);
    expect(dialogMessage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabOrder).toContain(id);
    expect(useStore.getState().doc.chunks[0].metadata.notes).toBe("発表者ノート");
  });

  it("…and Don't Save closes it on that same first click", async () => {
    const id = openDeck();
    useStore.getState().updateChunkNotes("h1", "メモ");
    dialogMessage.mockResolvedValue("Don't Save");
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabOrder).not.toContain(id);
    expect(saveDocumentJson).not.toHaveBeenCalled();
  });

  it("a note typed and then undone (document undo) closes without a prompt", async () => {
    const id = openDeck();
    useStore.getState().updateChunkNotes("h1", "消すメモ");
    useStore.getState().undo();
    expect(useStore.getState().dirty).toBe(false);
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });
});

// QA 20261003 follow-up (the BUG-007 class): the detached-slide bullet field
// committed on blur too (setSlideBody), so typing bullets and clicking the
// tab's close button once did not prompt. It now writes through
// updateSlideBody on every change (wiring: slideEditorWiring.test.ts).
describe("detached-slide bullets — one close click after typing asks to save", () => {
  const detachedDeck = (): Document => ({
    id: "d",
    title: "発表",
    mode: "slide",
    chunks: [
      {
        ...heading("h1", "一枚目"),
        metadata: { chunkType: "heading", level: 1, linkedChunks: [], slideBody: ["要点"] },
      },
    ],
  });
  const openDetached = (): string => {
    const st = useStore.getState();
    for (const id of st.tabOrder.filter((t) => t !== st.activeTabId)) useStore.getState().closeTab(id);
    useStore.getState().loadDocument(detachedDeck(), "/tmp/detached.aix");
    return useStore.getState().activeTabId;
  };

  beforeEach(() => {
    dialogMessage.mockReset();
    saveDocumentJson.mockReset();
    useStore.setState({ toasts: [], settings: null });
  });

  it("control: an untouched detached slide closes without a prompt", async () => {
    const id = openDetached();
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it("typing a bullet (no blur) → the first close click prompts; Cancel keeps the tab and the bullets", async () => {
    const id = openDetached();
    // What the bullet field's onChange does for each keystroke.
    for (const v of ["要点\n", "要点\n追", "要点\n追加の論点"]) useStore.getState().updateSlideBody("h1", v);
    dialogMessage.mockResolvedValue("Cancel");
    expect(await requestCloseTab(id)).toBe(false);
    expect(dialogMessage).toHaveBeenCalledTimes(1);
    expect(useStore.getState().tabOrder).toContain(id);
    expect(useStore.getState().doc.chunks[0].metadata.slideBody).toEqual(["要点", "追加の論点"]);
  });

  it("only a trailing empty line typed (nothing stored changed) closes without a prompt", async () => {
    const id = openDetached();
    useStore.getState().updateSlideBody("h1", "要点\n");
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });

  it("bullets typed and then undone (document undo) close without a prompt", async () => {
    const id = openDetached();
    useStore.getState().updateSlideBody("h1", "要点\n消す行");
    useStore.getState().undo();
    expect(useStore.getState().dirty).toBe(false);
    expect(await requestCloseTab(id)).toBe(true);
    expect(dialogMessage).not.toHaveBeenCalled();
  });
});
