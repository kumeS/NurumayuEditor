import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentDiff } from "./diff";
import { documentToMarkdown, eolOf, markdownToDocument, normalizeEol, restoreEol } from "./markdown";
import { groupSlides, hasLayoutOverride, resolveLayout, slideLead, slideNotes } from "./slides";
import {
  AI_OP_LOG_MAX,
  FIND_INITIAL,
  UNDO_IDLE_MS,
  captureOp,
  clampPresentIndex,
  hashContent,
  makeWelcomeExampleDoc,
  ownsOp,
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
    // Undo idle-boundary clock, baseline-cleanliness flag, model-issue chip
    // and the AI op log are all per-test state (loadDocument sets docNonce).
    lastEditAt: 0,
    savedDocIsClean: true,
    aiModelIssue: null,
    aiOpLog: [],
    // BUG-010: the find bar's UI state is global, not per document.
    find: { ...FIND_INITIAL },
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

  // BUG-019b (flipped from "clears stale raw source after a chunk-side
  // edit", which encoded the bug): the source is kept as the merge baseline,
  // so only the edited paragraph's bytes change.
  it("keeps the source as the merge baseline after a chunk-side edit", () => {
    st().setMode("markdown");
    const source = "# Title\n\n\nBody  \n\n#### deep\n";
    st().setMarkdownSource(source);
    const bodyId = st().doc.chunks[0].id;
    st().setMode("editor");
    st().updateChunkContent(bodyId, "Changed in paragraph editor");

    expect(st().doc.markdownSource).toBe(source);
    expect(documentToMarkdown(st().doc)).toBe("# Title\n\n\nChanged in paragraph editor\n\n#### deep\n");
    st().setMode("markdown");
    expect(st().doc.markdownSource).toBe("# Title\n\n\nChanged in paragraph editor\n\n#### deep\n");
  });
});

describe("BUG-019a/b — view switches and metadata never rewrite a .md", () => {
  const S = "---\nk: v\n---\n\n# 見出し\n\n#### x\n\na\n\n\n\nb  \n\n**太字**";
  const openMd = (source: string) => {
    reset([chunk("a", "text")]);
    st().loadDocument(markdownToDocument({ ...doc([]), title: "stem" }, source), "/x.md");
  };

  it("setMode is view-only: Markdown → Editor → Markdown keeps dirty and the source", () => {
    openMd("# 見出し\n\n**太字**");
    st().setMode("editor");
    st().setMode("markdown");
    expect(st().dirty).toBe(false);
    expect(st().doc.markdownSource).toBe("# 見出し\n\n**太字**");
  });

  it("Markdown → Slides → Markdown keeps dirty and the source", () => {
    openMd(S);
    st().setMode("slide");
    expect(st().dirty).toBe(false);
    st().setMode("markdown");
    expect(st().dirty).toBe(false);
    expect(st().doc.markdownSource).toBe(S);
  });

  it("speaker notes and layout on an opened .md do not touch its Markdown", () => {
    openMd(S);
    st().setMode("slide");
    const headingId = st().doc.chunks.find((c) => c.metadata.chunkType === "heading")!.id;
    st().setChunkNotes(headingId, "n");
    st().setChunkLayout(headingId, "section");
    expect(documentToMarkdown(st().doc)).toBe(S);
    st().setMode("markdown");
    expect(documentToMarkdown(st().doc)).toBe(S);
  });

  it("a chunk-level edit made IN Markdown mode is folded into the source", () => {
    openMd(S);
    const bId = st().doc.chunks.find((c) => c.content === "b")!.id;
    st().updateChunkContent(bId, "b2");
    expect(st().doc.markdownSource).toBe(S.replace("b  \n", "b2\n"));
    st().setChunkNotes(bId, "note only");
    expect(st().doc.markdownSource).toBe(S.replace("b  \n", "b2\n"));
  });

  it("setTitle rewrites only the H1 line of the baseline", () => {
    openMd(S);
    st().setMode("editor");
    st().setTitle("新しい");
    expect(documentToMarkdown(st().doc)).toBe(S.replace("# 見出し", "# 新しい"));
  });

  it("a .md without an H1 gains `# title` only when the user edits the title", () => {
    openMd("body  \n\n\nmore\n");
    st().setMode("editor");
    st().setMode("markdown");
    expect(st().doc.markdownSource).toBe("body  \n\n\nmore\n"); // stem title is NOT injected
    st().setMode("editor");
    st().setTitle("Mine");
    expect(documentToMarkdown(st().doc)).toBe("# Mine\n\nbody  \n\n\nmore\n");
  });
});

describe("Markdown preview edits are separate undo steps", () => {
  beforeEach(() => reset([chunk("a", "text", "Original")]));

  it("one ⌘Z undoes exactly one preview edit, not the typing before it", () => {
    st().setMode("markdown");
    st().setMarkdownSource("# T\n\nfirst\n"); // e.g. typing in the source editor
    st().setMarkdownSource("# T\n\nfirst edited\n", { newUndoStep: true }); // a preview edit
    st().undo();
    expect(st().doc.markdownSource).toBe("# T\n\nfirst\n");
  });

  it("source-editor typing still coalesces into one step", () => {
    st().setMode("markdown");
    st().setMarkdownSource("# T\n\na\n");
    const depth = st().past.length;
    st().setMarkdownSource("# T\n\nab\n");
    expect(st().past.length).toBe(depth);
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
    // BUG-019a (flipped from `true`, which encoded the bug): the mode is a
    // view flag, so switching it is not an unsaved change.
    expect(st().dirty).toBe(false);
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

describe("Markdown preview column offset", () => {
  it("starts centred, stores whole pixels, and ignores a non-number", () => {
    useStore.setState({ markdownOffsetX: 0 });
    expect(st().markdownOffsetX).toBe(0);
    st().setMarkdownOffsetX(-120.4);
    expect(st().markdownOffsetX).toBe(-120);
    st().setMarkdownOffsetX(Number.NaN);
    expect(st().markdownOffsetX).toBe(-120);
    st().setMarkdownOffsetX(0);
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
    // Regression guard for the synchronous markClean form (legacy / test-only
    // path: no production save calls it). The async save paths
    // (saveNative/saveNativeAs) route through markTabClean instead — covered
    // directly by the "markTabClean: a keystroke during the write keeps the tab
    // dirty" test below and end to end by fileActions.test.ts "a keystroke
    // during the write keeps the tab dirty (baseline = what was written)".
    // Here: given an explicit savedDocument, markClean must not silently
    // promote a newer doc into the baseline (savedDoc pointing past what's
    // really on disk would make the diff panel lie).
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

  it("markTabClean: a keystroke during the write keeps the tab dirty, with the baseline = what was written", () => {
    // The production form of the save mark (state-async-3): saveNative /
    // saveNativeAs capture the tab + load, await the write, then call this.
    reset([chunk("a", "text", "hello")]);
    const tabId = st().activeTabId;
    const nonce = st().docNonce;
    const writtenDoc = st().doc; // snapshot captured "before the await"
    st().updateChunkContent("a", "hello, typed during the save"); // race window
    expect(st().markTabClean(tabId, nonce, "/path/to/file.aix", writtenDoc)).toBe(true);
    expect(st().dirty).toBe(true); // the live doc is past what was written
    expect(st().savedDoc).toBe(writtenDoc);
    expect(st().savedDocIsClean).toBe(true);
    expect(st().filePath).toBe("/path/to/file.aix");
    expect(documentDiff(st().savedDoc, st().doc).changed.map((c) => c.id)).toEqual(["a"]);
  });

  it("markTabClean: no keystroke during the write -> clean; a stale load nonce -> refused, nothing changes", () => {
    reset([chunk("a", "text", "hello")]);
    const tabId = st().activeTabId;
    st().updateChunkContent("a", "hello, edited");
    const nonce = st().docNonce;
    const writtenDoc = st().doc;
    expect(st().markTabClean(tabId, nonce + 1, "/elsewhere.aix", writtenDoc)).toBe(false);
    expect(st().dirty).toBe(true);
    expect(st().filePath).not.toBe("/elsewhere.aix");
    expect(st().markTabClean(tabId, nonce, undefined, writtenDoc)).toBe(true);
    expect(st().dirty).toBe(false);
    expect(st().savedDoc).toBe(writtenDoc);
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
    // The legacy chunk-id form records the context it was generated for: the
    // chunk's current text, the active tab and the current document load.
    const expected = {
      chunkId: "a",
      text: " jumps",
      prefix: "The quick brown fox",
      tabId: "tab-1",
      docNonce: st().docNonce,
    };
    expect(st().ghostSuggestion).toEqual(expected);

    // ...then the OLDER (superseded) request's late-arriving result must be a
    // no-op — it must NOT clobber the newer suggestion, and must not appear at
    // all even if nothing had been set yet.
    st().setGhostSuggestion("a", " over the lazy dog", firstId);
    expect(st().ghostSuggestion).toEqual(expected);
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

    // The production accept path (ChunkView's Tab handler delegates to it).
    expect(st().acceptGhostSuggestion("a")).toBe(true);

    expect(st().doc.chunks[0].content).toBe("The quick brown fox jumps over the lazy dog");
    expect(st().ghostSuggestion).toBeNull();
    expect(st().dirty).toBe(true);
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

    // The production accept path (ChunkView's Tab handler delegates to it).
    expect(st().acceptGhostSuggestion("a")).toBe(true);
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

// ===== w1-store lane (BUG-001a/b/d, 002, 005b, 015a, 018, 013c, MISS-01/12) =====

describe("BUG-001b — document identity (docNonce / captureOp / ownsOp)", () => {
  it("loadDocument into the SAME tab id invalidates ops captured before it", () => {
    reset([chunk("a", "text", "QA_AIX_TEST_")]);
    const op = st().captureOp();
    expect(st().ownsOp(op)).toBe(true);
    // Same tab id, same chunk ids — a reopened copy of the same .aix.
    st().loadDocument(doc([chunk("a", "text", "QA_AIX_TEST_001")]), "/x.aix");
    expect(st().activeTabId).toBe(op.tabId);
    expect(st().ownsOp(op)).toBe(false);
  });

  it("an op survives a switchTab round-trip (the nonce is restored, not bumped)", () => {
    reset([chunk("a", "text", "x")]);
    const tabA = st().activeTabId;
    const op = st().captureOp();
    st().newTab();
    expect(st().ownsOp(op)).toBe(false); // another tab is active
    expect(st().inactiveTabs[tabA].docNonce).toBe(op.docNonce);
    st().switchTab(tabA);
    expect(st().ownsOp(op)).toBe(true);
  });

  it("every newTab / hydrated tab gets its own nonce", () => {
    reset([chunk("a", "text", "x")]);
    const before = st().captureOp();
    st().newTab();
    expect(st().docNonce).not.toBe(before.docNonce);
    st().hydrateSession(
      [
        { id: "t1", doc: doc([chunk("a", "text", "A")]), filePath: null, dirty: false },
        { id: "t2", doc: doc([chunk("b", "text", "B")]), filePath: null, dirty: false },
      ],
      "t2"
    );
    const n1 = st().inactiveTabs["t1"].docNonce;
    expect(n1).not.toBe(st().docNonce);
    expect(st().ownsOp(before)).toBe(false);
  });

  it("module-level captureOp/ownsOp mirror the store actions, with increasing op ids", () => {
    reset([chunk("a", "text", "x")]);
    const op1 = captureOp();
    const op2 = captureOp();
    expect(op2.opId).toBeGreaterThan(op1.opId);
    expect(op1.tabId).toBe(st().activeTabId);
    expect(op1.docNonce).toBe(st().docNonce);
    expect(ownsOp(op1)).toBe(true);
    st().loadDocument(doc([chunk("a", "text", "x")]));
    expect(ownsOp(op1)).toBe(false);
  });
});

describe("BUG-001d — ghost requests are invalidated on every document transition", () => {
  beforeEach(() => reset([chunk("a", "text", "The quick brown fox")]));

  it("a ghost delta arriving after loadDocument does not resurrect a suggestion", () => {
    const id = st().startGhostRequest();
    st().loadDocument(doc([chunk("a", "text", "The quick brown fox")]));
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
  });

  it("…nor after newTab + switchTab back", () => {
    const tabA = st().activeTabId;
    const id = st().startGhostRequest();
    st().newTab();
    st().switchTab(tabA);
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
  });

  it("…nor after closing the active tab (multi-tab)", () => {
    const tabA = st().activeTabId;
    st().newTab();
    st().switchTab(tabA);
    const id = st().startGhostRequest();
    st().closeTab(tabA);
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
  });

  it("…nor after hydrateSession", () => {
    const id = st().startGhostRequest();
    st().hydrateSession(
      [{ id: "t1", doc: doc([chunk("a", "text", "The quick brown fox")]), filePath: null, dirty: false }],
      "t1"
    );
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
  });

  it("setGhostSuggestion rejects a context from another tab, another load, or stale text", () => {
    const id = st().startGhostRequest();
    const ctx = { chunkId: "a", prefix: "The quick brown fox", tabId: "tab-1", docNonce: st().docNonce };
    st().setGhostSuggestion({ ...ctx, tabId: "tab-other" }, " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
    st().setGhostSuggestion({ ...ctx, docNonce: ctx.docNonce + 1000 }, " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
    st().setGhostSuggestion({ ...ctx, prefix: "The quick" }, " jumps", id);
    expect(st().ghostSuggestion).toBeNull();
    // The matching context is accepted, verbatim.
    st().setGhostSuggestion(ctx, " jumps", id);
    expect(st().ghostSuggestion).toEqual({ ...ctx, text: " jumps" });
  });
});

describe("BUG-001a — acceptGhostSuggestion validates and is its own undo step", () => {
  beforeEach(() => reset([chunk("a", "text", "The quick brown fox")]));

  it("refuses when the chunk text no longer equals the prefix the suggestion was generated for", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion(
      { chunkId: "a", prefix: "The quick brown fox", tabId: st().activeTabId, docNonce: st().docNonce },
      " jumps",
      id
    );
    // Bypass ChunkView's clear-on-edit: the store itself must refuse.
    useStore.setState((s) => ({
      doc: { ...s.doc, chunks: s.doc.chunks.map((c) => ({ ...c, content: "Different" })) },
    }));
    expect(st().acceptGhostSuggestion("a")).toBe(false);
    expect(st().doc.chunks[0].content).toBe("Different");
    expect(st().ghostSuggestion).toBeNull();
  });

  it("refuses for another chunk id, and with no suggestion at all", () => {
    reset([chunk("a", "text", "one"), chunk("b", "text", "two")]);
    expect(st().acceptGhostSuggestion("a")).toBe(false);
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " more", id);
    expect(st().acceptGhostSuggestion("b")).toBe(false);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["one", "two"]);
    expect(st().dirty).toBe(false);
  });

  it("refuses an empty or whitespace-only suggestion (Tab must fall through, no spurious edit)", () => {
    for (const text of ["", "  ", "　"]) {
      const id = st().startGhostRequest();
      st().setGhostSuggestion("a", text, id);
      expect(st().acceptGhostSuggestion("a")).toBe(false);
      expect(st().ghostSuggestion).toBeNull();
    }
    expect(st().doc.chunks[0].content).toBe("The quick brown fox");
    expect(st().dirty).toBe(false);
    expect(st().past).toHaveLength(0);
  });

  it("refuses a suggestion recorded for another tab or document load", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);
    const good = st().ghostSuggestion!;
    useStore.setState({ ghostSuggestion: { ...good, tabId: "tab-other" } });
    expect(st().acceptGhostSuggestion("a")).toBe(false);
    useStore.setState({ ghostSuggestion: { ...good, docNonce: good.docNonce + 1000 } });
    expect(st().acceptGhostSuggestion("a")).toBe(false);
    expect(st().doc.chunks[0].content).toBe("The quick brown fox");
    expect(st().dirty).toBe(false);
  });

  it("accepting a ghost suggestion is its own undo step (typing is not coalesced with it)", () => {
    st().updateChunkContent("a", "The quick brown fox!"); // typing
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().acceptGhostSuggestion("a")).toBe(true);
    expect(st().doc.chunks[0].content).toBe("The quick brown fox! jumps");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("The quick brown fox!");
    // …and typing after the accept starts yet another step.
    st().redo();
    st().updateChunkContent("a", "The quick brown fox! jumps.");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("The quick brown fox! jumps");
  });

  it("logs accept as commit, and a refused accept as discard with a reason code (ids only)", () => {
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);
    st().acceptGhostSuggestion("a");
    expect(st().aiOpLog[st().aiOpLog.length - 1]).toMatchObject({
      phase: "commit",
      action: "ghost",
      opId: id,
      tabId: st().activeTabId,
      chunkId: "a",
    });
    const id2 = st().startGhostRequest();
    st().setGhostSuggestion("a", " over", id2);
    useStore.setState((s) => ({
      doc: { ...s.doc, chunks: s.doc.chunks.map((c) => ({ ...c, content: "edited" })) },
    }));
    st().acceptGhostSuggestion("a");
    const last = st().aiOpLog[st().aiOpLog.length - 1];
    expect(last).toMatchObject({ phase: "discard", reason: "text-changed", chunkId: "a" });
    expect(JSON.stringify(last)).not.toMatch(/over|edited|jumps/);
  });
});

describe("BUG-002 — paragraph undo boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it("a replacement edit (newUndoStep) is its own undo step", () => {
    reset([chunk("a", "text", "")]);
    st().updateChunkContent("a", "STATE_A");
    st().updateChunkContent("a", "S", { newUndoStep: true });
    st().updateChunkContent("a", "STATE_B");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("STATE_A");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("");
    st().redo();
    st().redo();
    expect(st().doc.chunks[0].content).toBe("STATE_B");
  });

  it("an idle gap longer than UNDO_IDLE_MS starts a new undo step (backspace-retype path)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    reset([chunk("a", "text", "")]);
    st().updateChunkContent("a", "STATE_A");
    vi.setSystemTime(UNDO_IDLE_MS + 3500);
    st().updateChunkContent("a", "STATE_");
    st().updateChunkContent("a", "STATE_B");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("STATE_A");
  });

  it("continuous typing within the idle window still coalesces — the window slides", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    reset([chunk("a", "text", "")]);
    st().updateChunkContent("a", "x");
    const depth = st().past.length;
    // Each keystroke is < UNDO_IDLE_MS after the previous one, but the whole
    // burst spans far more than UNDO_IDLE_MS.
    let text = "x";
    for (let t = 1; t <= 6; t++) {
      vi.setSystemTime(t * (UNDO_IDLE_MS - 500));
      text += "y";
      st().updateChunkContent("a", text);
    }
    expect(st().past.length).toBe(depth);
  });

  it("an IME composition update after a long pause still coalesces (no idle split mid-composition)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    reset([chunk("a", "text", "AB")]);
    // Composition starts right away (first marked text: not a continuation).
    st().updateChunkContent("a", "ABに");
    vi.setSystemTime(300);
    st().updateChunkContent("a", "ABにほん", { composing: true });
    // The user pauses to choose a candidate, then converts and commits.
    vi.setSystemTime(300 + UNDO_IDLE_MS + 2000);
    st().updateChunkContent("a", "AB日本", { composing: true });
    st().updateChunkContent("a", "AB日本", { composing: true });
    st().undo();
    expect(st().doc.chunks[0].content).toBe("AB");
  });

  it("a non-composition edit after the same gap still splits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    reset([chunk("a", "text", "AB")]);
    st().updateChunkContent("a", "ABC");
    vi.setSystemTime(UNDO_IDLE_MS + 2000);
    st().updateChunkContent("a", "ABCD", { composing: false });
    st().undo();
    expect(st().doc.chunks[0].content).toBe("ABC");
  });

  it("composing never hides an explicit boundary or a chunk change", () => {
    reset([chunk("a", "text", ""), chunk("b", "text", "")]);
    st().updateChunkContent("a", "x");
    st().updateChunkContent("b", "y", { composing: true });
    st().undo();
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["x", ""]);
  });

  it("a ghost/citation insert is its own undo step (CJK)", () => {
    reset([chunk("a", "text", "")]);
    st().updateChunkContent("a", "本文");
    st().updateChunkContent("a", "本文[1]", { newUndoStep: true });
    st().undo();
    expect(st().doc.chunks[0].content).toBe("本文");
  });
});

describe("BUG-018 — closing the last tab replaces it", () => {
  it("closing the last tab replaces it with a fresh untitled tab under a NEW id", () => {
    reset([chunk("a", "text", "内容")]);
    st().updateChunkContent("a", "内容2");
    const old = st().activeTabId;
    const oldNonce = st().docNonce;
    st().closeTab(old);
    expect(st().tabOrder).toHaveLength(1);
    expect(st().activeTabId).not.toBe(old);
    expect(st().tabOrder).toEqual([st().activeTabId]);
    expect(st().doc.chunks.map((c) => c.content).join("")).toBe("");
    expect(st().doc.title).toBe("");
    expect(st().filePath).toBeNull();
    expect(st().dirty).toBe(false);
    expect(st().past).toEqual([]);
    expect(st().future).toEqual([]);
    expect(st().docNonce).not.toBe(oldNonce);
  });

  it("a late op for the closed last tab does not land on its replacement", () => {
    reset([chunk("a", "text", "x")]);
    const old = st().activeTabId;
    const op = st().captureOp();
    st().closeTab(old);
    st().setGlobalBusy("Working…", old);
    expect(st().globalBusy).toBeNull();
    expect(st().ownsOp(op)).toBe(false);
  });

  it("resets transient per-view state (speech queue, ghost, AI-edit highlight, busy)", () => {
    reset([chunk("a", "text", "x")]);
    st().setSpeechQueue(["a"]);
    st().setGlobalBusy("Working…");
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " more", id);
    st().replaceChunkContent("a", "AI text");
    expect(st().lastAiEditChunkId).toBe("a");
    st().closeTab(st().activeTabId);
    expect(st().speechQueue).toEqual([]);
    expect(st().ghostSuggestion).toBeNull();
    expect(st().lastAiEditChunkId).toBeNull();
    expect(st().globalBusy).toBeNull();
    st().setGhostSuggestion("a", " more", id); // late delta from the closed tab
    expect(st().ghostSuggestion).toBeNull();
  });

  it("an unknown id with a single tab is still a no-op", () => {
    reset([chunk("a", "text", "keep")]);
    const before = st().activeTabId;
    st().closeTab("no-such-tab");
    expect(st().activeTabId).toBe(before);
    expect(st().doc.chunks[0].content).toBe("keep");
  });

  it("closing the active tab of several still resets ghost/speech/highlight state", () => {
    reset([chunk("a", "text", "x")]);
    const tabA = st().activeTabId;
    st().newTab();
    st().switchTab(tabA);
    st().setSpeechQueue(["a"]);
    st().replaceChunkContent("a", "AI text");
    st().closeTab(tabA);
    expect(st().tabOrder).toHaveLength(1);
    expect(st().speechQueue).toEqual([]);
    expect(st().lastAiEditChunkId).toBeNull();
  });
});

describe("MISS-12 — undo/redo recompute dirty against the saved baseline", () => {
  it("type → save → type → undo is clean again; redo is dirty", () => {
    reset([chunk("a", "text", "hello")]);
    st().updateChunkContent("a", "hello, one");
    st().markClean("/f.aix");
    st().updateChunkContent("a", "hello, one two");
    expect(st().dirty).toBe(true);
    st().undo();
    expect(st().doc.chunks[0].content).toBe("hello, one");
    expect(st().dirty).toBe(false);
    st().redo();
    expect(st().dirty).toBe(true);
  });

  it("undo back to the just-opened document is clean", () => {
    reset([chunk("a", "text", "hello")]);
    st().updateChunkContent("a", "hello!");
    st().undo();
    expect(st().dirty).toBe(false);
  });

  it("a structurally identical (but not identical-object) restored doc is clean", () => {
    reset([chunk("a", "text", "hello")]);
    st().updateChunkContent("a", "hello!");
    st().updateChunkContent("a", "hello", { newUndoStep: true }); // retyped back
    st().updateChunkContent("a", "hello?", { newUndoStep: true });
    st().undo(); // restores the "hello" snapshot — a different object than savedDoc
    expect(st().doc).not.toBe(st().savedDoc);
    expect(st().doc.chunks[0].content).toBe("hello");
    expect(st().dirty).toBe(false);
  });

  it("undo to a restored doc that differs only in metadata stays dirty", () => {
    reset([chunk("a", "text", "hello")]);
    st().setChunkSummary("a", "s1");
    st().setChunkSummary("a", "s2");
    st().undo();
    expect(st().doc.chunks[0].metadata.summary).toBe("s1");
    expect(st().dirty).toBe(true);
  });

  it("an unsaved baseline (AI draft / repaired file) stays dirty after undo — no silent discard", () => {
    reset([chunk("a", "text", "x")]);
    st().loadDocument(doc([chunk("d", "text", "drafted")]), null, { dirty: true });
    st().updateChunkContent("d", "drafted!");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("drafted");
    expect(st().dirty).toBe(true);
  });

  it("…including a dirty tab restored from a crash-recovery session", () => {
    reset([chunk("a", "text", "x")]);
    st().hydrateSession(
      [{ id: "t1", doc: doc([chunk("b", "text", "B")]), filePath: null, dirty: true }],
      "t1"
    );
    st().updateChunkContent("b", "B!");
    st().undo();
    expect(st().dirty).toBe(true);
  });

  it("the baseline flag travels with its tab across a switch", () => {
    reset([chunk("a", "text", "x")]);
    st().loadDocument(doc([chunk("d", "text", "drafted")]), null, { dirty: true });
    const draftTab = st().activeTabId;
    st().newTab();
    st().switchTab(draftTab);
    st().updateChunkContent("d", "drafted!");
    st().undo();
    expect(st().dirty).toBe(true);
  });
});

describe("BUG-005b — commitDraftToTab routes a finished draft to its owning tab", () => {
  const finalDoc = () => doc([chunk("u1", "text", "partial"), chunk("u2", "text", "full rest")]);

  it("lands in a BACKGROUND draft tab, dirty, with fresh history", () => {
    reset([chunk("a", "text", "")]);
    const draftTab = st().activeTabId;
    const nonce = st().docNonce;
    st().setStreamingDocument(doc([chunk("draft-0", "text", "partial")]));
    st().newTab();
    const fg = st().doc;
    expect(st().commitDraftToTab(draftTab, nonce, finalDoc())).toBe(true);
    expect(st().doc).toBe(fg); // foreground untouched
    const snap = st().inactiveTabs[draftTab];
    expect(snap.doc.chunks.map((c) => c.content)).toEqual(["partial", "full rest"]);
    expect(snap.dirty).toBe(true);
    expect(snap.past).toEqual([]);
    expect(snap.future).toEqual([]);
    st().switchTab(draftTab);
    expect(st().doc.chunks.map((c) => c.id)).toEqual(["u1", "u2"]);
    expect(st().dirty).toBe(true);
  });

  it("lands in the ACTIVE draft tab too", () => {
    reset([chunk("a", "text", "")]);
    st().updateChunkContent("a", "typed");
    const ok = st().commitDraftToTab(st().activeTabId, st().docNonce, finalDoc());
    expect(ok).toBe(true);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["partial", "full rest"]);
    expect(st().dirty).toBe(true);
    expect(st().past).toEqual([]);
    // Undo cannot fall back into the pre-draft blank doc; and it stays dirty.
    st().undo();
    expect(st().dirty).toBe(true);
  });

  it("is a no-op when the tab was closed", () => {
    reset([chunk("a", "text", "")]);
    const draftTab = st().activeTabId;
    const nonce = st().docNonce;
    st().newTab();
    st().closeTab(draftTab);
    expect(st().commitDraftToTab(draftTab, nonce, finalDoc())).toBe(false);
    expect(st().inactiveTabs[draftTab]).toBeUndefined();
    expect(st().doc.chunks.map((c) => c.content)).toEqual([""]);
  });

  it("is a no-op when another document was loaded into that tab meanwhile", () => {
    reset([chunk("a", "text", "")]);
    const draftTab = st().activeTabId;
    const nonce = st().docNonce;
    st().loadDocument(doc([chunk("o", "text", "opened file")]), "/o.aix");
    expect(st().commitDraftToTab(draftTab, nonce, finalDoc())).toBe(false);
    expect(st().doc.chunks[0].content).toBe("opened file");
    expect(st().dirty).toBe(false);
  });

  it("a streamed partial draft marks the tab dirty", () => {
    reset([chunk("a", "text", "")]);
    st().setStreamingDocument(doc([chunk("draft-0", "text", "partial")]));
    expect(st().dirty).toBe(true);
  });
});

describe("BUG-015a — applyAnalysis with nothing to record is not an edit", () => {
  it("an empty result on a never-analyzed doc does not dirty it or add an undo step", () => {
    reset([chunk("a", "text", "text")]);
    st().applyAnalysis({ nodes: [], edges: [] });
    expect(st().dirty).toBe(false);
    expect(st().past).toHaveLength(0);
    expect(st().doc.analysis).toBeUndefined();
    // The in-memory result is kept so the panel can say "no relations".
    expect(st().analysis?.nodes).toEqual([]);
    expect(st().analysis?.edges).toEqual([]);
  });

  it("pressing Analyze twice on such a doc is still a no-op (an empty graph is not a previous analysis)", () => {
    reset([chunk("a", "text", "text")]);
    st().applyAnalysis({ nodes: [], edges: [] });
    st().applyAnalysis({ nodes: [], edges: [] });
    expect(st().dirty).toBe(false);
    expect(st().past).toHaveLength(0);
  });

  it("an empty result that CLEARS a previous analysis is still a real, undoable change", () => {
    reset([chunk("a", "text", "A"), chunk("b", "text", "B")]);
    st().applyAnalysis({
      nodes: [node("a"), node("b")],
      edges: [{ source: "a", target: "b", relation: "evidence" }],
    });
    st().markClean("/f.aix");
    st().applyAnalysis({ nodes: [], edges: [] });
    expect(st().dirty).toBe(true);
    expect(st().past.length).toBeGreaterThan(0);
  });

  it("a doc whose graph was rebuilt from persisted links counts as previously analyzed", () => {
    const linked: Chunk = {
      ...chunk("a", "text", "A"),
      metadata: { chunkType: "text", linkedChunks: ["b"] },
    };
    reset([linked, chunk("b", "text", "B")]);
    expect(st().analysis).not.toBeNull(); // rebuilt on load
    st().applyAnalysis({ nodes: [], edges: [] });
    expect(st().dirty).toBe(true);
  });
});

describe("BUG-013c — aiModelIssue", () => {
  it("is set explicitly and clears when the active model changes", () => {
    reset([chunk("a", "text", "x")]);
    st().setSettings(settings({ model: "a" }));
    st().setAiModelIssue({ model: "a" });
    expect(st().aiModelIssue).toEqual({ model: "a" });
    st().setSettings(settings({ model: "a", temperature: 0.9 })); // same model
    expect(st().aiModelIssue).toEqual({ model: "a" });
    st().setSettings(settings({ model: "b" }));
    expect(st().aiModelIssue).toBeNull();
  });
});

describe("MISS-01 — AI operation log (ids only, bounded)", () => {
  it("records whitelisted fields with a timestamp — never content", () => {
    reset([chunk("a", "text", "secret paragraph")]);
    const op = st().captureOp();
    st().logAiOp({
      opId: op.opId,
      phase: "discard",
      action: "proofread",
      tabId: op.tabId,
      docNonce: op.docNonce,
      chunkId: "a",
      reason: "doc-changed",
      // A careless caller passing extra data must not get it stored.
      ...({ content: "secret paragraph", apiKey: "sk-xxx" } as object),
    });
    const entry = st().aiOpLog[st().aiOpLog.length - 1];
    expect(Object.keys(entry).sort()).toEqual(
      ["action", "chunkId", "docNonce", "opId", "phase", "reason", "tabId", "ts"].sort()
    );
    expect(entry).toMatchObject({ phase: "discard", reason: "doc-changed", chunkId: "a" });
    expect(typeof entry.ts).toBe("number");
  });

  it("keeps at most AI_OP_LOG_MAX entries, evicting the oldest", () => {
    reset([chunk("a", "text", "x")]);
    for (let i = 1; i <= AI_OP_LOG_MAX + 1; i++) {
      st().logAiOp({ opId: i, phase: "start", action: "ghost", tabId: "tab-1", docNonce: 1 });
    }
    expect(AI_OP_LOG_MAX).toBe(200);
    expect(st().aiOpLog).toHaveLength(AI_OP_LOG_MAX);
    expect(st().aiOpLog[0].opId).toBe(2);
    expect(st().aiOpLog[AI_OP_LOG_MAX - 1].opId).toBe(AI_OP_LOG_MAX + 1);
  });
});

describe("BUG-007 — speaker notes on a heading-less leading slide", () => {
  // Fails if setChunkNotes starts refusing non-heading chunks, or if
  // slideLead (the SpeakerNotes host) and slideNotes (the reader) disagree.
  it("notes on the leading slide go to the lead chunk and read back as the slide's notes", () => {
    reset([chunk("a", "text", "lonely"), chunk("b", "text", "more")]);
    const lead = slideLead(groupSlides(st().doc.chunks)[0])!;
    expect(lead.id).toBe("a");
    st().setChunkNotes(lead.id, "N");
    expect(st().doc.chunks[0].metadata.notes).toBe("N");
    expect(st().doc.chunks[1].metadata.notes).toBeUndefined();
    expect(slideNotes(groupSlides(st().doc.chunks)[0])).toBe("N");
  });
});

describe("BUG-010 — find & replace", () => {
  const opts = { caseSensitive: false, wholeWord: false };

  it("replace-all across chunks is exactly one undo step", () => {
    reset([chunk("A", "text", "猫"), chunk("B", "text", "猫")]);
    st().updateChunkContent("A", "猫と");
    st().updateChunkContent("A", "猫と猫");
    const n = st().past.length;
    expect(st().replaceAllInChunks("猫", "犬", opts)).toBe(3);
    expect(st().past.length).toBe(n + 1);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["犬と犬", "犬"]);
    expect(st().dirty).toBe(true);
    expect(st().analysisStale).toBe(true);
    st().undo();
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["猫と猫", "猫"]);
  });

  it("replace-all leaves image and diagram chunks alone and inserts the replacement literally", () => {
    reset([chunk("i", "image", "cat.png"), chunk("d", "diagram", "cat-->dog"), chunk("t", "heading", "cat")]);
    expect(st().replaceAllInChunks("cat", "$&!", opts)).toBe(1);
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["cat.png", "cat-->dog", "$&!"]);
  });

  it("replace-all with no match records no undo step and does not dirty the document", () => {
    reset([chunk("A", "text", "abc")]);
    const n = st().past.length;
    expect(st().replaceAllInChunks("zzz", "y", opts)).toBe(0);
    expect(st().replaceAllInChunks("", "y", opts)).toBe(0);
    expect(st().past.length).toBe(n);
    expect(st().dirty).toBe(false);
  });

  it("replaceMatchInChunk replaces one range as its own undo step", () => {
    reset([chunk("A", "text", "猫と猫")]);
    st().updateChunkContent("A", "猫と猫!");
    const n = st().past.length;
    expect(st().replaceMatchInChunk("A", 2, 3, "犬")).toBe(true);
    expect(st().doc.chunks[0].content).toBe("猫と犬!");
    expect(st().past.length).toBe(n + 1);
    st().undo();
    expect(st().doc.chunks[0].content).toBe("猫と猫!");
  });

  it("replaceMatchInChunk refuses a stale or invalid range", () => {
    reset([chunk("A", "text", "abc"), chunk("I", "image", "x.png")]);
    const n = st().past.length;
    expect(st().replaceMatchInChunk("A", 2, 9, "z")).toBe(false);
    expect(st().replaceMatchInChunk("A", 2, 1, "z")).toBe(false);
    expect(st().replaceMatchInChunk("missing", 0, 1, "z")).toBe(false);
    expect(st().replaceMatchInChunk("I", 0, 1, "z")).toBe(false);
    expect(st().past.length).toBe(n);
    expect(st().doc.chunks[0].content).toBe("abc");
  });

  it("markdown replace-all after typing is its own undo step", () => {
    reset([chunk("a", "text", "x")]);
    st().setMode("markdown");
    st().setMarkdownSource("# a\nfoo");
    st().setMarkdownSource("# a\nfoo foo");
    const n = st().past.length;
    expect(st().replaceAllInMarkdown("foo", "bar", opts)).toBe(2);
    expect(st().past.length).toBe(n + 1);
    expect(documentToMarkdown(st().doc)).toBe("# a\nbar bar");
    st().undo();
    expect(documentToMarkdown(st().doc)).toBe("# a\nfoo foo");
    // Typing after the replace starts a new step again.
    st().setMarkdownSource("# a\nbar bar!");
    expect(st().past.length).toBe(n + 1);
  });

  it("markdown replace-all with no match changes nothing", () => {
    reset([chunk("a", "text", "x")]);
    st().setMode("markdown");
    st().setMarkdownSource("# a\nfoo");
    const n = st().past.length;
    expect(st().replaceAllInMarkdown("zzz", "bar", opts)).toBe(0);
    expect(st().past.length).toBe(n);
  });

  it("find bar state is ephemeral UI state with open / mode / seed", () => {
    reset([chunk("a", "text", "x")]);
    expect(st().find.open).toBe(false);
    const nonce = st().find.focusNonce;
    st().openFind("replace", "日本");
    expect(st().find).toMatchObject({ open: true, mode: "replace", query: "日本", current: -1 });
    expect(st().find.focusNonce).toBe(nonce + 1);
    st().setFind({ replacement: "にほん", caseSensitive: true, current: 2, hit: { chunkId: "a", from: 0, to: 1 } });
    // No seed keeps the previous query; reopening forgets the old match.
    st().openFind("find", null);
    expect(st().find).toMatchObject({ open: true, mode: "find", query: "日本", replacement: "にほん", caseSensitive: true, current: -1, hit: null });
    st().closeFind();
    expect(st().find.open).toBe(false);
    expect(st().find.query).toBe("日本");
    // Not document state: a find never dirties or adds history.
    expect(st().dirty).toBe(false);
    expect("find" in st().doc).toBe(false);
  });
});

describe("md-slides-export-3 — opening the source editor on a CRLF file is not an edit", () => {
  it("the editor's first sync (normalize → restore) leaves dirty false and no undo step", () => {
    const src = "# T\r\n\r\npara\r\nline two\r\n";
    reset([chunk("a", "text", "")]);
    st().loadDocument(markdownToDocument({ ...st().doc, mode: "markdown" }, src), "/x.md");
    expect(st().dirty).toBe(false);
    st().setMarkdownSource(restoreEol(normalizeEol(src), eolOf(src)));
    expect(st().dirty).toBe(false);
    expect(st().past).toEqual([]);
    expect(documentToMarkdown(st().doc)).toBe(src);
  });

  it("a real edit keeps CRLF, and undo returns to the CRLF bytes", () => {
    const src = "# T\r\n\r\npara\r\n";
    reset([chunk("a", "text", "")]);
    st().loadDocument(markdownToDocument({ ...st().doc, mode: "markdown" }, src), "/x.md");
    st().setMarkdownSource(restoreEol("# T\n\npara!\n", eolOf(src)));
    expect(documentToMarkdown(st().doc)).toBe("# T\r\n\r\npara!\r\n");
    st().undo();
    expect(documentToMarkdown(st().doc)).toBe(src);
    expect(st().dirty).toBe(false);
  });
});

describe("ux-a11y-i18n-1 — find.replacePending (⌘Z in the bar after a replace)", () => {
  it("is set by the bar after a replace and cleared by editing a find field, opening or closing", () => {
    reset([chunk("a", "text", "foo foo")]);
    expect(st().find.replacePending).toBe(false);
    st().setFind({ replacePending: true });
    st().setFind({ current: 0, hit: null }); // stepping keeps it
    expect(st().find.replacePending).toBe(true);
    st().setFind({ replacement: "baz" });
    expect(st().find.replacePending).toBe(false);
    st().setFind({ replacePending: true });
    st().setFind({ query: "fo" });
    expect(st().find.replacePending).toBe(false);
    st().setFind({ replacePending: true });
    st().closeFind();
    expect(st().find.replacePending).toBe(false);
    st().setFind({ replacePending: true });
    st().openFind("replace");
    expect(st().find.replacePending).toBe(false);
  });
});

describe("revert-check gaps (BUG-001 ghostReset, MISS-12 redo, C3d draft baseline)", () => {
  const draft = () => doc([chunk("u1", "text", "draft one"), chunk("u2", "text", "draft two")]);

  it("commitDraftToTab on the active tab clears a pending ghost suggestion and invalidates its request", () => {
    reset([chunk("a", "text", "The quick brown fox")]);
    const id = st().startGhostRequest();
    st().setGhostSuggestion("a", " jumps", id);
    expect(st().ghostSuggestion).not.toBeNull();
    const pending = st().startGhostRequest(); // an in-flight request
    expect(st().commitDraftToTab(st().activeTabId, st().docNonce, draft())).toBe(true);
    expect(st().ghostSuggestion).toBeNull();
    expect(st().ghostRequestId).toBeGreaterThan(pending);
  });

  it("redo back ONTO the saved document is clean (MISS-12 redo half)", () => {
    reset([chunk("a", "text", "S0")]);
    st().updateChunkContent("a", "S1");
    st().markClean("/f.aix");
    st().undo();
    expect(st().dirty).toBe(true);
    st().redo();
    expect(st().doc.chunks[0].content).toBe("S1");
    expect(st().dirty).toBe(false);
  });

  it("a committed AI draft is never a clean baseline: type then undo stays dirty (active tab)", () => {
    reset([chunk("a", "text", "")]);
    expect(st().commitDraftToTab(st().activeTabId, st().docNonce, draft())).toBe(true);
    st().updateChunkContent("u1", "draft one, edited");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("draft one");
    expect(st().dirty).toBe(true);
  });

  it("…and the same after a background commit, once the user switches to it", () => {
    reset([chunk("a", "text", "")]);
    const draftTab = st().activeTabId;
    const nonce = st().docNonce;
    st().newTab();
    expect(st().commitDraftToTab(draftTab, nonce, draft())).toBe(true);
    st().switchTab(draftTab);
    st().updateChunkContent("u1", "draft one, edited");
    st().undo();
    expect(st().doc.chunks[0].content).toBe("draft one");
    expect(st().dirty).toBe(true);
  });
});

describe("ux-a11y-i18n-4 — store-raised copy follows the UI language", () => {
  afterEach(() => useStore.setState({ settings: null }));

  it("the stale-graph toasts are Japanese in the Japanese UI", () => {
    reset([chunk("a", "text", "x")]);
    useStore.setState({ settings: settings({ defaultTargetLanguage: "日本語" }), toasts: [] });
    st().flashChunk("gone");
    st().flashChunks(["gone", "also-gone"]);
    const msgs = st().toasts.map((t) => t.message);
    expect(msgs).toEqual([
      "その段落はもう存在しません — グラフを更新するには再分析してください。",
      "それらの段落はもう存在しません — グラフを更新するには再分析してください。",
    ]);
  });

  it("Split slide here titles the new slide in the UI language (it becomes document content)", () => {
    reset([chunk("h", "heading", "H"), chunk("a", "text", "a")]);
    useStore.setState({ settings: settings({ defaultTargetLanguage: "日本語" }) });
    const id = st().splitSlideBefore("a");
    expect(st().doc.chunks.find((c) => c.id === id)?.content).toBe("新しいスライド");
  });
});

describe("ux-a11y-i18n-5 — settingsFocus", () => {
  it("openSettings('model-catalog') records the focus; a plain open (or an event arg) does not; close clears it", () => {
    st().openSettings("model-catalog");
    expect(st().settingsOpen).toBe(true);
    expect(st().settingsFocus).toBe("model-catalog");
    st().closeSettings();
    expect(st().settingsFocus).toBeNull();
    st().openSettings();
    expect(st().settingsFocus).toBeNull();
    (st().openSettings as (x: unknown) => void)({ type: "click" }); // onClick={openSettings}
    expect(st().settingsFocus).toBeNull();
    st().closeSettings();
  });
});
