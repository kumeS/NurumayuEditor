// Grant-application beachhead (開発.txt Stage 2, item 2-1), Part A: pure logic
// for "which paragraphs currently exceed the configured character limit".
// Deliberately generic — this is NOT tied to any specific bundled grant form
// (see docs/ai + 開発.txt §9: which official forms to bundle is an explicitly
// unresolved decision). The limit itself lives in Settings.charLimitWarning;
// this module only computes against it.

import type { Chunk } from "./types";

/**
 * Count "characters" the way a user would expect, CJK-aware: Unicode code
 * points via `Array.from`, not UTF-16 code units via `.length`. Plain
 * `.length` double-counts any character represented as a surrogate pair
 * (astral-plane emoji, some rare CJK Extension B+ ideographs), which would
 * make a paragraph look longer than it visually is. This mirrors the
 * code-point-aware spirit of `diff.ts`'s `Intl.Segmenter`-based tokenizer,
 * without pulling in full grapheme-cluster segmentation (code points are the
 * right unit here — a "character" for a length limit, not a rendered glyph).
 */
export function countCharacters(text: string): number {
  return Array.from(text).length;
}

/** One chunk that exceeds the configured character limit. */
export interface OverLimitChunk {
  id: string;
  count: number;
}

/**
 * Chunks whose content's character count is STRICTLY GREATER than `limit`
 * (a paragraph exactly at the limit passes). Only text/heading chunks are
 * considered — diagrams/images have no comparable "prose length" notion.
 * Returns `[]` when `limit` is undefined/unset (feature off) or not a
 * positive integer, so callers never need to re-check "is this configured".
 */
export function chunksOverCharLimit(
  chunks: Chunk[],
  limit: number | undefined
): OverLimitChunk[] {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return [];
  const out: OverLimitChunk[] = [];
  for (const c of chunks) {
    if (c.metadata.chunkType !== "text" && c.metadata.chunkType !== "heading") continue;
    const count = countCharacters(c.content);
    if (count > limit) out.push({ id: c.id, count });
  }
  return out;
}
