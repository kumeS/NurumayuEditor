// The bottom-right corner holds one panel at a time (review follow-up, QA
// 20261003). The Criteria, Personal library and Citations panels all open at
// `fixed bottom-9 right-2`, painted in DOM order; with two open, the one on
// screen and the one Esc closes (the most recently opened) could differ.
// Each panel's visibility store calls closeOtherCornerPanels before it opens,
// so the panel on screen is the only one open. Guarded by cornerPanels.test.ts.
//
// UI-only state: never persisted, never in the document store or undo history.

const closers = new Map<string, () => void>();

/** Register a corner panel's close action under `name` (at module load). */
export function registerCornerPanel(name: string, close: () => void): void {
  closers.set(name, close);
}

/** Close every registered corner panel except `name`. */
export function closeOtherCornerPanels(name: string): void {
  for (const [other, close] of closers) if (other !== name) close();
}
