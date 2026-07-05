import { describe, expect, it } from "vitest";
import { chunksOverCharLimit, countCharacters } from "./charLimitWarnings";
import type { Chunk } from "./types";

function textChunk(id: string, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: "text", linkedChunks: [] } };
}

describe("countCharacters — CJK-aware character counting", () => {
  it("counts a string of N CJK characters as exactly N, not something else", () => {
    const cjk = "日本語のテキストです"; // 10 Japanese characters
    expect(cjk.length).toBe(10); // BMP CJK: .length already agrees here
    expect(countCharacters(cjk)).toBe(10);
  });

  it("counts astral-plane characters (surrogate pairs) as one each, unlike .length", () => {
    // U+1F600 GRINNING FACE is outside the BMP: encoded as a UTF-16 surrogate
    // pair, so raw .length reports 2 per emoji while a user sees 1 character.
    const twoEmoji = "\u{1F600}\u{1F600}";
    expect(twoEmoji.length).toBe(4); // naive .length double-counts
    expect(countCharacters(twoEmoji)).toBe(2);
  });

  it("returns 0 for an empty string", () => {
    expect(countCharacters("")).toBe(0);
  });
});

describe("chunksOverCharLimit — boundary values", () => {
  it("a paragraph exactly AT the limit does not count as over", () => {
    const chunks = [textChunk("a", "x".repeat(100))];
    expect(chunksOverCharLimit(chunks, 100)).toEqual([]);
  });

  it("a paragraph ONE character over the limit is flagged", () => {
    const chunks = [textChunk("a", "x".repeat(101))];
    expect(chunksOverCharLimit(chunks, 100)).toEqual([{ id: "a", count: 101 }]);
  });

  it("counts CJK content by character, not UTF-16 units, against the limit", () => {
    // 101 CJK characters should be flagged against a 100-char limit exactly
    // like 101 Latin characters would be — the whole point of CJK-awareness.
    const chunks = [textChunk("a", "字".repeat(101))];
    expect(chunksOverCharLimit(chunks, 100)).toEqual([{ id: "a", count: 101 }]);
  });

  it("returns [] when no limit is configured (feature off)", () => {
    const chunks = [textChunk("a", "x".repeat(100000))];
    expect(chunksOverCharLimit(chunks, undefined)).toEqual([]);
  });

  it("ignores non-positive or non-finite limits defensively", () => {
    const chunks = [textChunk("a", "x".repeat(100000))];
    expect(chunksOverCharLimit(chunks, 0)).toEqual([]);
    expect(chunksOverCharLimit(chunks, -5)).toEqual([]);
    expect(chunksOverCharLimit(chunks, Number.NaN)).toEqual([]);
  });

  it("skips non-text/heading chunks (e.g. images/diagrams have no prose length)", () => {
    const image: Chunk = {
      id: "img",
      order: 0,
      content: "x".repeat(1000),
      metadata: { chunkType: "image", linkedChunks: [] },
    };
    expect(chunksOverCharLimit([image], 10)).toEqual([]);
  });

  it("flags multiple over-limit chunks, preserving order, and skips under-limit ones", () => {
    const chunks = [
      textChunk("short", "ok"),
      textChunk("long1", "x".repeat(50)),
      textChunk("mid", "fine"),
      textChunk("long2", "y".repeat(60)),
    ];
    expect(chunksOverCharLimit(chunks, 20)).toEqual([
      { id: "long1", count: 50 },
      { id: "long2", count: 60 },
    ]);
  });
});
