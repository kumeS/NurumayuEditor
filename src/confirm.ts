// Shared "discard unsaved changes?" confirmation (item 18). Quit and tab-close
// previously carried two separately-worded dialogs (App.okToClose via ask(),
// TabBar via confirm()) — one of them was bound to drift when the other was
// edited. Both now funnel through this helper so wording, kind and labels stay
// consistent.

import { ask } from "@tauri-apps/plugin-dialog";
import { tNow } from "./i18n";

const MESSAGES = {
  quit: {
    message:
      "You have unsaved changes in one or more tabs. Quit without saving? Unsaved documents (including AI drafts) will be lost.",
    okLabel: "Discard & quit",
  },
  tab: {
    message:
      "This tab has unsaved changes. Close it without saving? Its unsaved content will be lost.",
    okLabel: "Discard & close",
  },
} as const;

/**
 * Ask before discarding unsaved work. Returns true when it is safe to proceed
 * (the user explicitly chose to discard). Callers are responsible for checking
 * whether anything is actually dirty first.
 */
export async function confirmDiscard(scope: "tab" | "quit"): Promise<boolean> {
  const { message, okLabel } = MESSAGES[scope];
  return ask(tNow(message), {
    title: tNow("Unsaved changes"),
    kind: "warning",
    okLabel: tNow(okLabel),
    cancelLabel: tNow("Cancel"),
  });
}
