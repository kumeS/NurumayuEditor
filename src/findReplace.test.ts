import { describe, expect, it } from "vitest";
import {
  chunkDocOffset,
  findAvailability,
  findInChunks,
  findMatches,
  findSeed,
  lineCount,
  lineStartOffset,
  nextMatch,
  replaceAll,
  replacementChanges,
  applyChanges,
  lineInputDigits,
} from "./findReplace";
import type { Chunk, ChunkType } from "./types";

// BUG-010: pure core behind the docked find bar (FindBar.tsx), the chunk
// replace actions in store.ts and the CodeMirror replace in MarkdownEditor.

const opts = { caseSensitive: false, wholeWord: false };
const exact = { caseSensitive: true, wholeWord: false };
const word = { caseSensitive: true, wholeWord: true };

function chunk(id: string, type: ChunkType, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: type, linkedChunks: [] } };
}

describe("findMatches", () => {
  it("finds CJK and mixed-script matches with correct offsets", () => {
    expect(findMatches("日本語の日本とNihon", "日本", opts)).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]);
    expect(findMatches("猫cat猫CAT", "cat", opts)).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 8 },
    ]);
  });

  it("case-insensitive search does not drift offsets (Turkish dotted I)", () => {
    // 'İ'.toLowerCase() is two code units, so a lower-casing search would
    // report the second match at 10.
    const ms = findMatches("İstanbul istanbul", "istanbul", opts);
    expect(ms.map((m) => m.from)).toContain(9);
    for (const m of ms) expect("İstanbul istanbul".slice(m.from, m.to).toLowerCase()).toBe("istanbul");
  });

  it("case-sensitive search only finds the exact case", () => {
    expect(findMatches("Cat cat CAT", "cat", exact)).toEqual([{ from: 4, to: 7 }]);
    expect(findMatches("Cat cat CAT", "cat", opts)).toHaveLength(3);
  });

  it("regex metacharacters in the query are literal", () => {
    expect(findMatches("a.b axb", "a.b", opts)).toEqual([{ from: 0, to: 3 }]);
    expect(findMatches("(1+1)*2 [x] $^ \\d", "(1+1)*", opts)).toEqual([{ from: 0, to: 6 }]);
    expect(findMatches("price $5 and $^", "$^", opts)).toEqual([{ from: 13, to: 15 }]);
    expect(findMatches("a\\d1", "\\d", opts)).toEqual([{ from: 1, to: 3 }]);
    // Characters that are NOT regex syntax must not be escaped either: "\-"
    // is a SyntaxError under the `u` flag.
    expect(findMatches("x-y / z", "-y /", opts)).toEqual([{ from: 1, to: 5 }]);
  });

  it("matches are non-overlapping", () => {
    expect(findMatches("aaaa", "aa", opts)).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it("empty query finds nothing", () => {
    expect(findMatches("abc", "", opts)).toEqual([]);
    expect(findMatches("", "a", opts)).toEqual([]);
  });

  it("surrogate pairs (emoji) keep UTF-16 offsets", () => {
    expect(findMatches("😀猫😀猫", "猫", opts)).toEqual([
      { from: 2, to: 3 },
      { from: 5, to: 6 },
    ]);
  });
});

describe("findMatches — whole word", () => {
  it("applies to Latin edges", () => {
    expect(findMatches("concat cat", "cat", word)).toEqual([{ from: 7, to: 10 }]);
    expect(findMatches("cat_x cat1 cat", "cat", word)).toEqual([{ from: 11, to: 14 }]);
    expect(findMatches("cat, cat.", "cat", word)).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 8 },
    ]);
  });

  it("is a no-op on CJK edges (CJK has no spaces between words)", () => {
    expect(findMatches("日本語の日本", "日本", word)).toHaveLength(2);
  });

  it("treats CJK neighbours of a Latin word as boundaries", () => {
    expect(findMatches("これはcatです", "cat", word)).toEqual([{ from: 3, to: 6 }]);
  });

  it("a rejected candidate does not hide an overlapping valid match", () => {
    // Candidate at 1 is glued to "b"; the valid one at 3 overlaps it.
    expect(findMatches("ba.a.a", "a.a", word)).toEqual([{ from: 3, to: 6 }]);
  });

  it("checks whole code points next to the match (surrogate-safe)", () => {
    // U+1D41A MATHEMATICAL BOLD SMALL A is a letter outside the BMP.
    expect(findMatches("\u{1D41A}cat cat", "cat", word)).toEqual([{ from: 6, to: 9 }]);
    expect(findMatches("😀cat", "cat", word)).toEqual([{ from: 2, to: 5 }]);
  });
});

describe("replaceAll / replacementChanges", () => {
  it("replacement is literal ($& is not a backreference)", () => {
    expect(replaceAll("a.a", "a", "$&$&", opts)).toEqual({ output: "$&$&.$&$&", count: 2 });
    expect(replaceAll("ab", "b", "$1$'$`", opts)).toEqual({ output: "a$1$'$`", count: 1 });
  });

  it("empty query replaces nothing", () => {
    expect(replaceAll("abc", "", "x", opts)).toEqual({ output: "abc", count: 0 });
  });

  it("replaces CJK text and honours whole word / case", () => {
    expect(replaceAll("猫と猫", "猫", "犬", opts)).toEqual({ output: "犬と犬", count: 2 });
    expect(replaceAll("concat cat Cat", "cat", "dog", word)).toEqual({ output: "concat dog Cat", count: 1 });
  });

  it("the change list applied to the text equals replaceAll (one implementation for CodeMirror and the store)", () => {
    const text = "İstanbul istanbul 日本 cat concat";
    for (const [q, r, o] of [
      ["istanbul", "X", opts],
      ["日本", "にほん", opts],
      ["cat", "$&", word],
    ] as const) {
      const changes = replacementChanges(text, q, r, o);
      expect(applyChanges(text, changes)).toBe(replaceAll(text, q, r, o).output);
      expect(changes.every((c) => c.insert === r)).toBe(true);
    }
  });
});

describe("nextMatch", () => {
  const ms = [
    { from: 2, to: 3 },
    { from: 8, to: 9 },
  ];
  it("moves forward from the caret and wraps", () => {
    expect(nextMatch(ms, 0, "next")).toBe(0);
    expect(nextMatch(ms, 3, "next")).toBe(1);
    expect(nextMatch(ms, 9, "next")).toBe(0);
  });
  it("moves backward from the caret and wraps", () => {
    expect(nextMatch(ms, 8, "prev")).toBe(0);
    expect(nextMatch(ms, 0, "prev")).toBe(1);
  });
  it("returns -1 with no matches", () => {
    expect(nextMatch([], 4, "next")).toBe(-1);
    expect(nextMatch([], 4, "prev")).toBe(-1);
  });
});

describe("findInChunks", () => {
  const chunks = [
    chunk("h", "heading", "猫の話"),
    chunk("img", "image", "猫.png"),
    chunk("d", "diagram", "graph TD; 猫-->犬"),
    chunk("t", "text", "猫と猫"),
  ];

  it("searches text and heading chunks only, in document order", () => {
    expect(findInChunks(chunks, "猫", opts).map((m) => [m.chunkId, m.from, m.to])).toEqual([
      ["h", 0, 1],
      ["t", 0, 1],
      ["t", 2, 3],
    ]);
  });

  it("gives document-wide offsets that nextMatch can order", () => {
    const hits = findInChunks(chunks, "猫", opts);
    // "猫の話" (3) + separator → "t" starts at 4.
    expect(hits.map((m) => m.docFrom)).toEqual([0, 4, 6]);
    expect(chunkDocOffset(chunks, "t", 1)).toBe(5);
    expect(nextMatch(hits.map((h) => ({ from: h.docFrom, to: h.docTo })), chunkDocOffset(chunks, "t", 1), "next")).toBe(2);
    // An image/diagram chunk caret maps to where the next searchable chunk starts.
    expect(chunkDocOffset(chunks, "d", 3)).toBe(4);
    expect(chunkDocOffset(chunks, "missing", 3)).toBe(0);
  });
});

describe("Go to Line", () => {
  const src = "one\ntwo\r\nthree";
  it("returns the start offset of a 1-based line", () => {
    expect(lineStartOffset(src, 1)).toBe(0);
    expect(lineStartOffset(src, 2)).toBe(4);
    expect(lineStartOffset(src, 3)).toBe(9);
  });
  it("clamps to the document range", () => {
    expect(lineStartOffset(src, 0)).toBe(0);
    expect(lineStartOffset(src, -5)).toBe(0);
    expect(lineStartOffset(src, 99)).toBe(9);
    expect(lineStartOffset(src, Number.NaN)).toBe(0);
    expect(lineStartOffset("", 3)).toBe(0);
  });
  it("counts lines", () => {
    expect(lineCount(src)).toBe(3);
    expect(lineCount("")).toBe(1);
  });
});

describe("findSeed — prefill from the current selection", () => {
  it("uses a single-line selection", () => {
    expect(findSeed("日本")).toBe("日本");
    expect(findSeed("")).toBeNull();
    expect(findSeed("a\nb")).toBeNull();
    expect(findSeed("x".repeat(500))).toBeNull();
  });
});

describe("findAvailability — Slides is planned, Editor and Markdown are live", () => {
  it("is available in Editor and Markdown, planned in Slides", () => {
    expect(findAvailability("editor")).toBe("available");
    expect(findAvailability(undefined)).toBe("available");
    expect(findAvailability("markdown")).toBe("available");
    expect(findAvailability("slide")).toBe("planned");
  });
});

describe("ux-a11y-i18n-7 — Go to Line accepts full-width digits", () => {
  it("normalizes full-width digits (NFKC) and drops everything else", () => {
    expect(lineInputDigits("１２")).toBe("12");
    expect(lineInputDigits("12")).toBe("12");
    expect(lineInputDigits("行３a4")).toBe("34");
    expect(lineInputDigits("")).toBe("");
  });
});
