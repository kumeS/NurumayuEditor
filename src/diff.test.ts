import { describe, expect, it } from "vitest";
import { changeSummary, documentDiff, wordDiff } from "./diff";
import type { Chunk, Document } from "./types";

function chunk(id: string, content: string, order = 0): Chunk {
  return { id, order, content, metadata: { chunkType: "text", linkedChunks: [] } };
}

function doc(chunks: Chunk[]): Document {
  return { id: "d", title: "T", chunks, mode: "editor" };
}

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

  it("ignores whitespace-only differences (delegates to changed()'s trim guard)", () => {
    const saved = doc([chunk("a", "Hello world")]);
    const current = doc([chunk("a", "Hello world  ")]);
    const result = documentDiff(saved, current);
    expect(result.changed).toEqual([]);
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
  const titled = (chunks: Chunk[], title: string): Document => ({ ...doc(chunks), title });
  const NONE = { paragraphs: 0, titleChanged: false, otherChanged: false };

  it("a title-only edit is reported as a title change", () => {
    const saved = titled([chunk("a", "x")], "Old");
    // documentDiff alone (what the old label used) sees nothing here:
    expect(documentDiff(saved, { ...saved, title: "New" }).changed).toHaveLength(0);
    expect(changeSummary(saved, { ...saved, title: "New" })).toEqual({
      paragraphs: 0,
      titleChanged: true,
      otherChanged: false,
    });
  });

  it("counts added + removed + changed paragraphs", () => {
    const saved = doc([chunk("a", "A"), chunk("b", "B")]);
    const current = doc([chunk("a", "A!"), chunk("c", "C")]);
    expect(changeSummary(saved, current)).toEqual({ paragraphs: 3, titleChanged: false, otherChanged: false });
  });

  it("an analysis-only change is an 'other' change", () => {
    const saved = doc([chunk("a", "x")]);
    const current = { ...saved, analysis: { nodes: [], edges: [], analyzedAt: 1 } };
    expect(changeSummary(saved, current)).toEqual({ paragraphs: 0, titleChanged: false, otherChanged: true });
  });

  it("a comment or confirmed flag on a paragraph is an 'other' change", () => {
    const a = chunk("a", "x");
    const saved = doc([a]);
    const commented = doc([
      { ...a, metadata: { ...a.metadata, comments: [{ id: "c1", text: "hm", createdAt: 1 }] } },
    ]);
    const confirmed = doc([{ ...a, metadata: { ...a.metadata, confirmed: true } }]);
    expect(changeSummary(saved, commented)).toEqual({ paragraphs: 0, titleChanged: false, otherChanged: true });
    expect(changeSummary(saved, confirmed)).toEqual({ paragraphs: 0, titleChanged: false, otherChanged: true });
  });

  it("reordering paragraphs is an 'other' change (detected from the id sequence)", () => {
    const saved = doc([chunk("a", "A", 0), chunk("b", "B", 1)]);
    const current = doc([chunk("b", "B", 0), chunk("a", "A", 1)]);
    expect(changeSummary(saved, current)).toEqual({ paragraphs: 0, titleChanged: false, otherChanged: true });
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

  it("mode and markdownSource never count (switching modes does not dirty the document)", () => {
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
      paragraphs: 2,
      titleChanged: true,
      otherChanged: false,
    });
    expect(changeSummary(null, titled([], ""))).toEqual(NONE);
  });
});
