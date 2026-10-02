import { beforeEach, describe, expect, it, vi } from "vitest";

// `gatherRagSnippets` calls `api.ragListSources`/`api.ragSearch`, which invoke
// Tauri IPC — mocked here so this stays a hermetic, fast unit test (no real
// Tauri runtime exists under vitest's plain Node environment) and so the
// "zero query attempts when disabled/empty" assertions below can inspect
// exactly how many times each was called. `aiProcess` is mocked too, for the
// Bulletize-vs-runChunkAction "reviewable diff" contract test below.
const ragListSources = vi.fn();
const ragSearch = vi.fn();
const aiProcess = vi.fn();
const aiProcessStream = vi.fn();
const aiAnalyzeDocument = vi.fn();
const aiGenerateImage = vi.fn();
const aiGenerateDiagram = vi.fn();
vi.mock("./api", () => ({
  api: {
    aiGenerateImage: (...args: unknown[]) => aiGenerateImage(...args),
    aiGenerateDiagram: (...args: unknown[]) => aiGenerateDiagram(...args),
    ragListSources: (...args: unknown[]) => ragListSources(...args),
    ragSearch: (...args: unknown[]) => ragSearch(...args),
    aiProcess: (...args: unknown[]) => aiProcess(...args),
    aiProcessStream: (...args: unknown[]) => aiProcessStream(...args),
    aiAnalyzeDocument: (...args: unknown[]) => aiAnalyzeDocument(...args),
  },
}));
// Mermaid does not load under Node; the diagram action only needs "valid".
vi.mock("./mermaidRender", () => ({ validateMermaid: async () => null }));

import {
  aiOpLogToJsonLines,
  analyzeDocument,
  cancelChunkAction,
  checkAgainstCriteria,
  checkIntegrity,
  generateDiagramFromChunk,
  generateImageFromChunk,
  generateImageFromSelection,
  generatePresentationFromChunk,
  regenerateImageChunk,
  reviewDocument,
  suggestSlideLayout,
  summarizeSlide,
  bulletizeChunks,
  editSelection,
  extractJsonObject,
  gatherRagSnippets,
  notifyRagSources,
  parseBulletLines,
  parseCriteriaResults,
  runChunkAction,
} from "./aiActions";
import { staleSummaryChunkIds, useStore } from "./store";
import type { Chunk, Document, RagSearchHit } from "./types";

function chunk(id: string, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: "text", linkedChunks: [] } };
}
function doc(chunks: Chunk[]): Document {
  return { id: "d", title: "T", chunks, mode: "editor" };
}

describe("parseBulletLines — tolerant LLM bullet parsing", () => {
  it("parses '-', '•' and '*' markers", () => {
    expect(parseBulletLines("- one\n• two\n* three")).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("parses en-dash and numbered '1.' / '1)' markers", () => {
    expect(parseBulletLines("– first\n1. second\n2) third")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("drops preamble/postamble lines (ending with ':' or blank) around bullets", () => {
    const raw = "Here are the bullets:\n\n- one\n- two\n\nLet me know if you need more:";
    expect(parseBulletLines(raw)).toEqual(["one", "two"]);
  });

  it("strips code fences around the bullet list", () => {
    expect(parseBulletLines("```markdown\n- one\n- two\n```")).toEqual([
      "one",
      "two",
    ]);
  });

  it("trims whitespace and skips empty bullet lines", () => {
    expect(parseBulletLines("  -   spaced out  \n- \n- kept")).toEqual([
      "spaced out",
      "kept",
    ]);
  });

  it("falls back to all non-empty lines when nothing is bullet-shaped", () => {
    const raw = "A summary line\n\nAnother line\nA lead-in dropped anyway:";
    expect(parseBulletLines(raw)).toEqual(["A summary line", "Another line"]);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(parseBulletLines("")).toEqual([]);
    expect(parseBulletLines("  \n\n  ")).toEqual([]);
  });
});

describe("extractJsonObject — tolerant JSON extraction from LLM replies", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"comments":[]}')).toEqual({ comments: [] });
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = '```json\n{"comments":[{"chunkId":"a","text":"t"}]}\n```';
    expect(extractJsonObject(raw)).toEqual({
      comments: [{ chunkId: "a", text: "t" }],
    });
  });

  it("parses prose-wrapped JSON whose strings contain braces and escaped quotes", () => {
    const raw =
      'Sure! Here is the review you asked for:\n{"comments":[{"chunkId":"c1",' +
      '"text":"Define \\"scope {x}\\" first — the closing } is ambiguous."}]}\nHope this helps.';
    expect(extractJsonObject(raw)).toEqual({
      comments: [
        { chunkId: "c1", text: 'Define "scope {x}" first — the closing } is ambiguous.' },
      ],
    });
  });

  it("parses nested objects to the OUTER balanced brace", () => {
    const raw = 'prefix {"a":{"b":{"c":1}},"d":2} suffix';
    expect(extractJsonObject(raw)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("returns null when no object or only invalid JSON is present", () => {
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("{unquoted: keys}")).toBeNull();
    expect(extractJsonObject('{"never":"closed"')).toBeNull();
  });
});

describe("parseCriteriaResults — review-criteria coverage parsing", () => {
  const validIds = new Set(["p1", "p2"]);
  const criteria = ["Explains significance", "States a clear methodology"];

  it("reports a criterion with a genuine supporting paragraph as covered", () => {
    const raw =
      '{"results":[' +
      '{"criterion":"Explains significance","covered":true,"supportingChunkIds":["p1"]},' +
      '{"criterion":"States a clear methodology","covered":true,"supportingChunkIds":["p2"]}' +
      "]}";
    expect(parseCriteriaResults(raw, criteria, validIds)).toEqual([
      { criterion: "Explains significance", covered: true, supportingChunkIds: ["p1"] },
      { criterion: "States a clear methodology", covered: true, supportingChunkIds: ["p2"] },
    ]);
  });

  it("THE FAILURE PATH: a criterion with zero supporting chunks is reported as not-covered", () => {
    const raw =
      '{"results":[' +
      '{"criterion":"Explains significance","covered":false,"supportingChunkIds":[]},' +
      '{"criterion":"States a clear methodology","covered":true,"supportingChunkIds":["p2"]}' +
      "]}";
    const results = parseCriteriaResults(raw, criteria, validIds);
    expect(results[0]).toEqual({
      criterion: "Explains significance",
      covered: false,
      supportingChunkIds: [],
    });
    expect(results[1].covered).toBe(true);
  });

  it("treats covered:true with only hallucinated (invalid) ids as NOT covered", () => {
    const raw =
      '{"results":[{"criterion":"Explains significance","covered":true,"supportingChunkIds":["ghost-id"]}]}';
    const results = parseCriteriaResults(raw, ["Explains significance"], validIds);
    expect(results).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
    ]);
  });

  it("drops hallucinated ids but keeps any genuinely valid ones alongside them", () => {
    const raw =
      '{"results":[{"criterion":"Explains significance","covered":true,"supportingChunkIds":["p1","ghost-id"]}]}';
    const results = parseCriteriaResults(raw, ["Explains significance"], validIds);
    expect(results).toEqual([
      { criterion: "Explains significance", covered: true, supportingChunkIds: ["p1"] },
    ]);
  });

  it("re-adds a criterion the model's reply omitted entirely, as not-covered", () => {
    const raw =
      '{"results":[{"criterion":"Explains significance","covered":true,"supportingChunkIds":["p1"]}]}';
    // "States a clear methodology" is missing from the reply altogether.
    const results = parseCriteriaResults(raw, criteria, validIds);
    expect(results).toEqual([
      { criterion: "Explains significance", covered: true, supportingChunkIds: ["p1"] },
      { criterion: "States a clear methodology", covered: false, supportingChunkIds: [] },
    ]);
  });

  it("handles a preamble + code-fenced reply (adversarial: wrapping)", () => {
    const raw =
      "Sure, here is the coverage analysis:\n```json\n" +
      '{"results":[{"criterion":"Explains significance","covered":true,"supportingChunkIds":["p1"]}]}' +
      "\n```\nLet me know if you need anything else.";
    const results = parseCriteriaResults(raw, ["Explains significance"], validIds);
    expect(results).toEqual([
      { criterion: "Explains significance", covered: true, supportingChunkIds: ["p1"] },
    ]);
  });

  it("handles the wrong-but-plausible shape (findings instead of results) as all not-covered", () => {
    const raw =
      '{"findings":[{"criterion":"Explains significance","covered":true,"supportingChunkIds":["p1"]}]}';
    expect(parseCriteriaResults(raw, ["Explains significance"], validIds)).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
    ]);
  });

  it("handles completely malformed/empty LLM output gracefully (every criterion not-covered)", () => {
    expect(parseCriteriaResults("", criteria, validIds)).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
      { criterion: "States a clear methodology", covered: false, supportingChunkIds: [] },
    ]);
    expect(parseCriteriaResults("not json at all", criteria, validIds)).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
      { criterion: "States a clear methodology", covered: false, supportingChunkIds: [] },
    ]);
    expect(parseCriteriaResults('{"results": "not an array"}', criteria, validIds)).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
      { criterion: "States a clear methodology", covered: false, supportingChunkIds: [] },
    ]);
  });

  it("ignores a result entry whose criterion doesn't match any requested criterion", () => {
    const raw =
      '{"results":[{"criterion":"An unrelated criterion the model invented","covered":true,"supportingChunkIds":["p1"]}]}';
    expect(parseCriteriaResults(raw, ["Explains significance"], validIds)).toEqual([
      { criterion: "Explains significance", covered: false, supportingChunkIds: [] },
    ]);
  });
});

describe("gatherRagSnippets — personal RAG (開発.txt Stage 3, item 3-1) grounding", () => {
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

  beforeEach(() => {
    ragListSources.mockReset();
    ragSearch.mockReset();
    useStore.setState({
      doc: doc([chunk("c1", "Some paragraph about photosynthesis.")]),
      settings: null,
    });
  });

  it("is a true no-op (zero query attempts) when the setting is off", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: false } });
    const hits = await gatherRagSnippets("c1");
    expect(hits).toEqual([]);
    expect(ragListSources).not.toHaveBeenCalled();
    expect(ragSearch).not.toHaveBeenCalled();
  });

  it("is a true no-op (zero query attempts) when settings haven't loaded yet", async () => {
    useStore.setState({ settings: null });
    const hits = await gatherRagSnippets("c1");
    expect(hits).toEqual([]);
    expect(ragListSources).not.toHaveBeenCalled();
    expect(ragSearch).not.toHaveBeenCalled();
  });

  it("checks the source list but skips search when nothing is indexed yet", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    ragListSources.mockResolvedValue([]);
    const hits = await gatherRagSnippets("c1");
    expect(hits).toEqual([]);
    expect(ragListSources).toHaveBeenCalledTimes(1);
    expect(ragSearch).not.toHaveBeenCalled();
  });

  it("searches using the chunk's own content as the query when enabled and indexed", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    ragListSources.mockResolvedValue([{ path: "/papers/a.md", passageCount: 3 }]);
    ragSearch.mockResolvedValue([
      { sourcePath: "/papers/a.md", snippet: "Photosynthesis...", distance: 0.1 },
    ]);
    const hits = await gatherRagSnippets("c1");
    expect(ragSearch).toHaveBeenCalledWith(
      "Some paragraph about photosynthesis.",
      expect.any(Number)
    );
    expect(hits).toEqual([
      { sourcePath: "/papers/a.md", snippet: "Photosynthesis...", distance: 0.1 },
    ]);
  });

  it("falls back to the section heading as the query when the chunk is empty", async () => {
    useStore.setState({
      doc: doc([chunk("c1", "   ")]),
      settings: { ...baseSettings, personalRagEnabled: true },
    });
    ragListSources.mockResolvedValue([{ path: "/papers/a.md", passageCount: 1 }]);
    ragSearch.mockResolvedValue([]);
    await gatherRagSnippets("c1", "Methods");
    expect(ragSearch).toHaveBeenCalledWith("Methods", expect.any(Number));
  });

  it("never throws — a search failure yields an empty result, not a rejected promise", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    ragListSources.mockResolvedValue([{ path: "/papers/a.md", passageCount: 1 }]);
    ragSearch.mockRejectedValue(new Error("index error"));
    const hits = await gatherRagSnippets("c1");
    expect(hits).toEqual([]);
  });

  // Part A regression guard: the whole point of gatherRagSnippets is that its
  // result is what `runChunkAction` sends as `AiRequest.ragSnippets` — this
  // asserts the shape returned here is EXACTLY the `RagSearchHit` shape the
  // Rust `AiRequest.ragSnippets` (ai.rs) / `context_block` expects (sourcePath
  // + snippet + distance), so a field rename on either side would fail this
  // test rather than silently drop the field again like the original bug.
  it("returns hits shaped exactly like RagSearchHit (sourcePath/snippet/distance) for the request payload", async () => {
    useStore.setState({ settings: { ...baseSettings, personalRagEnabled: true } });
    ragListSources.mockResolvedValue([{ path: "/papers/a.md", passageCount: 1 }]);
    const hit: RagSearchHit = { sourcePath: "/papers/a.md", snippet: "Photosynthesis...", distance: 0.1 };
    ragSearch.mockResolvedValue([hit]);
    const hits = await gatherRagSnippets("c1");
    expect(hits).toEqual([hit]);
    expect(Object.keys(hits[0]).sort()).toEqual(["distance", "snippet", "sourcePath"]);
  });
});

describe("notifyRagSources — Part B: surfacing which sources grounded a result", () => {
  beforeEach(() => {
    useStore.setState({ toasts: [] });
  });

  it("does nothing when no snippets were attached", () => {
    notifyRagSources([]);
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("names the source basename(s) an action was grounded from", () => {
    notifyRagSources([
      { sourcePath: "/Users/me/papers/photosynthesis.md", snippet: "x", distance: 0.1 },
    ]);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Grounded from: photosynthesis.md");
    expect(toasts[0].kind).toBe("info");
  });

  it("deduplicates multiple passages from the same source into one name", () => {
    notifyRagSources([
      { sourcePath: "/papers/a.md", snippet: "one", distance: 0.1 },
      { sourcePath: "/papers/a.md", snippet: "two", distance: 0.2 },
    ]);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Grounded from: a.md");
  });

  it("lists multiple distinct sources by basename, in first-seen order", () => {
    notifyRagSources([
      { sourcePath: "/papers/a.md", snippet: "one", distance: 0.1 },
      { sourcePath: "/notes/my-notes.aix", snippet: "two", distance: 0.2 },
    ]);
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Grounded from: a.md, my-notes.aix");
  });
});

// ---- Bulletize vs. runChunkAction: "reviewable diff" contract (project.md
// §5.5, item 1) --------------------------------------------------------------
//
// ChunkAiMenu.tsx now labels the Rewrite/Language/Translate/Proofread group as
// "safe to try — shows a reviewable diff (Revert) after" and Bulletize as
// "restructures immediately" with no such affordance. This test locks in the
// actual store-level behaviour that claim depends on, so the UI copy can never
// silently drift out of sync with what the code does:
//   - runChunkAction's content-replacing actions go through
//     `replaceChunkContent`, which stamps `contentHistory` (ChunkView's "What
//     changed" word-diff + Revert reads this) AND sets `lastAiEditChunkId`
//     (which is what makes ChunkView auto-show that diff).
//   - bulletizeChunks goes through `replaceChunksWithTexts`, a structural N→M
//     chunk replacement that does neither: the new chunks have no
//     `contentHistory` to diff against, and `lastAiEditChunkId` is left
//     unset — there is no reviewable-diff view for it, only the toast's
//     "⌘/Ctrl+Z to undo".
describe("Bulletize vs. runChunkAction — reviewable-diff contract", () => {
  const settings = {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "m",
    models: ["m"],
    imageModel: "im",
    imageModels: ["im"],
    defaultTargetLanguage: "English",
    writingTone: "",
    temperature: 0.3,
  };

  beforeEach(() => {
    aiProcess.mockReset();
    aiProcessStream.mockReset();
    useStore.setState({
      doc: doc([chunk("c1", "Some long paragraph about photosynthesis.")]),
      settings,
      hasApiKey: true,
      activeTabId: "tab1",
      past: [],
      future: [],
      lastAiEditChunkId: null,
    });
  });

  it("runChunkAction (e.g. expand) stamps contentHistory and sets lastAiEditChunkId — the reviewable-diff trigger", async () => {
    aiProcessStream.mockImplementation(
      async (_req: unknown, onDelta: (t: string) => void) => {
        onDelta("Expanded text.");
        return "Expanded text.";
      }
    );
    await runChunkAction("c1", "expand");
    const c = useStore.getState().doc.chunks.find((x) => x.id === "c1")!;
    expect(c.content).toBe("Expanded text.");
    // The previous content is preserved for the word-diff view…
    expect(c.metadata.contentHistory).toEqual([
      "Some long paragraph about photosynthesis.",
    ]);
    // …and this chunk is flagged so ChunkView auto-opens that diff.
    expect(useStore.getState().lastAiEditChunkId).toBe("c1");
  });

  it("bulletizeChunks replaces the chunk structurally with NO contentHistory and does NOT set lastAiEditChunkId — no reviewable diff exists for it", async () => {
    aiProcess.mockResolvedValue("- Point one\n- Point two\n- Point three");
    await bulletizeChunks(["c1"]);
    const chunks = useStore.getState().doc.chunks;
    // The original chunk is gone, replaced by one chunk per bullet.
    expect(chunks.map((c) => c.content)).toEqual([
      "Point one",
      "Point two",
      "Point three",
    ]);
    // None of the new chunks carry a content-history to diff against — the
    // "What changed" word-diff view (ChunkView.tsx) has nothing to render for
    // any of them, unlike runChunkAction's result above.
    for (const c of chunks) {
      expect(c.metadata.contentHistory ?? []).toEqual([]);
    }
    // Bulletize never sets lastAiEditChunkId, so no auto-shown diff panel
    // appears for it — only the toast's "⌘/Ctrl+Z to undo" applies.
    expect(useStore.getState().lastAiEditChunkId).toBeNull();
  });
});

// ---- w2-ai-a: document identity, op log, error localization, empty Analyze --

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const aiSettings = (lang: string) => ({
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "m",
  models: ["m"],
  imageModel: "im",
  imageModels: ["im"],
  defaultTargetLanguage: lang,
  writingTone: "",
  temperature: 0.3,
});

const st = () => useStore.getState();
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** Single clean tab holding `chunks`, freshly loaded (so it has its own docNonce). */
function resetAi(chunks: Chunk[], lang = "English", title = "T"): void {
  aiProcess.mockReset();
  aiProcessStream.mockReset();
  aiAnalyzeDocument.mockReset();
  aiGenerateImage.mockReset();
  aiGenerateDiagram.mockReset();
  useStore.setState({
    tabOrder: ["tab-1"],
    activeTabId: "tab-1",
    inactiveTabs: {},
    settings: aiSettings(lang),
    hasApiKey: true,
    globalBusy: null,
    busyChunks: {},
    streamingChunkId: null,
    streamingText: "",
    toasts: [],
    aiOpLog: [],
    aiModelIssue: null,
    networkOpen: false,
    selectedChunkIds: [],
    ghostSuggestion: null,
  });
  st().loadDocument({ ...doc(chunks), title });
}

/** The op-log entries without their timestamps (ts is Date.now()). */
const opLog = () => st().aiOpLog.map(({ ts: _ts, ...rest }) => rest);

describe("BUG-001b — a late AI result only lands in the load it was started on", () => {
  it("a late chunk-action result is not committed into a reopened copy of the same document (new tab)", async () => {
    resetAi([chunk("c1", "QA_AIX_TEST_")]);
    const d = deferred<string>();
    aiProcessStream.mockImplementation(() => d.promise);
    const run = runChunkAction("c1", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalled());
    st().newTab();
    st().loadDocument(doc([chunk("c1", "QA_AIX_TEST_001")]), "/x.aix");
    d.resolve("QA_AIX_TEST_Thank you very much for your purchase");
    await run;
    expect(st().doc.chunks[0].content).toBe("QA_AIX_TEST_001");
    expect(st().dirty).toBe(false);
    expect(last(opLog())).toMatchObject({ phase: "discard", action: "proofread", chunkId: "c1", reason: "tab-changed" });
  });

  it("a reload into the SAME tab (same ids, same text) discards the late result — only docNonce can tell", async () => {
    resetAi([chunk("c1", "QA_AIX_TEST_")]);
    const d = deferred<string>();
    aiProcessStream.mockImplementation(() => d.promise);
    const run = runChunkAction("c1", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalled());
    st().loadDocument(doc([chunk("c1", "QA_AIX_TEST_")]), "/x.aix");
    d.resolve("REPLACED");
    await run;
    expect(st().doc.chunks[0].content).toBe("QA_AIX_TEST_");
    expect(st().dirty).toBe(false);
    expect(last(opLog())).toMatchObject({ phase: "discard", reason: "doc-changed", chunkId: "c1" });
    expect(last(st().toasts)?.message).toBe("Switched away from that paragraph — result discarded.");
  });

  it("stream deltas of a stale op are not painted onto a reloaded document's same-id chunk", async () => {
    resetAi([chunk("c1", "QA_AIX_TEST_")]);
    let onDelta: (t: string) => void = () => {};
    const d = deferred<string>();
    aiProcessStream.mockImplementation((_req: unknown, cb: (t: string) => void) => {
      onDelta = cb;
      return d.promise;
    });
    const run = runChunkAction("c1", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalled());
    st().loadDocument(doc([chunk("c1", "QA_AIX_TEST_")]), "/x.aix");
    onDelta("stale partial");
    expect(st().streamingText).toBe("");
    d.resolve("REPLACED");
    await run;
  });

  it("a result for text the user has since edited is discarded, not written over the edit", async () => {
    resetAi([chunk("c1", "QA_AIX_TEST_")]);
    const d = deferred<string>();
    aiProcessStream.mockImplementation(() => d.promise);
    const run = runChunkAction("c1", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalled());
    st().updateChunkContent("c1", "QA_AIX_TEST_001");
    d.resolve("REPLACED");
    await run;
    expect(st().doc.chunks[0].content).toBe("QA_AIX_TEST_001");
    expect(last(st().toasts)?.message).toBe("The paragraph changed while AI was working — result discarded.");
    expect(last(opLog())).toMatchObject({ phase: "discard", reason: "text-changed" });
  });

  it("summarize is guarded too: a summary of the old text is not stamped onto edited text", async () => {
    resetAi([chunk("c1", "Original text.")]);
    const d = deferred<string>();
    aiProcess.mockImplementation(() => d.promise);
    const run = runChunkAction("c1", "summarize");
    await vi.waitFor(() => expect(aiProcess).toHaveBeenCalled());
    st().updateChunkContent("c1", "Rewritten text.");
    d.resolve("A summary of the original.");
    await run;
    expect(st().doc.chunks[0].metadata.summary).toBeUndefined();
  });

  it("a committed op logs start then commit — ids only, one pair per op", async () => {
    resetAi([chunk("c1", "Some text.")]);
    aiProcessStream.mockResolvedValue("Better text.");
    const { activeTabId, docNonce } = st();
    await runChunkAction("c1", "proofread");
    expect(st().doc.chunks[0].content).toBe("Better text.");
    const log = opLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ opId: log[0].opId, phase: "start", action: "proofread", tabId: activeTabId, docNonce, chunkId: "c1" });
    expect(log[1]).toEqual({ opId: log[0].opId, phase: "commit", action: "proofread", tabId: activeTabId, docNonce, chunkId: "c1" });
  });

  it("editSelection counts only the paragraphs that were actually rewritten", async () => {
    resetAi([chunk("c1", "First."), chunk("c2", "Second.")]);
    useStore.setState({ selectedChunkIds: ["c1", "c2"] });
    const d = deferred<string>();
    aiProcessStream.mockImplementationOnce(() => d.promise).mockResolvedValueOnce("Second, edited.");
    const run = editSelection("Make it formal");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(1));
    st().updateChunkContent("c1", "First, edited by the user.");
    d.resolve("First, edited by AI.");
    await run;
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["First, edited by the user.", "Second, edited."]);
    expect(last(st().toasts)?.message).toBe("Edited 1 paragraph.");
  });

  it("analyzeDocument does not apply a graph to a document reloaded into the same tab", async () => {
    resetAi([chunk("c1", "Claim."), chunk("c2", "Evidence.")]);
    const d = deferred<unknown>();
    aiAnalyzeDocument.mockImplementation(() => d.promise);
    const run = analyzeDocument();
    await vi.waitFor(() => expect(aiAnalyzeDocument).toHaveBeenCalled());
    st().loadDocument(doc([chunk("c1", "Claim."), chunk("c2", "Evidence.")]), "/x.aix");
    d.resolve({
      nodes: [
        { id: "c1", label: "a", summary: "", kind: "paragraph" },
        { id: "c2", label: "b", summary: "", kind: "paragraph" },
      ],
      edges: [{ source: "c2", target: "c1", relation: "evidence" }],
    });
    await run;
    expect(st().analysis?.nodes ?? []).toEqual([]);
    expect(st().dirty).toBe(false);
    expect(last(opLog())).toMatchObject({ phase: "discard", action: "analyze", reason: "doc-changed" });
  });

  it("bulletize does not replace paragraphs whose text changed while AI was working", async () => {
    resetAi([chunk("c1", "Long prose paragraph.")]);
    const d = deferred<string>();
    aiProcess.mockImplementation(() => d.promise);
    const run = bulletizeChunks(["c1"]);
    await vi.waitFor(() => expect(aiProcess).toHaveBeenCalled());
    st().updateChunkContent("c1", "Long prose paragraph, edited.");
    d.resolve("- one\n- two");
    await run;
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["Long prose paragraph, edited."]);
    expect(last(opLog())).toMatchObject({ phase: "discard", action: "bulletize", reason: "text-changed" });
  });
});

describe("promise-sync-3 — every AI action discards a late result after a same-id reload (behavioural)", () => {
  const heading = (id: string, content: string): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType: "heading", level: 2, linkedChunks: [] },
  });
  const image: Chunk = {
    id: "img",
    order: 0,
    content: "data:image/png;base64,AAAA",
    metadata: { chunkType: "image", linkedChunks: [], imagePrompt: "a cat" },
  };
  const fixture = () => [heading("h", "Slide title"), chunk("t", "Body text for the slide."), image];
  const withGraph = () =>
    st().applyAnalysis({
      nodes: [
        { id: "h", label: "h", summary: "", kind: "paragraph" },
        { id: "t", label: "t", summary: "", kind: "paragraph" },
      ],
      edges: [{ source: "t", target: "h", relation: "evidence" }],
    });
  const cases: {
    name: string;
    api: ReturnType<typeof vi.fn>;
    result: string;
    setup?: () => void;
    start: () => Promise<unknown>;
  }[] = [
    { name: "summarizeSlide", api: aiProcess, result: "- one\n- two", start: () => summarizeSlide(["t"], "h") },
    { name: "suggestSlideLayout", api: aiProcess, result: "title-image", start: () => suggestSlideLayout("h") },
    { name: "generateDiagramFromChunk", api: aiGenerateDiagram, result: "graph TD; A-->B", start: () => generateDiagramFromChunk("t") },
    { name: "generateImageFromChunk", api: aiGenerateImage, result: "data:image/png;base64,BBBB", start: () => generateImageFromChunk("t") },
    {
      name: "generateImageFromSelection",
      api: aiGenerateImage,
      result: "data:image/png;base64,BBBB",
      setup: () => useStore.setState({ selectedChunkIds: ["t"] }),
      start: () => generateImageFromSelection(),
    },
    { name: "generatePresentationFromChunk", api: aiGenerateImage, result: "data:image/png;base64,BBBB", start: () => generatePresentationFromChunk("t") },
    { name: "regenerateImageChunk", api: aiGenerateImage, result: "data:image/png;base64,CCCC", start: () => regenerateImageChunk("img") },
    { name: "reviewDocument", api: aiProcess, result: '{"comments":[{"chunkId":"t","text":"Cite a source."}]}', start: () => reviewDocument() },
    {
      name: "checkIntegrity",
      api: aiProcess,
      result: '{"findings":[{"chunkId":"t","kind":"gap","text":"Unsupported."}]}',
      setup: withGraph,
      start: () => checkIntegrity(),
    },
    {
      name: "checkAgainstCriteria",
      api: aiProcess,
      result: '{"results":[{"criterion":"Novelty","covered":true,"supportingChunkIds":["t"]}]}',
      setup: withGraph,
      start: () => checkAgainstCriteria(["Novelty"]),
    },
  ];

  it.each(cases)("$name: nothing lands in the reopened copy; the op logs discard/doc-changed", async (c) => {
    resetAi(fixture());
    c.setup?.();
    const d = deferred<string>();
    c.api.mockImplementation(() => d.promise);
    const run = c.start();
    await vi.waitFor(() => expect(c.api).toHaveBeenCalled());
    // Reopen the same file into the same tab: same chunk ids, same text.
    st().loadDocument({ ...doc(fixture()), title: "T" }, "/x.aix");
    const reopened = JSON.stringify(st().doc);
    d.resolve(c.result);
    const returned = await run;
    expect(JSON.stringify(st().doc)).toBe(reopened);
    expect(st().dirty).toBe(false);
    expect(last(opLog())).toMatchObject({ phase: "discard", reason: "doc-changed" });
    if (c.name === "checkAgainstCriteria") expect(returned).toBeNull();
  });

  it.each(cases)("$name: without a reload the same result commits (so the case above is not vacuous)", async (c) => {
    resetAi(fixture());
    c.setup?.();
    c.api.mockResolvedValue(c.result);
    await c.start();
    expect(last(opLog())).toMatchObject({ phase: "commit" });
  });

  it("generateImageFromChunk: Stop then a new image on the same paragraph — the stopped image never lands", async () => {
    resetAi(fixture());
    const a = deferred<string>();
    const b = deferred<string>();
    aiGenerateImage.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const runA = generateImageFromChunk("t");
    await vi.waitFor(() => expect(aiGenerateImage).toHaveBeenCalledTimes(1));
    cancelChunkAction("t");
    const runB = generateImageFromChunk("t");
    await vi.waitFor(() => expect(aiGenerateImage).toHaveBeenCalledTimes(2));
    a.resolve("data:image/png;base64,STOPPED");
    await runA;
    expect(st().busyChunks.t).toBe(true); // B still running
    b.resolve("data:image/png;base64,WANTED");
    await runB;
    const urls = st().doc.chunks.filter((x) => x.metadata.chunkType === "image").map((x) => x.content);
    expect(urls).toContain("data:image/png;base64,WANTED");
    expect(urls).not.toContain("data:image/png;base64,STOPPED");
    expect(st().busyChunks.t).toBeUndefined();
  });
});

describe("state-async-4 — Analyze never stamps a summary of old text as fresh", () => {
  const graph = (summary: string) => ({
    nodes: [
      { id: "p", label: "P", summary, kind: "paragraph" },
      { id: "q", label: "Q", summary: "Method.", kind: "paragraph" },
    ],
    edges: [{ source: "q", target: "p", relation: "evidence" }],
  });

  it("an edit made while Analyze runs leaves the edited chunk's summary stale and the graph out of date", async () => {
    resetAi([chunk("p", "Results were positive."), chunk("q", "Method.")]);
    const d = deferred<unknown>();
    aiAnalyzeDocument.mockImplementation(() => d.promise);
    const run = analyzeDocument();
    await vi.waitFor(() => expect(aiAnalyzeDocument).toHaveBeenCalled());
    st().updateChunkContent("p", "Results were negative.");
    d.resolve(graph("Positive results."));
    await run;
    expect(st().doc.chunks[0].metadata.summary).toBe("Positive results.");
    expect(staleSummaryChunkIds(st().doc)).toEqual(["p"]);
    expect(st().analysisStale).toBe(true);
  });

  it("an unedited run is fresh: hashes match and analysisStale is false (non-regression)", async () => {
    resetAi([chunk("p", "Results were positive."), chunk("q", "Method.")]);
    aiAnalyzeDocument.mockResolvedValue(graph("Positive results."));
    await analyzeDocument();
    expect(staleSummaryChunkIds(st().doc)).toEqual([]);
    expect(st().analysisStale).toBe(false);
  });

  it("a paragraph added while Analyze runs keeps the graph out of date", async () => {
    resetAi([chunk("p", "Results were positive."), chunk("q", "Method.")]);
    const d = deferred<unknown>();
    aiAnalyzeDocument.mockImplementation(() => d.promise);
    const run = analyzeDocument();
    await vi.waitFor(() => expect(aiAnalyzeDocument).toHaveBeenCalled());
    useStore.setState({
      doc: { ...st().doc, chunks: [...st().doc.chunks, chunk("r", "New claim.")] },
    });
    d.resolve(graph("Positive results."));
    await run;
    expect(st().analysisStale).toBe(true);
  });
});

describe("state-async-2 — Stop and re-run on one paragraph are keyed by op, not by chunk", () => {
  it("Stop, then a new action on the same paragraph: the stopped result never commits and never clears the new op's UI", async () => {
    resetAi([chunk("p", "foo")]);
    const a = deferred<string>();
    const b = deferred<string>();
    let onDeltaB: (t: string) => void = () => {};
    aiProcessStream
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce((_req: unknown, cb: (t: string) => void) => {
        onDeltaB = cb;
        return b.promise;
      });
    const runA = runChunkAction("p", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(1));
    cancelChunkAction("p");
    const runB = runChunkAction("p", "translate", { targetLanguage: "Japanese" });
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(2));
    a.resolve("PROOFREAD (stopped)");
    expect(await runA).toBe(false);
    expect(st().doc.chunks[0].content).toBe("foo");
    // B's spinner and live stream survive A's late resolution.
    expect(st().busyChunks.p).toBe(true);
    expect(st().streamingChunkId).toBe("p");
    onDeltaB("ふー");
    expect(st().streamingText).toBe("ふー");
    b.resolve("ふー（訳）");
    expect(await runB).toBe(true);
    expect(st().doc.chunks[0].content).toBe("ふー（訳）");
    expect(st().busyChunks.p).toBeUndefined();
    expect(st().streamingChunkId).toBeNull();
    const toasts = st().toasts.map((t) => t.message);
    expect(toasts).not.toContain("The paragraph changed while AI was working — result discarded.");
    const discards = opLog().filter((e) => e.phase === "discard");
    expect(discards).toEqual([expect.objectContaining({ action: "proofread", reason: "canceled" })]);
  });

  it("a newer action without Stop supersedes the older one (no commit of the older result)", async () => {
    resetAi([chunk("p", "foo")]);
    const a = deferred<string>();
    const b = deferred<string>();
    aiProcessStream.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const runA = runChunkAction("p", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(1));
    const runB = runChunkAction("p", "expand");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(2));
    a.resolve("A result");
    expect(await runA).toBe(false);
    expect(st().busyChunks.p).toBe(true);
    b.resolve("B result");
    expect(await runB).toBe(true);
    expect(st().doc.chunks[0].content).toBe("B result");
    expect(st().toasts.map((t) => t.message)).not.toContain("Stopped — result discarded.");
    expect(opLog().filter((e) => e.phase === "discard")).toEqual([
      expect.objectContaining({ action: "proofread", reason: "superseded" }),
    ]);
  });

  it("Stop still discards a lone stopped action (non-regression)", async () => {
    resetAi([chunk("p", "foo")]);
    const a = deferred<string>();
    aiProcessStream.mockImplementationOnce(() => a.promise);
    const runA = runChunkAction("p", "proofread");
    await vi.waitFor(() => expect(aiProcessStream).toHaveBeenCalledTimes(1));
    cancelChunkAction("p");
    expect(st().busyChunks.p).toBeUndefined();
    a.resolve("late");
    expect(await runA).toBe(false);
    expect(st().doc.chunks[0].content).toBe("foo");
    expect(last(st().toasts)?.message).toBe("Stopped — result discarded.");
  });
});

describe("BUG-015a — Analyze on an empty document", () => {
  it("is a non-destructive no-op: no IPC, no store change, a localized notice", async () => {
    resetAi([chunk("a", "   ")], "English", "");
    aiAnalyzeDocument.mockResolvedValue({ nodes: [], edges: [] });
    await analyzeDocument();
    expect(aiAnalyzeDocument).not.toHaveBeenCalled();
    expect(st().dirty).toBe(false);
    expect(st().analysis).toBeNull();
    expect(st().networkOpen).toBe(false);
    expect(st().aiOpLog).toEqual([]);
    expect(last(st().toasts)?.message).toBe("Nothing to analyze yet — write some text first.");
  });

  it("the empty-document notice wins over the missing-key prompt (no Settings popup for a blank doc)", async () => {
    resetAi([chunk("a", "　\n")]);
    useStore.setState({ hasApiKey: false, settingsOpen: false });
    await analyzeDocument();
    expect(st().settingsOpen).toBe(false);
    expect(last(st().toasts)?.message).toBe("Nothing to analyze yet — write some text first.");
  });

  it("a heading-only document is still sent (non-regression: headings are analyzable)", async () => {
    const h: Chunk = { id: "h", order: 0, content: "Methods", metadata: { chunkType: "heading", level: 2, linkedChunks: [] } };
    resetAi([h]);
    aiAnalyzeDocument.mockResolvedValue({ nodes: [], edges: [] });
    await analyzeDocument();
    expect(aiAnalyzeDocument).toHaveBeenCalledTimes(1);
  });
});

describe("AI errors, busy labels and count toasts follow the UI language", () => {
  const unavailable =
    "Network / API error: Model unavailable: 'meta-llama/llama-3.3-70b-instruct:free' could not be served by the provider (HTTP 404). Choose another model in Settings. (provider: No endpoints found)";

  it("a model-unavailable failure is shown in Japanese and flags the model issue", async () => {
    resetAi([chunk("c1", "本文です。")], "日本語");
    aiProcessStream.mockRejectedValue(unavailable);
    await runChunkAction("c1", "proofread");
    expect(last(st().toasts)).toMatchObject({
      kind: "error",
      message:
        "モデル「meta-llama/llama-3.3-70b-instruct:free」は提供元で利用できません。設定で別のモデルを選んでください。（提供元: No endpoints found）",
    });
    expect(st().aiModelIssue).toEqual({ model: "meta-llama/llama-3.3-70b-instruct:free" });
    expect(last(opLog())).toMatchObject({ phase: "discard", reason: "error:model-unavailable" });
  });

  it("other provider errors are localized but do NOT flag the model", async () => {
    resetAi([chunk("c1", "本文です。")], "日本語");
    aiAnalyzeDocument.mockRejectedValue("Network / API error: Rate limited (429). Slow down. (provider: busy)");
    await analyzeDocument();
    expect(last(st().toasts)?.message).toBe(
      "利用制限中です(429)。少し待って再試行するか、設定でモデルを切り替えるか、openrouter.ai でクレジットを追加してください。（提供元: busy）"
    );
    expect(st().aiModelIssue).toBeNull();
  });

  it("the Analyze busy label is Japanese in the Japanese UI", async () => {
    resetAi([chunk("c1", "本文です。")], "日本語");
    const d = deferred<unknown>();
    aiAnalyzeDocument.mockImplementation(() => d.promise);
    const run = analyzeDocument();
    await vi.waitFor(() => expect(aiAnalyzeDocument).toHaveBeenCalled());
    expect(st().globalBusy).toBe("ドキュメントを分析中…");
    d.resolve({ nodes: [], edges: [] });
    await run;
    expect(st().globalBusy).toBeNull();
  });

  it("the Analyze count toast is interpolated in Japanese", async () => {
    resetAi([chunk("c1", "主張。"), chunk("c2", "根拠。")], "日本語");
    aiAnalyzeDocument.mockResolvedValue({
      nodes: [
        { id: "c1", label: "a", summary: "", kind: "paragraph" },
        { id: "c2", label: "b", summary: "", kind: "paragraph" },
      ],
      edges: [{ source: "c2", target: "c1", relation: "evidence" }],
    });
    await analyzeDocument();
    expect(last(st().toasts)?.message).toBe("2個のノードと1件の関係が見つかりました。");
    expect(opLog().map((e) => e.phase)).toEqual(["start", "commit"]);
  });
});

describe("aiOpLogToJsonLines — the NetworkPanel Copy payload", () => {
  it("emits one JSON object per line, oldest first, with only the logged fields", () => {
    const out = aiOpLogToJsonLines([
      { ts: 1, opId: 1, phase: "start", action: "proofread", tabId: "t", docNonce: 3, chunkId: "c1" },
      { ts: 2, opId: 1, phase: "discard", action: "proofread", tabId: "t", docNonce: 3, chunkId: "c1", reason: "doc-changed" },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: 1, opId: 1, phase: "start", action: "proofread", tabId: "t", docNonce: 3, chunkId: "c1" });
    expect(JSON.parse(lines[1])).toMatchObject({ phase: "discard", reason: "doc-changed" });
  });

  it("is empty for an empty log", () => {
    expect(aiOpLogToJsonLines([])).toBe("");
  });
});
