import { describe, expect, it } from "vitest";
import { lineAtOffset, offsetForLine, type LineBlock } from "./scrollAnchor";

// A heading, a 4-line paragraph, then a list whose items are nested blocks.
const blocks: LineBlock[] = [
  { start: 1, end: 1, top: 0, height: 40 }, // # title
  { start: 3, end: 6, top: 60, height: 120 }, // paragraph, lines 3–6
  { start: 8, end: 10, top: 200, height: 90 }, // <ul>
  { start: 8, end: 8, top: 200, height: 30 }, //   <li> line 8
  { start: 9, end: 9, top: 230, height: 30 }, //   <li> line 9
  { start: 10, end: 10, top: 260, height: 30 }, //  <li> line 10
  { start: 12, end: 12, top: 320, height: 40 }, // paragraph after the list
];

describe("lineAtOffset — which source line is at the top of the preview", () => {
  it("is null above the first block (the document's top)", () => {
    expect(lineAtOffset(blocks, -5)).toBeNull();
  });
  it("interpolates inside a multi-line block", () => {
    expect(lineAtOffset(blocks, 60)).toBe(3);
    expect(lineAtOffset(blocks, 120)).toBe(5); // halfway through lines 3–6
  });
  it("prefers the nested block (list item) over its parent list", () => {
    expect(lineAtOffset(blocks, 235)).toBeCloseTo(9 + 5 / 30);
  });
  it("in the gap after a block, points just past that block", () => {
    expect(lineAtOffset(blocks, 190)).toBe(7);
  });
});

describe("offsetForLine — where the preview should scroll for a source line", () => {
  it("lands on the block that contains the line, interpolated", () => {
    expect(offsetForLine(blocks, 3)).toBe(60);
    expect(offsetForLine(blocks, 5)).toBe(120);
  });
  it("lands on the list item, not the top of the whole list", () => {
    expect(offsetForLine(blocks, 10)).toBe(260);
  });
  it("a line in a gap (blank line) goes to the end of the block before it", () => {
    expect(offsetForLine(blocks, 7)).toBe(180);
  });
  it("is null before the first block", () => {
    expect(offsetForLine([{ start: 5, end: 5, top: 0, height: 10 }], 2)).toBeNull();
  });
  it("round-trips: preview → line → preview returns to the same place", () => {
    for (const y of [0, 75, 150, 215, 262, 330]) {
      expect(offsetForLine(blocks, lineAtOffset(blocks, y)!)).toBeCloseTo(y);
    }
  });
});
