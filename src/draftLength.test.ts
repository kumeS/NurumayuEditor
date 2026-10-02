import { describe, expect, it } from "vitest";
import {
  DRAFT_TARGETS,
  draftDoneMessage,
  draftLengthOptionLabel,
  draftLengthWarning,
  draftProgressLabel,
  measureDraft,
} from "./draftLength";
import { CJK_CHARS_PER_WORD } from "./textStats";
import type { Chunk } from "./types";

function text(id: string, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: "text", linkedChunks: [] } };
}

describe("BUG-005a — Draft length option labels", () => {
  it("English UI keeps word targets", () => {
    expect(DRAFT_TARGETS.map((w) => draftLengthOptionLabel(w, "en"))).toEqual([
      "Auto",
      "Short (~300 words)",
      "Medium (~800 words)",
      "Long (~1500 words)",
      "Very long (~3000 words)",
    ]);
  });

  it("Japanese UI shows characters derived from CJK_CHARS_PER_WORD, never 語", () => {
    expect(CJK_CHARS_PER_WORD).toBe(2); // the numbers below assume the documented ratio
    expect(DRAFT_TARGETS.map((w) => draftLengthOptionLabel(w, "ja"))).toEqual([
      "自動",
      "短め(約600文字)",
      "標準(約1600文字)",
      "長め(約3000文字)",
      "非常に長い(約6000文字)",
    ]);
  });
});

describe("BUG-005a — measureDraft uses the shared counter and unit rule", () => {
  it("measures English in words against the word target", () => {
    expect(measureDraft([text("a", "one two three four five")], 300)).toEqual({
      unit: "words",
      achieved: 5,
      target: 300,
    });
  });

  it("measures Japanese in characters and converts the word target (CJK)", () => {
    expect(measureDraft([text("a", "日本語の文章です")], 300)).toEqual({
      unit: "characters",
      achieved: 8,
      target: 300 * CJK_CHARS_PER_WORD,
    });
  });

  it("has no target for Auto", () => {
    expect(measureDraft([text("a", "one two")], undefined).target).toBeNull();
  });
});

describe("BUG-005c — progress label", () => {
  it("shows achieved / target in the measured unit", () => {
    expect(draftProgressLabel({ unit: "words", achieved: 5, target: 300 }, "en")).toBe(
      "Drafting… ~5 / ~300 words"
    );
    expect(draftProgressLabel({ unit: "characters", achieved: 8, target: 600 }, "ja")).toBe(
      "下書き中… 8 / 約600文字"
    );
  });

  it("shows only the running length without a target", () => {
    expect(draftProgressLabel({ unit: "words", achieved: 12, target: null }, "en")).toBe(
      "Drafting… ~12 words"
    );
    expect(draftProgressLabel({ unit: "characters", achieved: 40, target: null }, "ja")).toBe(
      "下書き中… 40文字"
    );
  });
});

describe("BUG-005a — post-draft report", () => {
  it("states paragraphs, achieved length and target", () => {
    expect(draftDoneMessage({ unit: "words", achieved: 310, target: 300 }, 4, "en")).toBe(
      "Draft created — 4 paragraphs, ~310 words (target ~300)."
    );
    expect(draftDoneMessage({ unit: "characters", achieved: 4694, target: 6000 }, 47, "ja")).toBe(
      "下書きを作成しました — 47段落・4694文字(目標 約6000文字)。"
    );
    expect(draftDoneMessage({ unit: "words", achieved: 90, target: null }, 3, "en")).toBe(
      "Draft created — 3 paragraphs, ~90 words."
    );
  });

  it("warns (for the persistent report) only outside ±20% of the target", () => {
    expect(draftLengthWarning({ unit: "words", achieved: 360, target: 300 }, "en")).toBeNull();
    expect(draftLengthWarning({ unit: "words", achieved: 240, target: 300 }, "en")).toBeNull();
    expect(draftLengthWarning({ unit: "words", achieved: 90, target: null }, "en")).toBeNull();
    expect(draftLengthWarning({ unit: "words", achieved: 361, target: 300 }, "en")).toBe(
      "The draft is ~361 words, outside ±20% of the ~300-word target."
    );
    // The QA shape: a "~3000 words" Japanese draft that came back as ~4694 characters is
    // UNDER a 6000-character target, and is reported rather than silent.
    expect(draftLengthWarning({ unit: "characters", achieved: 4694, target: 6000 }, "ja")).toBe(
      "下書きは4694文字で、目標(約6000文字)の±20%を外れています。"
    );
  });
});
