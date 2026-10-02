// Ghost-text request gate (開発.txt Stage 2, item 2-4; BUG-001a).
//
// Invariant: a completion is requested only after the USER edited the focused
// text chunk since it gained focus. Focus alone — opening a file, switching
// tabs or modes, clicking into a paragraph — never fires a request, because a
// programmatically focused textarea leaves its caret at the end and would
// otherwise satisfy every other precondition with no keystroke.
//
// Pure: no DOM, no store. The caller owns the `editedSinceFocus` flag (set on
// a user edit, reset whenever focus or the chunk id changes).
// Wiring: ChunkView's debounce effect calls this right before each request
// (guarded by chunkViewWiring.test.ts).

import type { ChunkType } from "./types";

export interface GhostRequestInput {
  chunkType: ChunkType;
  isFocused: boolean;
  content: string;
  caretAtEnd: boolean;
  editedSinceFocus: boolean;
  aiReady: boolean;
}

/** True when a ghost-text completion may be requested for this chunk now. */
export function shouldRequestGhost(input: GhostRequestInput): boolean {
  return (
    input.chunkType === "text" &&
    input.isFocused &&
    input.editedSinceFocus &&
    input.caretAtEnd &&
    input.aiReady &&
    input.content.trim().length > 0
  );
}
