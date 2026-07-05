// Pure text-splicing logic for inserting a formatted citation (or bibliography)
// at a cursor position within a paragraph's content (開発.txt Stage 3, item
// 3-2). Kept framework/DOM-free so it can be unit-tested directly (this
// project's vitest config runs in a plain Node environment, no jsdom) — the
// DOM lookup (which textarea is focused, its real selectionStart) lives in
// CitationsPanel.tsx, which calls this pure function with the caret offset it
// already resolved.

/** Result of splicing `insertText` into `content` at `caret`: the new full
 * content, and the caret offset immediately after the inserted text (for
 * repositioning the cursor once the caller writes `content` back). */
export interface SpliceResult {
  content: string;
  caretAfter: number;
}

/**
 * Insert `insertText` into `content` at `caret`, adding a single leading/
 * trailing space when the adjacent character isn't already whitespace — so a
 * citation reads naturally whether it lands mid-sentence, at a paragraph's
 * end, or into empty content, without the caller managing spacing itself.
 *
 * `caret` is clamped to `[0, content.length]` so an out-of-range value (e.g.
 * a stale selection from before an edit) can't produce a garbled split.
 */
export function spliceTextAtCursor(
  content: string,
  caret: number,
  insertText: string
): SpliceResult {
  const clamped = Math.max(0, Math.min(caret, content.length));
  const before = content.slice(0, clamped);
  const after = content.slice(clamped);

  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insert = (needsLeadingSpace ? " " : "") + insertText + (needsTrailingSpace ? " " : "");

  return {
    content: before + insert + after,
    caretAfter: before.length + insert.length,
  };
}
