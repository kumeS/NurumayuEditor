// Global keyboard shortcuts (Phase 5). Per-chunk shortcuts (AI run, split,
// merge) live in ChunkView; these are the document-level ones.

import { useEffect } from "react";
import { confirmDiscard } from "./confirm";
import { saveNative, openNative } from "./fileActions";
import { useStore } from "./store";

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === "s") {
        e.preventDefault();
        void saveNative();
      } else if (key === "o") {
        e.preventDefault();
        void openNative();
      } else if (key === "t") {
        e.preventDefault();
        useStore.getState().newTab();
      } else if (key === "k") {
        // Command palette (提案1).
        e.preventDefault();
        useStore.getState().togglePalette();
      } else if (key === "w") {
        // Close the active tab, honouring the shared unsaved-changes dialog
        // (item 18). The store refuses to close the last tab.
        e.preventDefault();
        void (async () => {
          const s = useStore.getState();
          if (s.tabOrder.length <= 1) return;
          if (s.dirty && !(await confirmDiscard("tab"))) return;
          useStore.getState().closeTab(s.activeTabId);
        })();
      } else if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        useStore.getState().redo();
      } else if (key === ",") {
        e.preventDefault();
        useStore.getState().openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
