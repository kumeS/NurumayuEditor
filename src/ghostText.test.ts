import { describe, expect, it } from "vitest";
import { shouldRequestGhost, type GhostRequestInput } from "./ghostText";

/** A request that satisfies every precondition; override one field per test. */
function ready(overrides: Partial<GhostRequestInput> = {}): GhostRequestInput {
  return {
    chunkType: "text",
    isFocused: true,
    content: "QA_AIX_TEST_001",
    caretAtEnd: true,
    editedSinceFocus: true,
    aiReady: true,
    ...overrides,
  };
}

describe("BUG-001a — shouldRequestGhost", () => {
  it("does not request a completion on focus alone (no edit since focus)", () => {
    // The G03 shape: a reopened doc focuses its first paragraph, the caret
    // lands at the end programmatically, and nothing was typed.
    expect(shouldRequestGhost(ready({ editedSinceFocus: false }))).toBe(false);
  });

  it("requests once the user has edited since focusing (the feature still works)", () => {
    expect(shouldRequestGhost(ready())).toBe(true);
  });

  it("requests for CJK prose too", () => {
    expect(shouldRequestGhost(ready({ content: "日本語の段落を書いている" }))).toBe(true);
  });

  it("never requests for non-text chunks", () => {
    for (const chunkType of ["heading", "diagram", "image"] as const) {
      expect(shouldRequestGhost(ready({ chunkType }))).toBe(false);
    }
  });

  it("never requests for an unfocused chunk", () => {
    expect(shouldRequestGhost(ready({ isFocused: false }))).toBe(false);
  });

  it("never requests for empty or whitespace-only content (incl. full-width space)", () => {
    expect(shouldRequestGhost(ready({ content: "" }))).toBe(false);
    expect(shouldRequestGhost(ready({ content: "  \n\t" }))).toBe(false);
    expect(shouldRequestGhost(ready({ content: "　" }))).toBe(false);
  });

  it("never requests when the caret is not at the end", () => {
    expect(shouldRequestGhost(ready({ caretAtEnd: false }))).toBe(false);
  });

  it("never requests when AI is not ready (no key / not configured)", () => {
    expect(shouldRequestGhost(ready({ aiReady: false }))).toBe(false);
  });
});
