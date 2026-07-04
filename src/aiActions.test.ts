import { describe, expect, it } from "vitest";
import { extractJsonObject, parseBulletLines } from "./aiActions";

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
