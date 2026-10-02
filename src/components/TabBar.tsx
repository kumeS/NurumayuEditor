// Tab strip for managing multiple open documents at once. The active tab's
// state lives in the store's top-level fields; inactive tabs are snapshots.
//
// "+" adds a new tab immediately; a tab's Editor/Slides mode is switched from the
// toolbar's view toggle (both are the same chunks, presented differently). A
// small icon on each tab shows its current mode, and an amber dot (with a
// screen-reader label) marks unsaved changes.
//
// Every tab, including the last one, has an always-visible close button
// (BUG-018). Closing
// goes through fileActions.requestCloseTab — the same path as ⌘W and the
// palette — which asks Save / Don't Save / Cancel for unsaved work and
// replaces a closed last tab with a fresh untitled one.

import { requestCloseTab } from "../fileActions";
import { useStore } from "../store";
import { useT } from "../i18n";
import type { DocMode } from "../types";
import { CloseIcon, FileIcon, PlusIcon, SlidesIcon } from "./icons";

function ModeIcon({ mode }: { mode: DocMode }) {
  return mode === "slide" ? (
    <SlidesIcon className="h-3.5 w-3.5 shrink-0 text-accent/80" />
  ) : mode === "markdown" ? (
    <span aria-hidden="true" className="shrink-0 font-mono text-[9px] font-semibold text-accent">
      MD
    </span>
  ) : (
    <FileIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
  );
}

export default function TabBar() {
  const tabOrder = useStore((s) => s.tabOrder);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTitle = useStore((s) => s.doc.title);
  const activeDirty = useStore((s) => s.dirty);
  const activeMode = useStore((s) => s.doc.mode ?? "editor");
  const inactiveTabs = useStore((s) => s.inactiveTabs);
  const switchTab = useStore((s) => s.switchTab);
  const newTab = useStore((s) => s.newTab);
  const t = useT();

  const titleOf = (id: string) =>
    (id === activeTabId ? activeTitle : inactiveTabs[id]?.doc.title) || t("Untitled");
  const dirtyOf = (id: string) =>
    id === activeTabId ? activeDirty : !!inactiveTabs[id]?.dirty;
  const modeOf = (id: string): DocMode =>
    (id === activeTabId ? activeMode : inactiveTabs[id]?.doc.mode ?? "editor") as DocMode;

  const onClose = async (id: string) => {
    await requestCloseTab(id);
  };

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-chrome-line bg-chrome/80 px-2 py-1">
      {tabOrder.map((id) => {
        const isActive = id === activeTabId;
        return (
          <div
            key={id}
            className={`flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
              isActive ? "bg-white text-ink shadow-sm" : "text-ink-faint hover:bg-white/70"
            }`}
          >
            <button
              onClick={() => switchTab(id)}
              aria-current={isActive ? "page" : undefined}
              className="flex items-center gap-1.5 truncate rounded outline-none focus-visible:ring-1 focus-visible:ring-accent"
              title={`${titleOf(id)} — ${
                modeOf(id) === "slide"
                  ? t("Slides")
                  : modeOf(id) === "markdown"
                    ? t("Markdown")
                    : t("Editor")
              }`}
            >
              <ModeIcon mode={modeOf(id)} />
              <span className="truncate">{titleOf(id)}</span>
              {/* Outside the truncating title so a long name cannot clip it. */}
              {dirtyOf(id) && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-dot">
                  <span className="sr-only">{t("Unsaved changes")}</span>
                </span>
              )}
            </button>
            <button
              onClick={() => void onClose(id)}
              className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-chrome-line hover:text-ink"
              aria-label={t("Close tab")}
              title={t("Close tab")}
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      {/* New tab — added immediately; switch its Editor/Slides view from the toolbar. */}
      <button
        onClick={() => newTab("editor")}
        className="shrink-0 rounded-md p-1 text-ink-faint hover:bg-white hover:text-ink"
        title={t("New tab")}
        aria-label={t("New tab")}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
