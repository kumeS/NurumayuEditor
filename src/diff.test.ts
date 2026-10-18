import { describe, expect, it } from "vitest";
import { changeSummary, documentDiff, hasChanges, sameAsSaved, wordDiff } from "./diff";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import type { Chunk, Document } from "./types";

function chunk(id: string, content: string, order = 0): Chunk {
  return { id, order, content, metadata: { chunkType: "text", linkedChunks: [] } };
}

function doc(chunks: Chunk[]): Document {
  return { id: "d", title: "T", chunks, mode: "editor" };
}

const titled = (chunks: Chunk[], title: string): Document => ({ ...doc(chunks), title });
const NONE = { paragraphs: 0, titleChanged: false, otherChanged: false, sourceChanged: false };

describe("documentDiff", () => {
  it("reports no changes at all when saved and current are identical (no-op path)", () => {
    const saved = doc([chunk("a", "Hello"), chunk("b", "World")]);
    const current = doc([chunk("a", "Hello"), chunk("b", "World")]);
    const result = documentDiff(saved, current);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("classifies a chunk id present only in current as added", () => {
    const saved = doc([chunk("a", "Hello")]);
    const current = doc([chunk("a", "Hello"), chunk("b", "New paragraph")]);
    const result = documentDiff(saved, current);
    expect(result.added.map((c) => c.id)).toEqual(["b"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("classifies a chunk id present only in saved as removed", () => {
    const saved = doc([chunk("a", "Hello"), chunk("b", "Gone soon")]);
    const current = doc([chunk("a", "Hello")]);
    const result = documentDiff(saved, current);
    expect(result.removed.map((c) => c.id)).toEqual(["b"]);
    expect(result.added).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("classifies a chunk present in both with different content as changed, carrying before/after", () => {
    const saved = doc([chunk("a", "Hello world")]);
    const current = doc([chunk("a", "Hello there world")]);
    const result = documentDiff(saved, current);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([
      { id: "a", before: "Hello world", after: "Hello there world" },
    ]);
  });

  it("preserves current's chunk order for stable UI ordering", () => {
    const saved = doc([chunk("a", "A"), chunk("b", "B")]);
    // Current re-orders b before a, and both are edited.
    const current = doc([chunk("b", "B!", 0), chunk("a", "A!", 1)]);
    const result = documentDiff(saved, current);
    expect(result.changed.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("classifies a single-character edit to a Japanese paragraph as changed, never as remove+add", () => {
    // Chunk identity is by id, not content — a one-character CJK edit must
    // stay a "changed" entry, not a misclassified remove(old)+add(new) pair,
    // since CJK prose has no word-boundary whitespace to lean on for identity.
    const saved = doc([chunk("p1", "これは日本語の段落です。")]);
    const current = doc([chunk("p1", "これは日本語の段落でした。")]);
    const result = documentDiff(saved, current);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([
      { id: "p1", before: "これは日本語の段落です。", after: "これは日本語の段落でした。" },
    ]);
  });

  it("treats a null saved baseline (no prior save) as an all-added document", () => {
    const current = doc([chunk("a", "Hello")]);
    const result = documentDiff(null, current);
    expect(result.added.map((c) => c.id)).toEqual(["a"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  // Flipped (BUG-001/005, QA 20261003): "changes since last save" must agree
  // with the dirty flag, and a trailing double space is a Markdown hard break
  // — so a whitespace-only edit is a change. (changed() itself still trims for
  // ChunkView's AI-edit highlight.) Fails if documentDiff goes back to changed().
  it("counts a whitespace-only edit as changed (a trailing double space is a Markdown hard break)", () => {
    const saved = doc([chunk("a", "Hello world")]);
    const current = doc([chunk("a", "Hello world  ")]);
    const result = documentDiff(saved, current);
    expect(result.changed).toEqual([{ id: "a", before: "Hello world", after: "Hello world  " }]);
  });
});

describe("wordDiff (existing behavior, unchanged)", () => {
  it("still diffs plain-text word insertions", () => {
    const ops = wordDiff("Hello world", "Hello there world");
    expect(ops.some((o) => o.type === "insert" && o.text.includes("there"))).toBe(true);
  });
});

// ----- w3-healthbar: BUG-015b + MISS-12 — what kind of change is unsaved -----
describe("changeSummary (BUG-015b: the health bar must not say 'no changes' while dirty)", () => {

  it("a title-only edit is reported as a title change", () => {
    const saved = titled([chunk("a", "x")], "Old");
    // documentDiff alone (what the old label used) sees nothing here:
    expect(documentDiff(saved, { ...saved, title: "New" }).changed).toHaveLength(0);
    expect(changeSummary(saved, { ...saved, title: "New" })).toEqual({ ...NONE, titleChanged: true });
  });

  it("counts added + removed + changed paragraphs", () => {
    const saved = doc([chunk("a", "A"), chunk("b", "B")]);
    const current = doc([chunk("a", "A!"), chunk("c", "C")]);
    expect(changeSummary(saved, current)).toEqual({ ...NONE, paragraphs: 3 });
  });

  it("an analysis-only change is an 'other' change", () => {
    const saved = doc([chunk("a", "x")]);
    const current = { ...saved, analysis: { nodes: [], edges: [], analyzedAt: 1 } };
    expect(changeSummary(saved, current)).toEqual({ ...NONE, otherChanged: true });
  });

  it("a comment or confirmed flag on a paragraph is an 'other' change", () => {
    const a = chunk("a", "x");
    const saved = doc([a]);
    const commented = doc([
      { ...a, metadata: { ...a.metadata, comments: [{ id: "c1", text: "hm", createdAt: 1 }] } },
    ]);
    const confirmed = doc([{ ...a, metadata: { ...a.metadata, confirmed: true } }]);
    expect(changeSummary(saved, commented)).toEqual({ ...NONE, otherChanged: true });
    expect(changeSummary(saved, confirmed)).toEqual({ ...NONE, otherChanged: true });
  });

  it("reordering paragraphs is an 'other' change (detected from the id sequence)", () => {
    const saved = doc([chunk("a", "A", 0), chunk("b", "B", 1)]);
    const current = doc([chunk("b", "B", 0), chunk("a", "A", 1)]);
    expect(changeSummary(saved, current)).toEqual({ ...NONE, otherChanged: true });
  });

  it("metadata key order, undefined keys and contentHistory are not changes", () => {
    const saved = doc([chunk("a", "x")]);
    const current = doc([
      {
        id: "a",
        order: 0,
        content: "x",
        metadata: { linkedChunks: [], chunkType: "text", summary: undefined, contentHistory: ["old"] },
      },
    ]);
    expect(changeSummary(saved, current)).toEqual(NONE);
  });

  // Reworded (BUG-005, QA 20261003): mode never counts; a markdownSource
  // counts only when it differs from the Markdown the document already stands
  // for — "# T\n\nx\n" is exactly what this doc serializes to.
  it("mode never counts, nor a markdownSource equal to the doc's own serialization", () => {
    const saved = doc([chunk("a", "x")]);
    expect(changeSummary(saved, { ...saved, mode: "markdown" })).toEqual(NONE);
    expect(changeSummary(saved, { ...saved, markdownSource: "# T\n\nx\n" })).toEqual(NONE);
  });

  it("the same document (undo back to the saved state) has no changes", () => {
    const saved = titled([chunk("a", "これは段落です。")], "題名");
    expect(changeSummary(saved, saved)).toEqual(NONE);
    expect(changeSummary(saved, titled([chunk("a", "これは段落です。")], "題名"))).toEqual(NONE);
  });

  it("a null baseline counts every paragraph and a non-empty title", () => {
    expect(changeSummary(null, titled([chunk("a", "x"), chunk("b", "y")], "T"))).toEqual({
      ...NONE,
      paragraphs: 2,
      titleChanged: true,
    });
    expect(changeSummary(null, titled([], ""))).toEqual(NONE);
  });
});

// ----- BUG-001 / BUG-005 / BUG-007 (QA 20261003): ONE equality notion -----
// The store's dirty flag (sameAsSaved) and the health bar / DiffPanel
// (changeSummary) used to disagree — mode/markdownSource counted for one and
// not the other — so the UI read 未保存 + 保存時と同じ内容 together.
describe("sameAsSaved ⇔ changeSummary reports nothing (contract)", () => {
  const meta = (extra: Partial<Chunk["metadata"]> = {}): Chunk["metadata"] => ({
    chunkType: "text",
    linkedChunks: [],
    ...extra,
  });
  // A source edit as setMarkdownSource applies it: re-parsed over `prev`, so
  // chunk ids carry over positionally (a fresh parse would mint new ids).
  const md = (source: string, prev?: Document): Document =>
    markdownToDocument(prev ?? { id: "d", title: "stem", chunks: [], mode: "editor" }, source);
  const FM = "---\nk: v\n---\n\n# 見出し\n\n本文です。\n\n\n二段落目  \n";
  const CRLF = "# 題名\r\n\r\n本文\r\n";
  const FM_DOC = md(FM);
  const CRLF_DOC = md(CRLF);
  const H1_DOC = md("# 題名\n\n本文\n");
  const base = doc([chunk("a", "これは段落です。", 0), chunk("b", "Second", 1)]);
  const withChunk = (d: Document, i: number, patch: Partial<Chunk>): Document => ({
    ...d,
    chunks: d.chunks.map((c, k) => (k === i ? { ...c, ...patch } : c)),
  });

  // [name, saved, current, expectedSame]
  const cases: [string, Document, Document, boolean][] = [
    ["identical object", base, base, true],
    ["structural copy", base, JSON.parse(JSON.stringify(base)), true],
    ["mode only (view switch)", base, { ...base, mode: "slide" }, true],
    ["markdownSource = the doc's own serialization", base, { ...base, mode: "markdown", markdownSource: documentToMarkdown(base) }, true],
    ["metadata key order / undefined keys", base, withChunk(base, 0, { metadata: { linkedChunks: [], chunkType: "text", summary: undefined } }), true],
    ["contentHistory only (ignored)", base, withChunk(base, 0, { metadata: meta({ contentHistory: ["old"] }) }), true],
    ["renderedImage only (export-only, ignored)", base, withChunk(base, 0, { metadata: meta({ renderedImage: "data:x" }) }), true],
    [".md opened in Markdown mode vs the same doc switched to Editor", FM_DOC, { ...FM_DOC, mode: "editor" }, true],
    ["two all-blank Markdown sources (no content either way)", { ...doc([chunk("e", "")], ""), mode: "markdown", markdownSource: "" }, { ...doc([chunk("e", "")], ""), mode: "markdown", markdownSource: "\n" }, true],
    ["paragraph text", base, withChunk(base, 0, { content: "これは段落でした。" }), false],
    ["whitespace-only paragraph edit", base, withChunk(base, 1, { content: "Second  " }), false],
    ["title", base, { ...base, title: "T2" }, false],
    ["title whitespace only", base, { ...base, title: " T" }, false],
    ["speaker notes", base, withChunk(base, 0, { metadata: meta({ notes: "ノート" }) }), false],
    ["comment", base, withChunk(base, 0, { metadata: meta({ comments: [{ id: "c", text: "要確認", createdAt: 1 }] }) }), false],
    ["links", base, withChunk(base, 0, { metadata: meta({ linkedChunks: ["b"] }) }), false],
    ["summary", base, withChunk(base, 0, { metadata: meta({ summary: "要約" }) }), false],
    ["layout", base, withChunk(base, 0, { metadata: meta({ layout: "section" }) }), false],
    ["chunk order (sequence)", base, { ...base, chunks: [base.chunks[1], base.chunks[0]] }, false],
    ["chunk order field only", base, withChunk(base, 1, { order: 7 }), false],
    ["duplicated chunk id", base, { ...base, chunks: [...base.chunks, base.chunks[1]] }, false],
    ["analysis", base, { ...base, analysis: { nodes: [], edges: [], analyzedAt: 1 } }, false],
    ["document id", base, { ...base, id: "other" }, false],
    ["paragraph added", base, { ...base, chunks: [...base.chunks, chunk("c", "")] }, false],
    ["frontmatter only", FM_DOC, md(FM.replace("k: v", "k: w"), FM_DOC), false],
    ["blank-line run only", FM_DOC, md(FM.replace("\n\n\n二段落目", "\n\n二段落目"), FM_DOC), false],
    ["line endings only (CRLF → LF)", CRLF_DOC, md(CRLF.replace(/\r\n/g, "\n"), CRLF_DOC), false],
    ["H1 marker style only", H1_DOC, md("# 題名 ##\n\n本文\n", H1_DOC), false],
    ["Markdown-mode source vs an editor doc that serializes differently", base, { ...base, mode: "markdown", markdownSource: `${documentToMarkdown(base)}\n` }, false],
  ];

  it.each(cases)("%s", (_name, saved, current, expectedSame) => {
    // Fails if sameAsSaved and changeSummary drift apart on this pair, or if
    // the pair is classified the wrong way (a false "same" loses data on close).
    expect(sameAsSaved(saved, current)).toBe(expectedSame);
    expect(hasChanges(changeSummary(saved, current))).toBe(!expectedSame);
  });

  it("a source-only difference is reported as sourceChanged, and only then", () => {
    expect(changeSummary(FM_DOC, md(FM.replace("k: v", "k: w"), FM_DOC))).toEqual({ ...NONE, sourceChanged: true });
    // A paragraph change explains the source change: no extra flag.
    expect(changeSummary(FM_DOC, md(FM.replace("本文です。", "本文でした。"), FM_DOC))).toEqual({ ...NONE, paragraphs: 1 });
  });

  it("a null baseline is never 'same' (a doc with no baseline always needs saving)", () => {
    expect(sameAsSaved(null, titled([], ""))).toBe(false);
  });
});
