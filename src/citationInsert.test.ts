import { describe, expect, it } from "vitest";
import { spliceTextAtCursor } from "./citationInsert";

describe("spliceTextAtCursor", () => {
  it("inserts mid-sentence with a leading and trailing space when neither side already has one", () => {
    const result = spliceTextAtCursor("This is a claim.", 15, "(Smith, 2020)");
    // caret at index 15 is right before the final period.
    expect(result.content).toBe("This is a claim (Smith, 2020) .");
    // caretAfter lands right after the inserted text INCLUDING its trailing space.
    expect(result.caretAfter).toBe("This is a claim (Smith, 2020) ".length);
  });

  it("does not add a leading space when the preceding character is already whitespace", () => {
    const result = spliceTextAtCursor("This is a claim ", 17, "(Smith, 2020)");
    expect(result.content).toBe("This is a claim (Smith, 2020)");
  });

  it("does not add a trailing space when the following character is already whitespace", () => {
    const result = spliceTextAtCursor("Before  after", 7, "(X, 2020)");
    // "Before " + " after" split at index 7 (right after the first space).
    expect(result.content).toBe("Before (X, 2020) after");
  });

  it("appends cleanly at the end of the content with only a leading space", () => {
    const result = spliceTextAtCursor("A sentence", 10, "(Doe, 2019)");
    expect(result.content).toBe("A sentence (Doe, 2019)");
    expect(result.caretAfter).toBe(result.content.length);
  });

  it("inserts into empty content with no surrounding spaces", () => {
    const result = spliceTextAtCursor("", 0, "(Doe, 2019)");
    expect(result.content).toBe("(Doe, 2019)");
    expect(result.caretAfter).toBe("(Doe, 2019)".length);
  });

  it("clamps an out-of-range caret to the end of the content instead of throwing or corrupting text", () => {
    const result = spliceTextAtCursor("short", 999, "(X)");
    expect(result.content).toBe("short (X)");
  });

  it("clamps a negative caret to the start of the content", () => {
    const result = spliceTextAtCursor("text", -5, "(X)");
    expect(result.content).toBe("(X) text");
  });

  it("splices correctly at the exact midpoint of CJK content, adding spaces around the citation (neither side is whitespace)", () => {
    const result = spliceTextAtCursor("これは重要です", 3, "(佐藤, 2020)");
    expect(result.content).toBe("これは (佐藤, 2020) 重要です");
    expect(result.caretAfter).toBe("これは (佐藤, 2020) ".length);
  });
});
