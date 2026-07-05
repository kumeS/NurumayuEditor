// Top-level layout: toolbar over a scrollable editor, with an optional
// relationship network panel docked on the right.

import { Suspense, lazy, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { advanceSpeechQueue, analyzeDocument } from "./aiActions";
import { confirmDiscard } from "./confirm";
import {
  exportDocument,
  exportPdf,
  exportPptx,
  importDocument,
  openNative,
  saveNative,
  saveNativeAs,
} from "./fileActions";
import { useStore } from "./store";
import type { PersistedTab, SessionData } from "./types";
import { useShortcuts } from "./useShortcuts";
import CommandPalette from "./components/CommandPalette";
import DraftModal from "./components/DraftModal";
import Editor from "./components/Editor";
import HealthBar from "./components/HealthBar";
import ErrorBoundary from "./components/ErrorBoundary";
import SlideEditor from "./components/SlideEditor";
import HelpModal from "./components/HelpModal";
import PresentationMode from "./components/PresentationMode";
import SelectionBar from "./components/SelectionBar";
import SettingsModal from "./components/SettingsModal";
import TabBar from "./components/TabBar";
import Toolbar from "./components/Toolbar";
import Toasts from "./components/Toasts";
import { PromptHost } from "./components/PromptModal";

// Cytoscape is heavy; load the network panel only when it is first opened.
const NetworkPanel = lazy(() => import("./components/NetworkPanel"));
// Review comments panel — same load-on-first-open pattern.
const ReviewPanel = lazy(() => import("./components/ReviewPanel"));

/** True if any tab (active or backgrounded) has unsaved changes. */
function anyTabDirty(): boolean {
  const st = useStore.getState();
  return st.dirty || Object.values(st.inactiveTabs).some((t) => t.dirty);
}

/** Snapshot every tab (active + backgrounded) for the autosave/recovery file (A2). */
function collectSession(): SessionData {
  const st = useStore.getState();
  const tabs: PersistedTab[] = st.tabOrder
    .map((id): PersistedTab | null => {
      if (id === st.activeTabId) {
        return { id, doc: st.doc, filePath: st.filePath, dirty: st.dirty };
      }
      const snap = st.inactiveTabs[id];
      return snap
        ? { id, doc: snap.doc, filePath: snap.filePath, dirty: snap.dirty }
        : null;
    })
    .filter((t): t is PersistedTab => t !== null);
  return { tabs, activeTabId: st.activeTabId, savedAt: Date.now() };
}

/**
 * Ask before discarding unsaved work. Returns true if it is safe to close
 * (nothing dirty, or the user confirmed). Used by both the window-close path
 * and the app Quit menu so neither can silently lose unsaved tabs (B1).
 */
async function okToClose(): Promise<boolean> {
  if (!anyTabDirty()) return true;
  return confirmDiscard("quit");
}

function App() {
  const networkOpen = useStore((s) => s.networkOpen);
  const reviewPanelOpen = useStore((s) => s.reviewPanelOpen);
  const presentationOpen = useStore((s) => s.presentationOpen);
  const mode = useStore((s) => s.doc.mode ?? "editor");
  const activeTabId = useStore((s) => s.activeTabId);
  const setSettings = useStore((s) => s.setSettings);
  const setHasApiKey = useStore((s) => s.setHasApiKey);
  const notify = useStore((s) => s.notify);

  useShortcuts();

  // Native menu → dispatch to the same handlers as the in-app toolbar.
  useEffect(() => {
    const unlisten = listen<string>("menu", async (e) => {
      const st = useStore.getState();
      switch (e.payload) {
        case "new_tab":
          st.newTab();
          break;
        case "open":
          void openNative();
          break;
        case "save":
          void saveNative();
          break;
        case "save_as":
          void saveNativeAs();
          break;
        case "import":
          void importDocument();
          break;
        case "export_txt":
          void exportDocument("txt");
          break;
        case "export_md":
          void exportDocument("md");
          break;
        case "export_rtf":
          void exportDocument("rtf");
          break;
        case "export_pptx":
          void exportPptx();
          break;
        case "export_pdf":
          void exportPdf();
          break;
        case "undo":
          st.undo();
          break;
        case "redo":
          st.redo();
          break;
        case "settings":
          st.openSettings();
          break;
        case "analyze":
          void analyzeDocument();
          break;
        case "draft":
          st.openDraft();
          break;
        case "help":
          st.openHelp();
          break;
        case "quit":
          if (await okToClose()) {
            await api.clearSession().catch(() => {});
            await api.quitApp();
          }
          break;
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // UI3: clear the read-aloud indicator when the OS speech process finishes,
  // matched by utterance id so a stale event can't clear a newer playback.
  useEffect(() => {
    const unlisten = listen<number>("speech-done", (e) => {
      // Multi-chunk read-aloud (item 14): the backend speaks one utterance at a
      // time, so the queue may only advance once the previous one reported done.
      // A KILLED utterance also emits speech-done (its wait-thread sees the exit)
      // — only the CURRENT utterance's completion may advance, or a superseded
      // read would cut off its replacement.
      const wasCurrent = useStore.getState().speakingUtterance === e.payload;
      useStore.getState().endSpeaking(e.payload);
      if (wasCurrent) void advanceSpeechQueue();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Window close (macOS) is owned natively in lib.rs: it hides the window and
  // keeps the app running, re-showing it from the Dock. The unsaved-changes
  // guard lives on the real Quit path (Cmd+Q → api.quitApp) instead, since
  // hiding can't lose data.

  // A2: restore the previous session if it had unsaved work, and autosave the
  // working set (debounced) so a crash/force-quit can't lose tabs — including
  // irreproducible AI drafts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sess = await api.loadSession();
        if (cancelled || !sess?.tabs?.length) return;
        if (sess.tabs.some((t) => t.dirty)) {
          const restore = await ask(
            "Restore unsaved documents from your last session?",
            {
              title: "Restore session",
              kind: "info",
              okLabel: "Restore",
              cancelLabel: "Discard",
            }
          );
          if (cancelled) return;
          if (restore) useStore.getState().hydrateSession(sess.tabs, sess.activeTabId);
          else await api.clearSession().catch(() => {});
        } else {
          await api.clearSession().catch(() => {});
        }
      } catch {
        /* no recoverable session */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useStore.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (anyTabDirty()) void api.saveSession(collectSession()).catch(() => {});
      }, 1500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, []);

  // Load persisted settings + key status on startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, hasKey] = await Promise.all([
          api.getSettings(),
          api.hasApiKey(),
        ]);
        if (cancelled) return;
        setSettings(settings);
        setHasApiKey(hasKey);
        if (!hasKey) {
          notify(
            "Add your OpenRouter API key in Settings to enable AI features.",
            "info"
          );
        }
      } catch (e) {
        if (!cancelled) notify(typeof e === "string" ? e : String(e), "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSettings, setHasApiKey, notify]);

  return (
    <div className="flex h-full flex-col bg-white text-ink">
      <TabBar />
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Reset the boundary when the tab or view mode changes, so a crash in
              one view doesn't trap the user — they can switch away and back. The
              fade-in (keyed the same way) softens the hard remount on a mode
              switch without being a real transition between two live views. */}
          <div key={`${activeTabId}:${mode}`} className="view-fade-in h-full">
            <ErrorBoundary>{mode === "slide" ? <SlideEditor /> : <Editor />}</ErrorBoundary>
          </div>
        </main>
        {networkOpen && (
          <Suspense
            fallback={
              <aside className="flex h-full w-80 shrink-0 items-center justify-center border-l border-gray-200 bg-white text-sm text-ink-faint">
                Loading graph…
              </aside>
            }
          >
            <NetworkPanel />
          </Suspense>
        )}
        {reviewPanelOpen && (
          <Suspense
            fallback={
              <aside className="flex h-full w-80 shrink-0 items-center justify-center border-l border-gray-200 bg-white text-sm text-ink-faint">
                Loading review…
              </aside>
            }
          >
            <ReviewPanel />
          </Suspense>
        )}
      </div>
      {/* Item 1-3: the presentation overlay is a separate, ephemeral, UI-only
          state (NOT a third doc.mode value) — mounted as a SIBLING of the main
          content, not nested in the mode ternary above, so it can open over
          either Edit or Preview and survives whichever sub-view was active.
          Keyed by view+tab like the main ErrorBoundary above, so a crash here
          resets on tab switch instead of trapping the user in a blank overlay. */}
      {presentationOpen && (
        <ErrorBoundary key={`presentation:${activeTabId}`}>
          <PresentationMode />
        </ErrorBoundary>
      )}
      <HealthBar />

      <SettingsModal />
      <DraftModal />
      <HelpModal />
      <CommandPalette />
      <PromptHost />
      <SelectionBar />
      <Toasts />
    </div>
  );
}

export default App;
