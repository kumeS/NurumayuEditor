// Keep the reading position when switching the Markdown view between Preview,
// Split and Edit. Both surfaces are described in one currency — the source
// line at the top of the viewport (fractional inside a block) — so each side
// only has to convert its own layout to and from lines. Pure: callers measure
// the DOM / CodeMirror and pass plain numbers in.

/** A rendered block and the source lines it came from (1-based, inclusive). */
export interface LineBlock {
  start: number;
  end: number;
  /** Offset from the top of the scrolled content, in the same units as `y`. */
  top: number;
  height: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The source line shown at content offset `y`. `blocks` are in document order,
 * so a nested block (list item, table row) that starts above `y` wins over its
 * parent. Inside a block the line is interpolated by how far `y` is into it.
 * Null when `y` is above every block (the very top of the document).
 */
export function lineAtOffset(blocks: LineBlock[], y: number): number | null {
  let hit: LineBlock | null = null;
  for (const b of blocks) if (b.top <= y) hit = b;
  if (!hit) return null;
  const span = hit.end - hit.start + 1;
  const into = hit.height > 0 ? clamp01((y - hit.top) / hit.height) : 0;
  return hit.start + into * span;
}

/**
 * The content offset at which source line `line` (fractional) is shown: the
 * last block, in document order, starting at or before it — interpolated
 * inside that block. Null when the line is before every block.
 */
export function offsetForLine(blocks: LineBlock[], line: number): number | null {
  let hit: LineBlock | null = null;
  for (const b of blocks) if (b.start <= line) hit = b;
  if (!hit) return null;
  const span = hit.end - hit.start + 1;
  return hit.top + clamp01((line - hit.start) / span) * hit.height;
}
