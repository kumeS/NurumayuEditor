import { beforeEach, describe, expect, it, vi } from "vitest";

// `gatherRagSnippets` calls `api.ragListSources`/`api.ragSearch`, which invoke
// Tauri IPC — mocked here so this stays a hermetic, fast unit test (no real
// Tauri runtime exists under vitest's plain Node environment) and so the
// "zero query attempts when disabled/empty" assertions below can inspect
// exactly how many times each was called.
const ragListSources = vi.fn();
const ragSearch = vi.fn();
vi.mock("./api", () => ({
  api: {
    ragListSources: (...args: unknown[]) => ragListSources(...args),
    ragSearch: (...args: unknown[]) => ragSearch(...args),
  },
}));

import { extractJsonObject, gatherRagSnippets, parseBulletLines, parseCriteriaResults } from "./aiActions";
import { useStore } from "./store";
import type { Chunk, Document } from "./types";

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
});
