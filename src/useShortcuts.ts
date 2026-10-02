// Global keyboard shortcuts (Phase 5). Per-chunk shortcuts (AI run, split,
// merge) live in ChunkView; these are the document-level ones.
//
// Which chord means what — including the modal guard (under a dialog only a
// field's own undo and ⌘K-to-close-the-palette act), ⇧⌘S = Save As, ⌘Z in
// plain fields = that field's undo, leaving ⌘Z to CodeMirror, and the find
// chords (⌘F / ⌥⌘F / ⌘G / ⇧⌘G / ⌘L) — is decided
// by the pure `resolveShortcut` (shortcuts.ts). This hook only classifies the
// event and runs the action.

import { useEffect } from "react";
import { openFolder, openNative, requestCloseTab, saveNative, saveNativeAs } from "./fileActions";
import { topmostModal } from "./modalBehavior";
import {
  flushesPendingEditBeforeHistory,
  resolveShortcut,
  shortcutTargetKind,
  swallowedUnderModal,
  swallowedWhilePresenting,
} from "./shortcuts";
import { useStore } from "./store";
import { useModalStack } from "./components/Modal";
import { findStep, openFindBar } from "./components/FindBar";

/**
 * Commit a Markdown Preview block's typed-but-uncommitted text (it commits on
 * blur) so the store undo/redo that follows acts on it instead of remounting
 * the block and silently dropping it.
 */
function flushPendingEdit(target: EventTarget | null) {
  if (flushesPendingEditBeforeHistory(target)) (target as HTMLElement).blur();
}

/** macOS: find chords need ⌘ (Ctrl+F / Ctrl+L are text-editing keys there). */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctx = {
        topModal: topmostModal(useModalStack.getState().stack),
        targetKind: shortcutTargetKind(e.target),
        mac: IS_MAC,
        presenting: useStore.getState().presentationOpen,
        findReplacePending: useStore.getState().find.replacePending,
      };
      const id = resolveShortcut(e, ctx);
      if (!id) {
        // Blocked by an open dialog or the presentation: still keep it from
        // the native menu.
        if (swallowedUnderModal(e, ctx)) e.preventDefault();
        if (swallowedWhilePresenting(e, ctx)) e.preventDefault();
        return;
      }
      e.preventDefault();
      switch (id) {
        case "save":
          void saveNative();
          break;
        case "save-as":
          void saveNativeAs();
          break;
        case "open-folder":
          void openFolder();
          break;
        case "open":
          void openNative();
          break;
        case "new-tab":
          useStore.getState().newTab();
          break;
        case "palette":
          // Command palette (提案1).
          useStore.getState().togglePalette();
          break;
        case "close-tab":
          // Close the active tab through the shared close path (Save / Don't
          // Save / Cancel for unsaved work). The last tab closes too: it is
          // replaced by a fresh untitled tab (BUG-018).
          void requestCloseTab(useStore.getState().activeTabId);
          break;
        case "undo":
          flushPendingEdit(e.target);
          useStore.getState().undo();
          break;
        case "redo":
          flushPendingEdit(e.target);
          useStore.getState().redo();
          break;
        case "field-undo":
          // The native Edit menu has no ⌘Z key equivalent, so WebKit won't
          // undo a plain field by itself; run the field's own undo explicitly.
          document.execCommand("undo");
          break;
        case "field-redo":
          document.execCommand("redo");
          break;
        case "settings":
          useStore.getState().openSettings();
          break;
        // Find (BUG-010): the docked find bar.
        case "find":
          openFindBar("find");
          break;
        case "find-replace":
          openFindBar("replace");
          break;
        case "find-next":
          findStep("next");
          break;
        case "find-previous":
          findStep("prev");
          break;
        case "go-to-line":
          openFindBar("line");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
