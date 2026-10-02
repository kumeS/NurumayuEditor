import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// draftDocument / openInTab lifecycle (BUG-001c, BUG-005a/b/c, BUG-014).
// The Tauri draft stream is mocked with a hand-driven channel: `emit` plays
// the backend's update/done events, `resolveStream`/`rejectStream` settle the
// invoke — so each test controls exactly when content arrives.
const aiDraftStream = vi.fn();
const openDocumentJson = vi.fn();
vi.mock("./api", () => ({
  api: {
    aiDraftStream: (...args: unknown[]) => aiDraftStream(...args),
    openDocumentJson: (...args: unknown[]) => openDocumentJson(...args),
    importDocument: vi.fn(),
    clearSession: () => Promise.resolve(),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import {
  MODEL_UNAVAILABLE_MODEL_END,
  MODEL_UNAVAILABLE_PREFIX,
  NETWORK_ERROR_PREFIX,
  RATE_LIMITED_PREFIX,
  localizeAiError,
} from "./aiErrors";
import { detachPendingDraft, draftDocument, openPath, tabIdForPath } from "./fileActions";
import { useStore } from "./store";
import type { Chunk, Document, DraftEvent } from "./types";

const st = () => useStore.getState();

function chunk(id: string, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: "text", linkedChunks: [] } };
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

let emit: (e: DraftEvent) => void = () => {
  throw new Error("stream not started");
};
let resolveStream: () => void = () => {};
let rejectStream: (e: unknown) => void = () => {};
function pendingStream() {
  aiDraftStream.mockImplementation(
    (_theme: string, _words: unknown, _ref: unknown, onEvent: (e: DraftEvent) => void) => {
      emit = onEvent;
      return new Promise<void>((res, rej) => {
        resolveStream = res;
        rejectStream = rej;
      });
    }
  );
}
const update = (d: Document) => emit({ kind: "update", document: d });
const done = (d: Document) => emit({ kind: "done", document: d });
const errorToasts = () => st().toasts.filter((t) => t.kind === "error");

beforeEach(() => {
  aiDraftStream.mockReset();
  openDocumentJson.mockReset();
  // One blank, idle, untitled tab.
  const s = st();
  for (const id of s.tabOrder.filter((id) => id !== s.activeTabId)) st().closeTab(id);
  st().loadDocument(doc([chunk("c0", "")]), null, { dirty: false });
  useStore.setState({
    toasts: [],
    hasApiKey: true,
    settings: { ...baseSettings },
    globalBusy: null,
    busyChunks: {},
    streamingChunkId: null,
    lastExportReport: null,
    aiModelIssue: null,
  });
});
afterEach(() => {
  // draftInFlight is module state: never let a pending draft leak into the next test.
  detachPendingDraft();
  vi.useRealTimers();
});

describe("BUG-014 — the draft tab is created lazily; failures before content change nothing", () => {
  it("a draft that fails before any content creates no tab and keeps the origin tab active", async () => {
    st().loadDocument(doc([chunk("a", "existing")]), null, { dirty: true });
    const origin = st().activeTabId;
    const model = "meta-llama/llama-3.3-70b-instruct:free";
    aiDraftStream.mockRejectedValue(
      `${NETWORK_ERROR_PREFIX}${MODEL_UNAVAILABLE_PREFIX}${model}${MODEL_UNAVAILABLE_MODEL_END} (HTTP 404).`
    );
    const r = await draftDocument("theme", 300);
    expect(r).toEqual({
      ok: false,
      reason: "failed",
      hadContent: false,
      error: `The model '${model}' is not available from the provider. Choose another model in Settings.`,
    });
    expect(st().tabOrder).toEqual([origin]);
    expect(st().activeTabId).toBe(origin);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["existing"]);
    expect(st().globalBusy).toBeNull();
    // The model issue goes to the persistent store flag (BUG-013c)…
    expect(st().aiModelIssue).toEqual({ model });
    // …and the error is the dialog's to show inline — no duplicate toast.
    expect(errorToasts()).toEqual([]);
  });

  it("localizes the error for a Japanese UI", async () => {
    useStore.setState({ settings: { ...baseSettings, defaultTargetLanguage: "日本語" } });
    aiDraftStream.mockRejectedValue(`${NETWORK_ERROR_PREFIX}${MODEL_UNAVAILABLE_PREFIX}x/y${MODEL_UNAVAILABLE_MODEL_END}.`);
    const r = await draftDocument("テーマ", 300);
    expect(r).toMatchObject({ ok: false, error: "モデル「x/y」は提供元で利用できません。設定で別のモデルを選んでください。" });
  });

  it("the draft tab is created on first content, and onFirstContent fires once", async () => {
    pendingStream();
    st().loadDocument(doc([chunk("a", "existing")]), null, { dirty: true });
    const onFirst = vi.fn();
    const p = draftDocument("t", 300, undefined, onFirst);
    expect(st().tabOrder).toHaveLength(1);
    expect(onFirst).not.toHaveBeenCalled();
    expect(st().globalBusy).toBeNull();

    update(doc([chunk("draft-0", "one two")]));
    expect(st().tabOrder).toHaveLength(2);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["one two"]);
    expect(st().dirty).toBe(true); // a partial draft is protected by the discard guard

    update(doc([chunk("draft-0", "one two three")]));
    expect(onFirst).toHaveBeenCalledTimes(1);
    done(doc([chunk("u1", "one two three")]));
    resolveStream();
    expect(await p).toEqual({ ok: true });
    expect(st().globalBusy).toBeNull();
  });

  it("reuses a pristine origin tab for the draft (no stray blank tab)", async () => {
    pendingStream();
    const origin = st().activeTabId;
    const p = draftDocument("t", undefined);
    update(doc([chunk("draft-0", "hello")]));
    expect(st().tabOrder).toEqual([origin]);
    done(doc([chunk("u1", "hello")]));
    resolveStream();
    await p;
  });

  it("an empty stream (no events) fails loudly and creates no tab", async () => {
    aiDraftStream.mockResolvedValue(undefined);
    const origin = st().activeTabId;
    st().loadDocument(doc([chunk("a", "existing")]), null, { dirty: true });
    const r = await draftDocument("t", 300);
    expect(r).toEqual({
      ok: false,
      reason: "failed",
      hadContent: false,
      error: "The model returned an empty response. Try again, or switch models in Settings.",
    });
    expect(st().activeTabId).toBe(origin);
    expect(st().tabOrder).toHaveLength(1);
  });

  it("content arriving after the stream already settled empty creates no tab and no stuck busy label", async () => {
    aiDraftStream.mockImplementation(
      (_t: string, _w: unknown, _r: unknown, onEvent: (e: DraftEvent) => void) => {
        emit = onEvent;
        return Promise.resolve();
      }
    );
    const onFirst = vi.fn();
    const r = await draftDocument("t", 300, undefined, onFirst);
    expect(r).toMatchObject({ ok: false, reason: "failed", hadContent: false });
    done(doc([chunk("u1", "late")]));
    expect(st().tabOrder).toHaveLength(1);
    expect(st().globalBusy).toBeNull();
    expect(onFirst).not.toHaveBeenCalled();
  });

  it("a second submit while the first waits for content is refused (draftInFlight)", async () => {
    pendingStream();
    void draftDocument("a", 300);
    const r = await draftDocument("b", 300);
    expect(r).toEqual({
      ok: false,
      reason: "busy",
      hadContent: false,
      error: "A draft is already being generated.",
    });
    expect(aiDraftStream).toHaveBeenCalledTimes(1);
  });

  it("detaching before content ignores the result: no tab, no toast, and a new draft may start", async () => {
    pendingStream();
    const onFirst = vi.fn();
    const p = draftDocument("t", 300, undefined, onFirst);
    detachPendingDraft();
    update(doc([chunk("draft-0", "late")]));
    done(doc([chunk("u1", "late")]));
    resolveStream();
    expect(await p).toMatchObject({ ok: false, reason: "detached", hadContent: false });
    expect(st().tabOrder).toHaveLength(1);
    expect(st().doc.chunks.map((c) => c.content)).toEqual([""]);
    expect(onFirst).not.toHaveBeenCalled();
    expect(st().toasts).toEqual([]);

    pendingStream();
    void draftDocument("again", 300);
    expect(aiDraftStream).toHaveBeenCalledTimes(2);
  });

  it("without an AI key it opens Settings and never calls the backend", async () => {
    useStore.setState({ hasApiKey: false, settingsOpen: false });
    const r = await draftDocument("t", 300);
    expect(r).toMatchObject({ ok: false, reason: "not-ready", hadContent: false });
    expect(st().settingsOpen).toBe(true);
    expect(aiDraftStream).not.toHaveBeenCalled();
  });
});

describe("BUG-001c — Open never lands in a tab with work in flight", () => {
  it("opening a file while a draft is waiting for its first token does not reuse the draft tab", async () => {
    pendingStream();
    void draftDocument("theme", 300);
    openDocumentJson.mockResolvedValue({ document: doc([chunk("k", "KEEP")]), notes: [] });
    await openPath("/a.aix");
    const aixTab = tabIdForPath("/a.aix");
    expect(aixTab).not.toBeNull();

    update(doc([chunk("draft-0", "DRAFT TEXT")]));
    done(doc([chunk("u1", "DRAFT TEXT")]));
    resolveStream();

    const s = st();
    const aix = aixTab === s.activeTabId ? { doc: s.doc, filePath: s.filePath } : s.inactiveTabs[aixTab!];
    expect(aix.filePath).toBe("/a.aix");
    expect(aix.doc.chunks.map((c) => c.content)).toEqual(["KEEP"]);
    // The draft went to its own, file-less tab.
    expect(s.activeTabId).not.toBe(aixTab);
    expect(s.filePath).toBeNull();
    expect(s.doc.chunks.map((c) => c.content)).toEqual(["DRAFT TEXT"]);
  });

  it.each([
    ["globalBusy", { globalBusy: "Analyzing document…" }],
    ["busyChunks", { busyChunks: { c0: true } }],
    ["streamingChunkId", { streamingChunkId: "c0" }],
  ])("a blank tab with %s set is not reused by Open", async (_name, busy) => {
    useStore.setState(busy as Partial<ReturnType<typeof st>>);
    const busyTab = st().activeTabId;
    openDocumentJson.mockResolvedValue({ document: doc([chunk("k", "KEEP")]), notes: [] });
    await openPath("/b.aix");
    expect(st().tabOrder).toHaveLength(2);
    expect(tabIdForPath("/b.aix")).not.toBe(busyTab);
  });
});

describe("BUG-005b — a draft finishing in the background lands in its own tab, dirty", () => {
  it("commits done to the backgrounded draft tab; background updates are not painted elsewhere", async () => {
    pendingStream();
    const p = draftDocument("t", 300);
    update(doc([chunk("draft-0", "partial")]));
    const draftTab = st().activeTabId;
    st().newTab();
    const other = st().activeTabId;

    update(doc([chunk("draft-0", "partial, more")]));
    expect(st().doc.chunks.map((c) => c.content)).toEqual([""]); // the new tab is untouched
    expect(st().inactiveTabs[draftTab].doc.chunks.map((c) => c.content)).toEqual(["partial"]);

    done(doc([chunk("u1", "partial"), chunk("u2", "full rest")]));
    resolveStream();
    expect(await p).toEqual({ ok: true });

    expect(st().activeTabId).toBe(other);
    const snap = st().inactiveTabs[draftTab];
    expect(snap.doc.chunks.map((c) => c.content)).toEqual(["partial", "full rest"]);
    expect(snap.dirty).toBe(true);
    expect(snap.globalBusy).toBeNull(); // the busy label clears on the draft's own tab
  });
});

describe("BUG-005a/c — progress and the achieved-vs-target report", () => {
  it("the busy label shows exact progress, throttled to at most 4 Hz", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    pendingStream();
    const p = draftDocument("t", 300);
    update(doc([chunk("draft-0", "one two three four five")]));
    expect(st().globalBusy).toBe("Drafting… ~5 / ~300 words");

    vi.setSystemTime(10_100); // < 250 ms later: not repainted
    update(doc([chunk("draft-0", "one two three four five six seven")]));
    expect(st().globalBusy).toBe("Drafting… ~5 / ~300 words");

    vi.setSystemTime(10_300);
    update(doc([chunk("draft-0", "one two three four five six seven")]));
    expect(st().globalBusy).toBe("Drafting… ~7 / ~300 words");

    done(doc([chunk("u1", "one two three four five six seven")]));
    resolveStream();
    await p;
    expect(st().globalBusy).toBeNull();
  });

  it("a Japanese draft is measured in characters against the converted target", async () => {
    useStore.setState({ settings: { ...baseSettings, defaultTargetLanguage: "日本語" } });
    pendingStream();
    const p = draftDocument("テーマ", 300);
    update(doc([chunk("draft-0", "日本語の文章です")]));
    expect(st().globalBusy).toBe("下書き中… 8 / 約600文字");
    done(doc([chunk("u1", "日本語の文章です")]));
    resolveStream();
    await p;
    const toasts = st().toasts;
    expect(toasts[toasts.length - 1].message).toBe("下書きを作成しました — 1段落・8文字(目標 約600文字)。");
  });

  it("reports achieved vs target, and keeps an out-of-range length on the persistent report", async () => {
    pendingStream();
    const p = draftDocument("t", 300);
    done(doc([chunk("u1", "one two three"), chunk("u2", "four five")]));
    resolveStream();
    await p;
    const toasts = st().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({
      kind: "success",
      message: "Draft created — 2 paragraphs, ~5 words (target ~300).",
    });
    expect(st().lastExportReport).toMatchObject({
      format: "draft",
      warnings: ["The draft is ~5 words, outside ±20% of the ~300-word target."],
    });
  });

  it("a draft within ±20% of its target leaves no persistent report", async () => {
    pendingStream();
    const p = draftDocument("t", 5);
    done(doc([chunk("u1", "one two three four five six")]));
    resolveStream();
    await p;
    expect(st().lastExportReport).toBeNull();
  });

  it("a failure after partial content keeps the dirty partial tab and reports the error persistently", async () => {
    pendingStream();
    const p = draftDocument("t", 300);
    update(doc([chunk("draft-0", "partial text")]));
    const draftTab = st().activeTabId;
    const raw = `${NETWORK_ERROR_PREFIX}${RATE_LIMITED_PREFIX}. Slow down (provider: busy)`;
    rejectStream(raw);
    const r = await p;
    const error = localizeAiError(raw, "en").text;
    expect(r).toEqual({ ok: false, reason: "failed", hadContent: true, error });
    expect(st().activeTabId).toBe(draftTab);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["partial text"]);
    expect(st().dirty).toBe(true);
    expect(st().globalBusy).toBeNull();
    expect(st().lastExportReport).toMatchObject({
      format: "draft",
      warnings: [
        `The draft stopped before it finished: ${error} The partial draft is kept in its tab (unsaved).`,
      ],
    });
    expect(errorToasts().map((t) => t.message)).toEqual([error]);
  });

  it("does not claim the partial draft is kept when its tab was already closed", async () => {
    pendingStream();
    const p = draftDocument("t", 300);
    update(doc([chunk("draft-0", "partial text")]));
    const draftTab = st().activeTabId;
    st().newTab();
    st().closeTab(draftTab);
    rejectStream(`${NETWORK_ERROR_PREFIX}${RATE_LIMITED_PREFIX}.`);
    expect(await p).toMatchObject({ ok: false, reason: "failed", hadContent: true });
    expect(st().lastExportReport).toBeNull();
    expect(errorToasts()).toHaveLength(1);
  });
});
