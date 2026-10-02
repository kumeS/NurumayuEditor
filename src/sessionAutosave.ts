// Crash-recovery autosave decision (state-async-6). Pure.
//
// Invariant: the session file reflects unsaved work. While any tab is dirty
// the debounced subscriber writes it; once no tab is dirty — including when
// undo/redo brought every tab back to its saved state (MISS-12), which no
// save path observes — a session this subscriber wrote is cleared, so a later
// crash never offers to "restore" edits the user deliberately undid.
// `written` tracks whether this subscriber has a session on disk, so a clean
// app does not send clear_session on every idle store change. Session calls
// are serialized by api.ts's session queue.

export interface AutosaveState {
  anyDirty: boolean;
  written: boolean;
}

export function autosaveStep(s: AutosaveState): { action: "save" | "clear" | null; written: boolean } {
  if (s.anyDirty) return { action: "save", written: true };
  if (s.written) return { action: "clear", written: false };
  return { action: null, written: false };
}
