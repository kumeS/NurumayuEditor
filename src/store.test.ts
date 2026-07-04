import { beforeEach, describe, expect, it } from "vitest";
import { groupSlides, hasLayoutOverride, resolveLayout } from "./slides";
import {
  hashContent,
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
