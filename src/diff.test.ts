import { describe, expect, it } from "vitest";
import { documentDiff, wordDiff } from "./diff";
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
