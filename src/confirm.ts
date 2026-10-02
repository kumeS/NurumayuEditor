// The one "unsaved changes" dialog (BUG-011). Closing a tab (tab X, ⌘W, the
// palette) and quitting all ask through `askUnsaved`, so wording, kind and
// labels cannot drift between paths.
//
// Constraints this module keeps:
// - Three outcomes: Save / Don't Save / Cancel, via plugin-dialog `message()`
//   with yes/no/cancel buttons. The plugin resolves to the clicked button's
//   LABEL, so the outcome is decided by exact label match
//   (`resolveUnsavedChoice`) and anything unrecognised is "cancel".
// - Cancel occupies the `cancel` slot: Linux/Windows return that slot when the
//   dialog is dismissed (Esc / window close), so dismissing never discards.
//   On macOS this lays the buttons out [Cancel][Don't Save][Save] with Save
//   as the Return default — a recorded deviation from ui.md #5's physical
//   separation (docs/ai/03_ui_constitution.md, "Unsaved-changes dialog").
// - A dialog that fails to open counts as Cancel (and is reported): nothing
//   is closed or discarded on an error.

import { message } from "@tauri-apps/plugin-dialog";
import { tNow, tf } from "./i18n";
import { useStore } from "./store";

export type UnsavedChoice = "save" | "discard" | "cancel";

/** The button labels exactly as shown in the dialog. */
export interface UnsavedLabels {
  save: string;
  discard: string;
  cancel: string;
}

/**
 * Map the dialog's result (the clicked label) to an outcome. Only the exact
 * Save / Don't Save labels act; everything else — the Cancel label, a
 * dismissed dialog, the plugin's own 'Yes'/'No'/'Ok'/'Cancel', junk — is
 * "cancel". Colliding Save/Don't Save labels (a broken translation) can never
 * discard. Pure.
 */
export function resolveUnsavedChoice(
  result: string | null | undefined,
  labels: UnsavedLabels
): UnsavedChoice {
  if (typeof result !== "string" || labels.save === labels.discard) return "cancel";
  if (result === labels.save) return "save";
  if (result === labels.discard) return "discard";
  return "cancel";
}

/**
 * Ask whether to save one document's unsaved changes before closing its tab
 * (`scope: "tab"`) or quitting (`scope: "quit"`). `title` names the document;
 * an empty title is shown as Untitled. Callers check dirtiness first.
 */
export async function askUnsaved(scope: "tab" | "quit", title: string): Promise<UnsavedChoice> {
  // Computed once: the same labels are shown and matched, so a language change
  // while the dialog is open can't make a click unrecognisable.
  const labels: UnsavedLabels = {
    save: tNow("Save"),
    discard: tNow("Don't Save"),
    cancel: tNow("Cancel"),
  };
  const name = title.trim() || tNow("Untitled");
  const text =
    scope === "quit"
      ? tf("Do you want to save the changes to “{title}” before quitting?", { title: name })
      : tf("Do you want to save the changes to “{title}” before closing it?", { title: name });
  try {
    const result = await message(text, {
      title: tNow("Unsaved changes"),
      kind: "warning",
      buttons: { yes: labels.save, no: labels.discard, cancel: labels.cancel },
    });
    return resolveUnsavedChoice(result, labels);
  } catch (e) {
    useStore.getState().notify(e instanceof Error ? e.message : String(e), "error");
    return "cancel";
  }
}
