import { beforeEach, describe, expect, it } from "vitest";
import { documentDiff } from "./diff";
import { groupSlides, hasLayoutOverride, resolveLayout } from "./slides";
import {
  clampPresentIndex,
  hashContent,
  makeWelcomeExampleDoc,
  pruneAnalysis,
  staleSummaryChunkIds,
  useStore,
} from "./store";
import type {
  AnalysisNode,
  AnalysisResult,
  Chunk,
  ChunkType,
  Document,
  Settings,
  SlideLayout,
} from "./types";

function chunk(id: string, type: ChunkType, content = ""): Chunk {
  return { id, order: 0, content, metadata: { chunkType: type, linkedChunks: [] } };
}
function node(id: string): AnalysisNode {
  return { id, label: "", summary: "", kind: "paragraph" };
}
function doc(chunks: Chunk[], title = "T"): Document {
  return { id: "d", title, chunks, mode: "editor" };
}

/** Reset the singleton store to a known single-tab state before each test. */
function reset(chunks: Chunk[]): void {
  useStore.setState({
    tabOrder: ["tab-1"],
    activeTabId: "tab-1",
    inactiveTabs: {},
    globalBusy: null,
    busyChunks: {},
    streamingChunkId: null,
    streamingText: "",
    // Transient UI state (e.g. a graph-jump or mode-switch flash) must not
    // leak across tests — flashChunkId only clears itself via a real 1600ms
    // timeout, which no test waits out.
    flashChunkId: null,
    flashChunkIds: [],
    ghostSuggestion: null,
    ghostRequestId: 0,
  });
  useStore.getState().loadDocument(doc(chunks));
}

const st = () => useStore.getState();

describe("B3 — per-tab in-flight state", () => {
  it("does not bleed across tabs on switch", () => {
    reset([chunk("a", "text")]);
    const a = st().activeTabId;
    st().setGlobalBusy("Working…");
    expect(st().globalBusy).toBe("Working…");
    st().newTab();
    expect(st().globalBusy).toBeNull(); // fresh tab is clean
    expect(st().inactiveTabs[a].globalBusy).toBe("Working…"); // kept on the old tab
    st().switchTab(a);
    expect(st().globalBusy).toBe("Working…"); // restored
  });

  it("a background op's completion lands on its own tab (no stuck spinner / no foreground clear)", () => {
    reset([chunk("a", "text")]);
    const a = st().activeTabId;
    st().setGlobalBusy("Working…", a);
    st().newTab(); // a different tab is active now
    st().setGlobalBusy(null, a); // the op on `a` finishes
    expect(st().globalBusy).toBeNull(); // active tab untouched
    expect(st().inactiveTabs[a].globalBusy).toBeNull();
    st().switchTab(a);
    expect(st().globalBusy).toBeNull(); // no stuck spinner
  });

  it("routing to a closed tab is a no-op", () => {
    reset([chunk("a", "text")]);
    const a = st().activeTabId;
    st().newTab();
    st().closeTab(a);
    expect(() => st().setGlobalBusy(null, a)).not.toThrow();
    expect(st().inactiveTabs[a]).toBeUndefined();
  });
});

describe("Markdown source mutation", () => {
  beforeEach(() => reset([chunk("a", "text", "Original")]))

  it("is undoable and keeps the parsed chunk projection in sync", () => {
    st().setMode("markdown");
    const source = "# 日本語タイトル\n\n## 概要\n\n- [x] 完了\n";

    st().setMarkdownSource(source);
    expect(st().doc.markdownSource).toBe(source);
    expect(st().doc.title).toBe("日本語タイトル");
    expect(st().doc.chunks.map((c) => c.metadata.chunkType)).toEqual([
      "heading",
      "text",
    ]);

    st().undo();
    expect(st().doc.markdownSource).toContain("Original");
    st().redo();
    expect(st().doc.markdownSource).toBe(source);
  });

  it("clears stale raw source after a chunk-side edit", () => {
    st().setMode("markdown");
    st().setMarkdownSource("# Title\n\nBody\n");
    const bodyId = st().doc.chunks[0].id;
    st().setMode("editor");
    st().updateChunkContent(bodyId, "Changed in paragraph editor");

    expect(st().doc.markdownSource).toBeUndefined();
  });
});

describe("B8 — setChunkSummary is undoable", () => {
  beforeEach(() => reset([chunk("c1", "text", "hello")]));

  it("snapshots history and round-trips through undo/redo", () => {
    st().updateChunkContent("c1", "hello!"); // make a prior edit
    const before = st().past.length;
    st().setChunkSummary("c1", "sum");
    expect(st().past.length).toBe(before + 1);
    expect(st().doc.chunks[0].metadata.summary).toBe("sum");
    st().undo();
    expect(st().doc.chunks[0].metadata.summary).toBeUndefined();
    st().redo();
    expect(st().doc.chunks[0].metadata.summary).toBe("sum");
  });

  it("does not mark the relationship graph stale", () => {
    useStore.setState({ analysisStale: false });
    st().setChunkSummary("c1", "s");
    expect(st().analysisStale).toBe(false);
  });
});

describe("Personal RAG auto-accumulation (開発.txt Stage 3; Q11/Q16) — setChunkConfirmed", () => {
  beforeEach(() => reset([chunk("c1", "text", "Some paragraph.")]));

  it("toggles the confirmed flag and persists it on the chunk's metadata", () => {
    expect(st().doc.chunks[0].metadata.confirmed).toBeFalsy();
    st().setChunkConfirmed("c1", true);
    expect(st().doc.chunks[0].metadata.confirmed).toBe(true);
    st().setChunkConfirmed("c1", false);
    expect(st().doc.chunks[0].metadata.confirmed).toBe(false);
  });

  it("is undoable like its metadata-toggle peers (setChunkSubtitle/setChunkLayout)", () => {
    const before = st().past.length;
    st().setChunkConfirmed("c1", true);
    expect(st().past.length).toBe(before + 1);
    st().undo();
    expect(st().doc.chunks[0].metadata.confirmed).toBeFalsy();
    st().redo();
    expect(st().doc.chunks[0].metadata.confirmed).toBe(true);
  });

  it("does not mark the relationship graph stale (metadata-only, not a content edit)", () => {
    useStore.setState({ analysisStale: false });
    st().setChunkConfirmed("c1", true);
    expect(st().analysisStale).toBe(false);
  });
});

describe("A3 — analysis staleness + dangling prune", () => {
  it("text edits mark stale; metadata edits do not", () => {
    reset([chunk("c1", "text", "x"), chunk("c2", "heading", "H")]);
    useStore.setState({ analysisStale: false });
    st().updateChunkContent("c1", "y");
    expect(st().analysisStale).toBe(true);
    useStore.setState({ analysisStale: false });
    st().setHeadingLevel("c2", 3);
    expect(st().analysisStale).toBe(false);
    useStore.setState({ analysisStale: false });
    st().setChunkLayout("c2", "section");
    expect(st().analysisStale).toBe(false);
  });

  it("deleting a chunk prunes dangling nodes/edges from both graphs", () => {
    reset([chunk("c1", "text"), chunk("c2", "text")]);
    const graph: AnalysisResult = {
      nodes: [node("c1"), node("c2")],
      edges: [{ source: "c1", target: "c2", relation: "" }],
    };
    useStore.setState((s) => ({ analysis: graph, doc: { ...s.doc, analysis: graph } }));
    st().deleteChunk("c2");
    expect(st().analysis?.nodes.map((n) => n.id)).toEqual(["c1"]);
    expect(st().analysis?.edges).toEqual([]);
    expect(st().doc.analysis?.edges).toEqual([]);
  });
});

describe("setChunkLayout — Auto (clear override)", () => {
  it("passing null clears the override so the slide goes back to auto-pick", () => {
    reset([chunk("c1", "heading", "H"), chunk("c2", "text", "x")]);
    st().setChunkLayout("c1", "section");
    expect(st().doc.chunks[0].metadata.layout).toBe("section");
    st().setChunkLayout("c1", null);
    expect(st().doc.chunks[0].metadata.layout).toBeUndefined();
  });
});

describe("setChunkLayout — one override per slide (v1.2)", () => {
  const withLayout = (id: string, type: ChunkType, layout: string): Chunk => {
    const c = chunk(id, type, "x");
    c.metadata.layout = layout as SlideLayout;
    return c;
  };

  it("picking via the host clears a stale override on a later chunk of the slide", () => {
    reset([chunk("h", "heading", "H"), withLayout("a", "text", "image-top")]);
    st().setChunkLayout("h", "section");
    expect(st().doc.chunks[0].metadata.layout).toBe("section");
    expect(st().doc.chunks[1].metadata.layout).toBeUndefined();
  });

  it("Auto (null) clears overrides on ALL chunks of the slide — other slides untouched", () => {
    reset([
      withLayout("h", "heading", "title-content"),
      withLayout("a", "text", "image-top"),
      withLayout("h2", "heading", "section"),
    ]);
    st().setChunkLayout("h", null);
    expect(st().doc.chunks[0].metadata.layout).toBeUndefined();
    expect(st().doc.chunks[1].metadata.layout).toBeUndefined();
    expect(st().doc.chunks[2].metadata.layout).toBe("section"); // next slide keeps its own
  });

  it("an empty-string override reads as Auto (deck.rs parity)", () => {
    reset([withLayout("h", "heading", ""), chunk("a", "text", "x")]);
    const [slide] = groupSlides(st().doc.chunks);
    expect(hasLayoutOverride(slide)).toBe(false);
    expect(resolveLayout(slide)).toBe("title-content"); // auto-picked
  });
});

describe("splitSlideBefore / mergeSlideIntoPrevious (v1.2)", () => {
  it("splitSlideBefore inserts a level-1 'New slide' heading before the chunk and is undoable", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a"), chunk("b", "text", "b")]);
    const id = st().splitSlideBefore("b");
    expect(id).not.toBeNull();
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["h", "a", id, "b"]);
    const inserted = st().doc.chunks[2];
    expect(inserted.metadata.chunkType).toBe("heading");
    expect(inserted.metadata.level).toBe(1);
    expect(inserted.content).toBe("New slide");
    expect(groupSlides(st().doc.chunks)).toHaveLength(2);
    st().undo();
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["h", "a", "b"]);
  });

  it("mergeSlideIntoPrevious demotes the heading so the slides fuse; non-headings no-op", () => {
    reset([
      chunk("h1", "heading", "One"),
      chunk("a", "text", "a"),
      chunk("h2", "heading", "Two"),
      chunk("b", "text", "b"),
    ]);
    expect(groupSlides(st().doc.chunks)).toHaveLength(2);
    expect(st().mergeSlideIntoPrevious("h2")).toBe("h2");
    const demoted = st().doc.chunks[2];
    expect(demoted.metadata.chunkType).toBe("text");
    expect(demoted.metadata.level).toBeUndefined();
    expect(demoted.content).toBe("Two"); // content preserved
    expect(groupSlides(st().doc.chunks)).toHaveLength(1);
    // A text chunk is a toast-less null no-op — no undo step burned.
    const before = st().past.length;
    expect(st().mergeSlideIntoPrevious("a")).toBeNull();
    expect(st().past.length).toBe(before);
  });
});

describe("B4 — undo re-derives the graph for the restored document", () => {
  it("brings the graph back in sync after undoing a structural delete", () => {
    reset([chunk("c1", "text"), chunk("c2", "text")]);
    const graph: AnalysisResult = {
      nodes: [node("c1"), node("c2")],
      edges: [{ source: "c1", target: "c2", relation: "" }],
    };
    st().applyAnalysis(graph);
    expect(st().analysis?.nodes).toHaveLength(2);
    st().deleteChunk("c2");
    expect(st().analysis?.nodes.map((n) => n.id)).toEqual(["c1"]);
    st().undo();
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["c1", "c2"]);
    // The top-level graph now matches the restored doc's graph (B4).
    expect(st().analysis).toEqual(st().doc.analysis);
    expect(st().analysis?.nodes.map((n) => n.id)).toEqual(["c1", "c2"]);
  });
});

describe("B7 — duplicateChunksAfter placement", () => {
  it("inserts the copies after a contiguous block", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a"), chunk("b", "text", "b")]);
    const ids = st().duplicateChunksAfter(["h", "a", "b"]);
    const order = st().doc.chunks.map((c) => c.id);
    expect(order.slice(0, 3)).toEqual(["h", "a", "b"]);
    expect(order.slice(3)).toEqual(ids);
  });

  it("inserts each copy after its own source for a non-contiguous selection", () => {
    reset([chunk("a", "text", "a"), chunk("x", "text", "x"), chunk("b", "text", "b")]);
    const ids = st().duplicateChunksAfter(["a", "b"]);
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["a", ids[0], "x", "b", ids[1]]);
  });
});

describe("insertLocalImageAfter — local image insertion (v1 No.1 priority feature)", () => {
  it("inserts an image chunk after the given id, marked imageSource:'local' with no imagePrompt", () => {
    reset([chunk("a", "text", "a")]);
    const id = st().insertLocalImageAfter("a", "data:image/png;base64,AAA", "photo.png");
    const order = st().doc.chunks.map((c) => c.id);
    expect(order).toEqual(["a", id]);
    const img = st().doc.chunks.find((c) => c.id === id)!;
    expect(img.content).toBe("data:image/png;base64,AAA");
    expect(img.metadata.chunkType).toBe("image");
    expect(img.metadata.imageSource).toBe("local");
    expect(img.metadata.imagePrompt).toBeUndefined();
    expect(img.metadata.summary).toBe("photo.png");
  });

  it("appends at the end when id is null", () => {
    reset([chunk("a", "text", "a"), chunk("b", "text", "b")]);
    const id = st().insertLocalImageAfter(null, "data:image/png;base64,AAA", "x.png");
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["a", "b", id]);
  });

  it("differs from insertImageAfter (AI path), which sets imageSource:'ai' and stores the prompt", () => {
    reset([chunk("a", "text", "a")]);
    const aiId = st().insertImageAfter("a", "data:image/png;base64,BBB", "a cat");
    const aiImg = st().doc.chunks.find((c) => c.id === aiId)!;
    expect(aiImg.metadata.imageSource).toBe("ai");
    expect(aiImg.metadata.imagePrompt).toBe("a cat");
  });

  it("is undoable", () => {
    reset([chunk("a", "text", "a")]);
    const before = st().doc.chunks.map((c) => c.id);
    st().insertLocalImageAfter("a", "data:image/png;base64,AAA", "x.png");
    expect(st().doc.chunks.length).toBe(2);
    st().undo();
    expect(st().doc.chunks.map((c) => c.id)).toEqual(before);
  });
});

describe("setMode — switch view without migrating content", () => {
  it("flips doc.mode, keeps the chunks, and no-ops when unchanged", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a")]);
    expect(st().doc.mode).toBe("editor");
    st().setMode("slide");
    expect(st().doc.mode).toBe("slide");
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["h", "a"]); // same chunks
    expect(st().dirty).toBe(true);
    const docRef = st().doc;
    st().setMode("slide"); // already slide → no state change
    expect(st().doc).toBe(docRef);
    st().setMode("editor");
    expect(st().doc.mode).toBe("editor");
  });
});

describe("setMode — Slide→Editor continuity (flashChunk)", () => {
  it("flashes the last-focused chunk only when RETURNING to editor from slide", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a")]);
    st().setFocused("a");

    // Editor→Slide: SlideEditor derives its own selection from focusedChunkId,
    // so no flash is needed (or fired) going in this direction.
    st().setMode("slide");
    expect(st().flashChunkId).toBeNull();

    // Slide→Editor: the editor view remounts at the top by default, so this
    // scrolls to and highlights the paragraph the user was last on.
    st().setMode("editor");
    expect(st().flashChunkId).toBe("a");
    expect(st().focusedChunkId).toBe("a");
  });

  it("does nothing when there is no focused chunk to return to", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a")]);
    st().setFocused(null);
    st().setMode("slide");
    st().setMode("editor");
    expect(st().flashChunkId).toBeNull();
  });

  it("never flashes when the mode doesn't actually change", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a")]);
    st().setFocused("a");
    st().setMode("editor"); // already editor → no-op, no flash
    expect(st().flashChunkId).toBeNull();
  });
});

describe("summary freshness — hashContent / summaryHash / staleSummaryChunkIds", () => {
  it("hashContent is stable, content-sensitive, and hex-formatted", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("hello!"));
    expect(hashContent("こんにちは")).toBe(hashContent("こんにちは")); // UTF-16 units
    expect(hashContent("")).toMatch(/^[0-9a-f]+$/);
    expect(hashContent("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("setChunkSummary stamps summaryHash for the chunk's current content", () => {
    reset([chunk("c1", "text", "hello")]);
    st().setChunkSummary("c1", "sum");
    const meta = st().doc.chunks[0].metadata;
    expect(meta.summary).toBe("sum");
    expect(meta.summaryHash).toBe(hashContent("hello"));
  });

  it("applyAnalysis stamps analyzedAt on both graphs and summaryHash on summarized chunks", () => {
    reset([chunk("c1", "text", "body")]);
    const before = Date.now();
    st().applyAnalysis({
      nodes: [{ id: "c1", label: "l", summary: "s", kind: "paragraph" }],
      edges: [],
    });
    expect(st().doc.analysis?.analyzedAt).toBeGreaterThanOrEqual(before);
    expect(st().doc.analysis?.analyzedAt).toBeLessThanOrEqual(Date.now());
    expect(st().analysis?.analyzedAt).toBe(st().doc.analysis?.analyzedAt);
    const meta = st().doc.chunks[0].metadata;
    expect(meta.summary).toBe("s");
    expect(meta.summaryHash).toBe(hashContent("body"));
  });

  it("staleSummaryChunkIds: fresh summaries and legacy no-hash summaries are not stale", () => {
    reset([chunk("c1", "text", "hello")]);
    st().setChunkSummary("c1", "sum");
    expect(staleSummaryChunkIds(st().doc)).toEqual([]); // hash matches → fresh

    // Legacy: a summary saved before hashing existed carries no hash — treated
    // as fresh so old documents don't trigger a surprise mass refresh.
    const legacy = chunk("c2", "text", "x");
    legacy.metadata.summary = "old summary";
    expect(staleSummaryChunkIds(doc([legacy]))).toEqual([]);
  });

  it("staleSummaryChunkIds: an edit after summarizing marks the chunk stale", () => {
    reset([chunk("c1", "text", "hello"), chunk("c2", "text", "other")]);
    st().setChunkSummary("c1", "sum");
    st().setChunkSummary("c2", "sum2");
    st().updateChunkContent("c1", "hello edited");
    expect(staleSummaryChunkIds(st().doc)).toEqual(["c1"]); // c2 untouched
  });

  it("pruneAnalysis keeps analyzedAt through a prune (spread regression)", () => {
    const a: AnalysisResult = {
      nodes: [node("c1"), node("gone")],
      edges: [{ source: "c1", target: "gone", relation: "" }],
      analyzedAt: 1234,
    };
    const pruned = pruneAnalysis(a, new Set(["c1"]));
    expect(pruned?.analyzedAt).toBe(1234);
    expect(pruned?.nodes.map((n) => n.id)).toEqual(["c1"]);
    expect(pruned?.edges).toEqual([]);
  });
});

describe("review comments — add/update/delete/resolve/clear", () => {
  beforeEach(() => reset([chunk("c1", "text", "one"), chunk("c2", "text", "two")]));

  const comments = (id: string) =>
    st().doc.chunks.find((c) => c.id === id)?.metadata.comments ?? [];

  it("addComment appends a comment with id/createdAt/author and returns its id", () => {
    const before = Date.now();
    const id = st().addComment("c1", "needs a citation");
    expect(id).toBeTruthy();
    const [cm] = comments("c1");
    expect(cm.id).toBe(id);
    expect(cm.text).toBe("needs a citation");
    expect(cm.author).toBe("user");
    expect(cm.kind).toBeUndefined();
    expect(cm.resolved).toBeUndefined();
    expect(cm.createdAt).toBeGreaterThanOrEqual(before);
    expect(cm.createdAt).toBeLessThanOrEqual(Date.now());
    expect(st().dirty).toBe(true);
  });

  it("addComment on an unknown chunk returns null and burns no undo step", () => {
    const before = st().past.length;
    expect(st().addComment("nope", "x")).toBeNull();
    expect(st().past.length).toBe(before);
  });

  it("update / delete / toggle resolve round-trip, and undo restores prior comments", () => {
    const id = st().addComment("c1", "first draft")!;
    st().updateComment("c1", id, "revised");
    expect(comments("c1")[0].text).toBe("revised");
    st().undo();
    expect(comments("c1")[0].text).toBe("first draft");
    st().redo();
    expect(comments("c1")[0].text).toBe("revised");

    st().toggleCommentResolved("c1", id);
    expect(comments("c1")[0].resolved).toBe(true);
    st().toggleCommentResolved("c1", id);
    expect(comments("c1")[0].resolved).toBe(false);

    st().deleteComment("c1", id);
    expect(comments("c1")).toEqual([]);
    st().undo();
    expect(comments("c1")[0].text).toBe("revised"); // delete undone
    st().undo(); // un-toggle
    st().undo(); // un-toggle
    st().undo(); // un-update
    expect(comments("c1")[0].text).toBe("first draft");
    st().undo(); // un-add
    expect(comments("c1")).toEqual([]);
  });

  it("comment mutations never mark the relationship graph stale", () => {
    useStore.setState({ analysisStale: false });
    const id = st().addComment("c1", "note")!;
    st().updateComment("c1", id, "note 2");
    st().toggleCommentResolved("c1", id);
    st().deleteComment("c1", id);
    st().clearAiComments();
    expect(st().analysisStale).toBe(false);
  });

  it("clearAiComments removes only ai-authored comments", () => {
    st().addComment("c1", "mine");
    st().addComment("c1", "robot says", "ai", "review");
    st().addComment("c2", "robot too", "ai", "integrity");
    st().clearAiComments();
    expect(comments("c1").map((c) => c.text)).toEqual(["mine"]);
    expect(comments("c2")).toEqual([]);
  });

  it("clearAiComments(kind) removes only that kind", () => {
    st().addComment("c1", "review note", "ai", "review");
    st().addComment("c1", "integrity note", "ai", "integrity");
    st().addComment("c1", "mine");
    st().clearAiComments("review");
    expect(comments("c1").map((c) => c.text)).toEqual(["integrity note", "mine"]);
  });

  it("clearAiComments with nothing to clear is a no-op (no undo step)", () => {
    st().addComment("c1", "mine");
    const before = st().past.length;
    st().clearAiComments();
    expect(st().past.length).toBe(before);
    expect(comments("c1")).toHaveLength(1);
  });

  it("comment mutations preserve the object identity of untouched chunks", () => {
    const other = () => st().doc.chunks.find((c) => c.id === "c2")!;
    let ref = other();
    const id = st().addComment("c1", "note")!;
    expect(other()).toBe(ref);
    ref = other();
    st().updateComment("c1", id, "note 2");
    expect(other()).toBe(ref);
    ref = other();
    st().toggleCommentResolved("c1", id);
    expect(other()).toBe(ref);
    // clearAiComments keeps identity for chunks without matching ai comments.
    st().addComment("c1", "robot", "ai", "review");
    ref = other();
    st().clearAiComments("review");
    expect(other()).toBe(ref);
    ref = other();
    st().deleteComment("c1", id);
    expect(other()).toBe(ref);
  });

  it("comments survive pruneAnalysis and mutations on other chunks", () => {
    st().addComment("c1", "keep me");
    const graph: AnalysisResult = {
      nodes: [node("c1"), node("c2")],
      edges: [{ source: "c1", target: "c2", relation: "" }],
    };
    useStore.setState((s) => ({ analysis: graph, doc: { ...s.doc, analysis: graph } }));
    const c1Before = st().doc.chunks.find((c) => c.id === "c1")!;
    st().deleteChunk("c2"); // prunes the graph; c1 untouched
    expect(st().doc.chunks.find((c) => c.id === "c1")).toBe(c1Before); // identity kept
    expect(comments("c1").map((c) => c.text)).toEqual(["keep me"]);
    st().updateChunkContent("c1", "edited");
    expect(comments("c1").map((c) => c.text)).toEqual(["keep me"]);
  });
});

describe("review panel flags", () => {
  it("toggleReviewPanel follows the networkOpen pattern; closing clears the composer target", () => {
    reset([chunk("c1", "text", "one")]);
    useStore.setState({ reviewPanelOpen: false, reviewTargetChunkId: null });
    st().toggleReviewPanel();
    expect(st().reviewPanelOpen).toBe(true);
    st().setReviewTarget("c1");
    expect(st().reviewTargetChunkId).toBe("c1");
    st().toggleReviewPanel(false);
    expect(st().reviewPanelOpen).toBe(false);
    expect(st().reviewTargetChunkId).toBeNull();
    st().toggleReviewPanel(true);
    expect(st().reviewPanelOpen).toBe(true);
  });
});

describe("Markdown preview zoom", () => {
  it("defaults to 100%", () => {
    reset([chunk("c1", "text", "one")]);
    expect(st().markdownZoom).toBe(1);
  });

  it("zooms in and out in steps and clamps to a readable range", () => {
    reset([chunk("c1", "text", "one")]);
    st().setMarkdownZoom(1.25);
    expect(st().markdownZoom).toBe(1.25);
    // Far outside the range on both ends: clamped, never 0 or unreadably huge.
    st().setMarkdownZoom(99);
    expect(st().markdownZoom).toBe(2.5);
    st().setMarkdownZoom(0.01);
    expect(st().markdownZoom).toBe(0.6);
  });

  it("rounds to whole percent so the readout can never show 109.99999%", () => {
    reset([chunk("c1", "text", "one")]);
    st().setMarkdownZoom(1.1 + 0.2); // 1.3000000000000003 in binary floating point
    expect(st().markdownZoom).toBe(1.3);
  });

  it("ignores a non-finite value instead of blanking the preview", () => {
    reset([chunk("c1", "text", "one")]);
    st().setMarkdownZoom(1.4);
    st().setMarkdownZoom(Number.NaN);
    expect(st().markdownZoom).toBe(1.4);
  });
});

describe("folder tree sidebar flags", () => {
  it("folderTreeOpen defaults to true and folderRoot to null", () => {
    reset([chunk("c1", "text", "one")]);
    expect(st().folderTreeOpen).toBe(true);
    expect(st().folderRoot).toBeNull();
  });

  it("toggleFolderTree follows the networkOpen pattern", () => {
    reset([chunk("c1", "text", "one")]);
    st().toggleFolderTree(false);
    expect(st().folderTreeOpen).toBe(false);
    st().toggleFolderTree();
    expect(st().folderTreeOpen).toBe(true);
    st().toggleFolderTree(false);
    expect(st().folderTreeOpen).toBe(false);
  });

  it("setFolderRoot sets the root and opening a folder implies the sidebar is shown", () => {
    reset([chunk("c1", "text", "one")]);
    st().toggleFolderTree(false);
    st().setFolderRoot("/Users/me/notes");
    expect(st().folderRoot).toBe("/Users/me/notes");
    st().setFolderRoot(null);
    expect(st().folderRoot).toBeNull();
  });
});

describe("A2 — hydrateSession", () => {
  it("restores every tab with the active one live and the rest as snapshots", () => {
    reset([chunk("a", "text")]);
    const docA = doc([chunk("a", "text", "A")], "A");
    const docB = doc([chunk("b", "text", "B")], "B");
    st().hydrateSession(
      [
        { id: "t1", doc: docA, filePath: "/a.aix", dirty: false },
        { id: "t2", doc: docB, filePath: null, dirty: true },
      ],
      "t2"
    );
    expect(st().activeTabId).toBe("t2");
    expect(st().doc).toBe(docB);
    expect(st().tabOrder).toEqual(["t1", "t2"]);
    expect(Object.keys(st().inactiveTabs)).toEqual(["t1"]);
    expect(st().inactiveTabs["t1"].doc).toBe(docA);
    st().switchTab("t1");
    expect(st().doc).toBe(docA);
    expect(st().filePath).toBe("/a.aix");
  });
});

describe("items 3/4 — multi-paragraph merge", () => {
  it("merges adjacent text chunks into the first with smart separators", () => {
    reset([
      chunk("a", "text", "First sentence."),
      chunk("b", "text", "second part"),
      chunk("c", "text", "third"),
    ]);
    // comments + summary on members to verify carry/clear semantics
    st().addComment("a", "keep me", "user");
    st().addComment("b", "carried", "ai", "review");
    st().setChunkSummary("a", "old summary");

    const merged = st().mergeChunks(["a", "b", "c"]);
    expect(merged).toBe("a");
    const chunks = st().doc.chunks;
    expect(chunks).toHaveLength(1);
    // Latin boundary gets a single space at each joint.
    expect(chunks[0].content).toBe("First sentence. second part third");
    // Comments concatenated onto the survivor; summary cleared (text changed).
    expect(chunks[0].metadata.comments?.map((c) => c.text)).toEqual([
      "keep me",
      "carried",
    ]);
    expect(chunks[0].metadata.summary).toBeUndefined();
    expect(chunks[0].metadata.summaryHash).toBeUndefined();
    expect(st().selectedChunkIds).toEqual([]);
    expect(st().focusedChunkId).toBe("a");
  });

  it("joins CJK↔CJK without a space and is undoable", () => {
    reset([chunk("a", "text", "日本語の文章"), chunk("b", "text", "続きの段落")]);
    st().mergeChunks(["a", "b"]);
    expect(st().doc.chunks[0].content).toBe("日本語の文章続きの段落");
    st().undo();
    expect(st().doc.chunks).toHaveLength(2);
    expect(st().doc.chunks.map((c) => c.content)).toEqual([
      "日本語の文章",
      "続きの段落",
    ]);
  });

  it("rejects non-contiguous or non-text selections", () => {
    reset([
      chunk("a", "text", "A"),
      chunk("h", "heading", "H"),
      chunk("b", "text", "B"),
    ]);
    expect(st().mergeChunks(["a", "b"])).toBeNull(); // not adjacent
    expect(st().mergeChunks(["a", "h"])).toBeNull(); // heading member
    expect(st().mergeChunks(["a"])).toBeNull(); // needs ≥2
    expect(st().doc.chunks).toHaveLength(3); // untouched, no undo step
    expect(st().past).toHaveLength(0);
  });

  it("prunes merged-away ids from the analysis graph", () => {
    reset([chunk("a", "text", "A"), chunk("b", "text", "B")]);
    const analysis: AnalysisResult = {
      nodes: [node("a"), node("b")],
      edges: [{ source: "a", target: "b", relation: "evidence" }],
    };
    st().applyAnalysis(analysis);
    st().mergeChunks(["a", "b"]);
    expect(st().analysis?.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(st().analysis?.edges).toEqual([]);
  });
});

describe("item 14 — speech queue mechanics", () => {
  it("set/shift round-trips and empties", () => {
    reset([chunk("a", "text", "A")]);
    st().setSpeechQueue(["x", "y"]);
    expect(st().speechQueue).toEqual(["x", "y"]);
    expect(st().shiftSpeechQueue()).toBe("x");
    expect(st().shiftSpeechQueue()).toBe("y");
    expect(st().shiftSpeechQueue()).toBeNull();
    expect(st().speechQueue).toEqual([]);
  });

  it("is cleared when switching tabs (transient per-view state)", () => {
    reset([chunk("a", "text", "A")]);
    st().setSpeechQueue(["a"]);
    st().newTab();
    expect(st().speechQueue).toEqual([]);
  });
});

describe("item 1-3 — presentation mode", () => {
  // Full keyboard/rendering behaviour is verified manually (see
  // PresentationMode.tsx's top-of-file comment) — disproportionate to
  // integration-test here. The pure index math it's built on gets a direct
  // unit test instead, since "arrow-key navigation never goes out of bounds"
  // is exactly the kind of user-visible claim this project's testing rules
  // require a guard for.
  describe("clampPresentIndex", () => {
    it("advances and retreats within bounds", () => {
      expect(clampPresentIndex(0, 1, 5)).toBe(1);
      expect(clampPresentIndex(2, -1, 5)).toBe(1);
    });

    it("clamps at the first slide — does not go negative", () => {
      expect(clampPresentIndex(0, -1, 5)).toBe(0);
    });

    it("clamps at the last slide — does not exceed the deck", () => {
      expect(clampPresentIndex(4, 1, 5)).toBe(4);
    });

    it("returns 0 for an empty deck regardless of direction", () => {
      expect(clampPresentIndex(0, 1, 0)).toBe(0);
      expect(clampPresentIndex(0, -1, 0)).toBe(0);
    });

    it("re-clamps a current index that is already out of range (deck shrank)", () => {
      // Mirrors the SlideEditor B6 fix: an undo mid-presentation can shrink the
      // deck out from under an existing (now too-large) index.
      expect(clampPresentIndex(9, 0, 3)).toBe(2);
    });
  });

  describe("openPresentation / closePresentation", () => {
    it("opens and closes the ephemeral overlay flag", () => {
      reset([chunk("a", "heading", "Slide 1")]);
      expect(st().presentationOpen).toBe(false);
      st().openPresentation();
      expect(st().presentationOpen).toBe(true);
      st().closePresentation();
      expect(st().presentationOpen).toBe(false);
    });

    it("is a global flag, not per-tab state — it is unaffected by tab switches", () => {
      // presentationOpen deliberately lives alongside networkOpen/diffPanelOpen
      // (not in TabSnapshot), so — like those — it is untouched by newTab/
      // switchTab. This documents that choice with a guard: if it were ever
      // moved into TabSnapshot, this test would catch the behaviour change.
      reset([chunk("a", "heading", "Slide 1")]);
      st().openPresentation();
      st().newTab();
      expect(st().presentationOpen).toBe(true);
    });
  });
});

describe("item 1-2 — savedDoc baseline lifecycle", () => {
  it("a freshly loaded/imported document is its own baseline (dirty:false case)", () => {
    reset([chunk("a", "text", "hello")]);
    const opened = doc([chunk("x", "text", "opened content")], "Opened");
    st().loadDocument(opened, "/some/path.aix");
    expect(st().dirty).toBe(false);
    expect(st().savedDoc).toBe(opened);
  });

  it("a repaired-on-load / drafted document is still its own baseline even though dirty:true", () => {
    // B2: opts.dirty can be true (repaired file, AI draft with no backing file),
    // but savedDoc must still equal the just-loaded doc — "changes since last
    // save" reads as "since this doc showed up", not against some other state.
    reset([chunk("a", "text", "hello")]);
    const imported = doc([chunk("y", "text", "imported content")], "Imported");
    st().loadDocument(imported, null, { dirty: true });
    expect(st().dirty).toBe(true);
    expect(st().savedDoc).toBe(imported);
  });

  it("a new blank tab's baseline is itself", () => {
    reset([chunk("a", "text", "hello")]);
    st().newTab();
    expect(st().dirty).toBe(false);
    expect(st().savedDoc).toBe(st().doc);
  });

  it("markClean() after a save sets savedDoc to the current doc in the SAME action as dirty:false", () => {
    reset([chunk("a", "text", "hello")]);
    st().updateChunkContent("a", "hello, edited");
    expect(st().dirty).toBe(true);
    expect(st().savedDoc).not.toBe(st().doc); // still diverged pre-save
    st().markClean("/path/to/file.aix");
    expect(st().dirty).toBe(false);
    expect(st().savedDoc).toBe(st().doc); // baseline now matches — no false diff
    expect(st().filePath).toBe("/path/to/file.aix");
  });

  it("markClean(path, savedDocument) anchors the baseline to what was ACTUALLY written, not a keystroke that landed during the async save", () => {
    // Regression guard: saveNative/saveNativeAs await an IPC write without
    // blocking the editor. If a keystroke lands in that gap, markClean must
    // not silently promote it into the baseline (dirty:false + savedDoc
    // pointing past what's really on disk would make the diff panel lie).
    reset([chunk("a", "text", "hello")]);
    const writtenDoc = st().doc; // snapshot captured "before the await"
    st().updateChunkContent("a", "hello, typed during the save"); // race window
    expect(st().doc).not.toBe(writtenDoc);
    st().markClean("/path/to/file.aix", writtenDoc);
    expect(st().dirty).toBe(false);
    expect(st().savedDoc).toBe(writtenDoc); // baseline = what was saved
    expect(st().savedDoc).not.toBe(st().doc); // NOT the newer, unsaved doc
    // The diff view must still report the mid-save keystroke as a real change.
    const diff = documentDiff(st().savedDoc, st().doc);
    expect(diff.changed.map((c) => c.id)).toEqual(["a"]);
  });

  it("carries savedDoc into and out of the inactive-tab snapshot across a tab switch (round-trip)", () => {
    reset([chunk("a", "text", "hello")]);
    const tabA = st().activeTabId;
    // Edit tab A so its savedDoc (baseline) and doc (current) diverge.
    st().updateChunkContent("a", "hello, edited on A");
    const savedDocA = st().savedDoc;
    const currentDocA = st().doc;
    expect(savedDocA).not.toBe(currentDocA);

    st().newTab(); // switches away — tab A becomes a snapshot
    // The new tab's own baseline should be itself, not leaked from tab A.
    expect(st().savedDoc).toBe(st().doc);
    expect(st().savedDoc).not.toBe(savedDocA);

    st().switchTab(tabA);
    // Tab A's baseline/current pair must come back EXACTLY as they were —
    // savedDoc must not have been lost (reset to current doc) or leaked from
    // the tab we just left.
    expect(st().doc).toBe(currentDocA);
    expect(st().savedDoc).toBe(savedDocA);
    expect(st().savedDoc).not.toBe(st().doc);
  });

  it("hydrateSession gives every restored tab (active and inactive) its doc as its own baseline", () => {
    reset([chunk("a", "text")]);
    const docA = doc([chunk("a", "text", "A")], "A");
    const docB = doc([chunk("b", "text", "B")], "B");
    st().hydrateSession(
      [
        { id: "t1", doc: docA, filePath: "/a.aix", dirty: false },
        { id: "t2", doc: docB, filePath: null, dirty: true },
      ],
      "t2"
    );
    expect(st().savedDoc).toBe(docB); // active tab
    expect(st().inactiveTabs["t1"].savedDoc).toBe(docA); // inactive tab
    st().switchTab("t1");
    expect(st().savedDoc).toBe(docA); // round-trips correctly
  });

  it("does not touch ChunkMetadata.contentHistory — an unrelated, independent mechanism", () => {
    // contentHistory is the per-chunk AI-version-swap history (replaceChunkContent
    // / selectChunkVersion); the diff-since-last-save feature must never read or
    // write it — the two mechanisms are independent by design.
    reset([chunk("a", "text", "hello")]);
    st().replaceChunkContent("a", "hello, ai-edited");
    const histAfterAiEdit = st().doc.chunks[0].metadata.contentHistory;
    expect(histAfterAiEdit).toEqual(["hello"]);
    st().markClean("/path.aix");
    // markClean must not have mutated contentHistory in any way.
    expect(st().doc.chunks[0].metadata.contentHistory).toEqual(["hello"]);
    expect(st().savedDoc?.chunks[0].metadata.contentHistory).toEqual(["hello"]);
  });
});

describe("2-4 — ghost-text inline completion", () => {
  beforeEach(() => reset([chunk("a", "text", "The quick brown fox")]));

  it("startGhostRequest issues increasing ids and a superseded request's late result is discarded", () => {
    const firstId = st().startGhostRequest();
    const secondId = st().startGhostRequest();
    expect(secondId).toBeGreaterThan(firstId);

    // The newer request "wins": apply its suggestion first...
    st().setGhostSuggestion("a", " jumps", secondId);
    expect(st().ghostSuggestion).toEqual({ chunkId: "a", text: " jumps" });

    // ...then the OLDER (superseded) request's late-arriving result must be a
    // no-op — it must NOT clobber the newer suggestion, and must not appear at
    // all even if nothing had been set yet.
    st().setGhostSuggestion("a", " over the lazy dog", firstId);
    expect(st().ghostSuggestion).toEqual({ chunkId: "a", text: " jumps" });
  });

  it("an older request's result is discarded even when it is the ONLY result received", () => {
    const firstId = st().startGhostRequest();
    st().startGhostRequest(); // a newer keystroke supersedes it — result never checked here
    // The stale request's delta arrives after being superseded.
    st().setGhostSuggestion("a", " stale suggestion", firstId);
    expect(st().ghostSuggestion).toBeNull();
  });

  it("accepting a suggestion inserts EXACTLY the suggested text at the cursor, nothing else added or lost", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps over the lazy dog", id);
    expect(st().ghostSuggestion?.text).toBe(" jumps over the lazy dog");

    // Mirrors ChunkView's Tab-accept handler: content + suggestion, then clear.
    const before = st().doc.chunks[0].content;
    const accepted = before + (st().ghostSuggestion?.text ?? "");
    st().clearGhostSuggestion();
    st().updateChunkContent("a", accepted);

    expect(st().doc.chunks[0].content).toBe("The quick brown fox jumps over the lazy dog");
    expect(st().ghostSuggestion).toBeNull();
  });

  it("rejecting (Escape) leaves the original chunk content completely unchanged", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps over the lazy dog", id);
    const before = st().doc.chunks[0].content;

    // Mirrors ChunkView's Escape handler: clear only, no content mutation.
    st().clearGhostSuggestion();

    expect(st().doc.chunks[0].content).toBe(before);
    expect(st().doc.chunks[0].content).toBe("The quick brown fox");
    expect(st().ghostSuggestion).toBeNull();
  });

  it("a suggestion for one chunk does not leak onto another chunk's render", () => {
    reset([chunk("a", "text", "one"), chunk("b", "text", "two")]);
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " continued", id);
    expect(st().ghostSuggestion?.chunkId).toBe("a");
    // ChunkView only renders when ghostSuggestion.chunkId === its own id, so a
    // chunk "b" component would see this as no suggestion for itself.
    expect(st().ghostSuggestion?.chunkId).not.toBe("b");
  });

  it("a late delta arriving after Escape-dismiss must not resurrect the suggestion", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).not.toBeNull();

    // User hits Escape (mirrors ChunkView's Escape handler).
    st().clearGhostSuggestion();
    expect(st().ghostSuggestion).toBeNull();

    // The stream backing THIS SAME requestId is still in flight (streams are
    // not server-cancelled) and delivers one more delta / its final resolution.
    st().setGhostSuggestion("a", " jumps over", id);

    // A dismissed suggestion must stay dismissed.
    expect(st().ghostSuggestion).toBeNull();
  });

  it("a late delta arriving after Tab-accept must not resurrect a suggestion for content already merged in", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);

    // Mirrors ChunkView's Tab-accept handler.
    const before = st().doc.chunks[0].content;
    const accepted = before + (st().ghostSuggestion?.text ?? "");
    st().clearGhostSuggestion();
    st().updateChunkContent("a", accepted);
    expect(st().doc.chunks[0].content).toBe("The quick brown fox jumps");
    expect(st().ghostSuggestion).toBeNull();

    // The same in-flight stream (same requestId) delivers a late final delta.
    st().setGhostSuggestion("a", " jumps over the lazy dog", id);

    // Must stay dismissed — the acceptance already happened; resurrecting a
    // suggestion here would show a ghost overlay for text that doesn't match
    // what's now in the box, and a second Tab would duplicate content.
    expect(st().ghostSuggestion).toBeNull();
  });
});

/** Minimal valid Settings fixture; override just the field(s) under test. */
function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "m",
    models: ["m"],
    imageModel: "im",
    imageModels: ["im"],
    defaultTargetLanguage: "English",
    writingTone: "neutral",
    temperature: 0.3,
    ...overrides,
  };
}

describe("Blindspot QA v1 (project.md Q13) — first-run worked example", () => {
  describe("makeWelcomeExampleDoc", () => {
    it("produces a heading, three progress-note text chunks, and one local-image chunk captioned as this week's plot", () => {
      const doc = makeWelcomeExampleDoc();
      expect(doc.chunks).toHaveLength(5);
      expect(doc.chunks.map((c) => c.metadata.chunkType)).toEqual([
        "heading",
        "text",
        "text",
        "text",
        "image",
      ]);

      // Heading explicitly connects the dots: this doc IS the slides too.
      const heading = doc.chunks[0];
      expect(heading.content.length).toBeGreaterThan(0);
      const intro = doc.chunks[1];
      expect(intro.content.toLowerCase()).toContain("slides");

      // The two remaining text chunks carry genuine progress-note content
      // (non-empty, not placeholder-empty like emptyChunk()).
      for (const c of doc.chunks.slice(2, 4)) {
        expect(c.metadata.chunkType).toBe("text");
        expect(c.content.trim().length).toBeGreaterThan(10);
      }

      // The image chunk demonstrates the own-figures feature: imageSource
      // "local" (not "ai"), a data URL (no remote fetch), and a caption
      // identifying it as this week's plot.
      const image = doc.chunks[4];
      expect(image.metadata.imageSource).toBe("local");
      expect(image.content.startsWith("data:image/svg+xml,")).toBe(true);
      expect(image.metadata.summary?.toLowerCase()).toContain("this week");
    });

    it("does not hardcode a real date in the heading", () => {
      const doc = makeWelcomeExampleDoc();
      // A real date would contain a 4-digit year; the label must stay generic.
      expect(doc.chunks[0].content).not.toMatch(/\b(19|20)\d{2}\b/);
    });
  });

  describe("loadWelcomeExampleIfFirstRun", () => {
    it("on first run (flag false, pristine tab) loads the example doc and reports it fired", () => {
      reset([chunk("a", "text", "")]); // pristine: blank, untitled, undirtied
      const fired = st().loadWelcomeExampleIfFirstRun(
        settings({ hasSeenWelcomeExample: false })
      );
      expect(fired).toBe(true);
      expect(st().doc.chunks).toHaveLength(5);
      expect(st().doc.chunks[4].metadata.imageSource).toBe("local");
      expect(st().doc.title).toBe("Weekly progress note (example)");
    });

    it("subsequent calls with the flag already true leave the existing blank document unchanged", () => {
      reset([chunk("a", "text", "")]);
      const before = st().doc;
      const fired = st().loadWelcomeExampleIfFirstRun(
        settings({ hasSeenWelcomeExample: true })
      );
      expect(fired).toBe(false);
      expect(st().doc).toBe(before); // untouched, same object identity
      expect(st().doc.chunks).toHaveLength(1);
      expect(st().doc.chunks[0].content).toBe("");
    });

    it("does not fire when the active tab is no longer pristine, even with the flag false", () => {
      reset([chunk("a", "text", "already typing something")]);
      const before = st().doc;
      const fired = st().loadWelcomeExampleIfFirstRun(
        settings({ hasSeenWelcomeExample: false })
      );
      expect(fired).toBe(false);
      expect(st().doc).toBe(before);
    });
  });

  describe("newTab — ongoing behavior is unaffected by the welcome example", () => {
    it("newTab() always produces the existing blank single-paragraph document, regardless of the flag", () => {
      reset([chunk("a", "text", "x")]);
      st().newTab();
      expect(st().doc.chunks).toHaveLength(1);
      expect(st().doc.chunks[0].metadata.chunkType).toBe("text");
      expect(st().doc.chunks[0].content).toBe("");
      expect(st().doc.title).toBe("");
    });
  });
});
