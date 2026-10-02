// Left-docked folder tree sidebar: a general-purpose file explorer (not
// Markdown-only, not per-mode), replacing the old Markdown-only Miller-column
// DirectoryBrowser that used to live inside MarkdownEditor.tsx. Listing stays
// in Rust (root-jailed, capped, dotfile-excluded — see fileio::list_directory);
// this component only renders what it's given and lazily fetches on expand.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { openFolder, openPath } from "../fileActions";
import { folderDisplayName, folderToFollow } from "../folderTree";
import { useT } from "../i18n";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  saveSidebarWidth,
  sidebarWidthOf,
} from "../sidebarWidth";
import { useStore } from "../store";
import type { DirectoryEntry } from "../types";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type LoadState = {
  entries: DirectoryEntry[] | null; // null = not yet fetched
  loading: boolean;
  error: string | null;
};

const INITIAL: LoadState = { entries: null, loading: false, error: null };

function EntryRow({
  root,
  entry,
  depth,
}: {
  root: string;
  entry: DirectoryEntry;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<LoadState>(INITIAL);
  const t = useT();
  const indent = 10 + depth * 14;
  const isActive = useStore((s) => s.filePath === entry.path);

  const load = useCallback(async () => {
    setState({ entries: null, loading: true, error: null });
    try {
      const entries = await api.listDirectory(root, entry.path);
      setState({ entries, loading: false, error: null });
    } catch (e) {
      setState({ entries: null, loading: false, error: message(e) });
    }
  }, [root, entry.path]);

  if (!entry.isDirectory) {
    return (
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        disabled={!entry.isOpenable}
        onClick={() => void openPath(entry.path)}
        title={entry.isOpenable ? entry.path : `${entry.name}: ${t("unsupported file type")}`}
        aria-label={
          entry.isOpenable
            ? `${t("Open")} ${entry.name}`
            : `${entry.name}, ${t("unsupported file type")}`
        }
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-accent/5 hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent ${
          isActive ? "bg-accent/10 font-medium text-ink" : "text-ink-soft"
        }`}
        style={{ paddingLeft: indent }}
      >
        <span aria-hidden="true" className="text-ink-faint">·</span>
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && state.entries === null && !state.loading) void load();
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? t("Collapse") : t("Expand")} ${t("folder")} ${entry.name}`}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm text-ink hover:bg-accent/5"
        style={{ paddingLeft: indent }}
      >
        <span aria-hidden="true" className="text-ink-faint">{expanded ? "▾" : "▸"}</span>
        <span className="truncate">{entry.name}</span>
      </button>
      {expanded && (
        <div>
          {state.loading && (
            <div className="py-1 text-xs text-ink-faint" style={{ paddingLeft: indent + 14 }}>
              {t("Loading…")}
            </div>
          )}
          {state.error && (
            <div role="alert" className="py-1 pr-2 text-xs text-ink-soft" style={{ paddingLeft: indent + 14 }}>
              {t("Couldn't read this folder:")} {state.error}
            </div>
          )}
          {state.entries?.length === 0 && (
            <div className="py-1 text-xs text-ink-faint" style={{ paddingLeft: indent + 14 }}>
              {t("Empty folder.")}
            </div>
          )}
          {state.entries?.map((child) => (
            <EntryRow key={child.path} root={root} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's right edge: drag to resize (live), release to persist.
 * Keyboard: ←/→ step, Home/End to the bounds; double-click restores the default.
 */
function ResizeHandle({ width, onLive }: { width: number; onLive: (w: number | null) => void }) {
  const t = useT();
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const finish = (w: number) => {
    onLive(null);
    void saveSidebarWidth(w);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Resize the files sidebar")}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title={t("Drag to resize · double-click to reset")}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width, last: width };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampSidebarWidth(d.startWidth + e.clientX - d.startX, window.innerWidth);
        onLive(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        finish(d.last);
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onLive(null);
      }}
      onDoubleClick={() => finish(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowLeft" ? width - SIDEBAR_WIDTH_STEP
          : e.key === "ArrowRight" ? width + SIDEBAR_WIDTH_STEP
          : e.key === "Home" ? SIDEBAR_WIDTH_MIN
          : e.key === "End" ? SIDEBAR_WIDTH_MAX
          : null;
        if (next === null) return;
        e.preventDefault();
        finish(clampSidebarWidth(next, window.innerWidth));
      }}
    >
      {/* The visible line sits on the border; it highlights on hover, drag and focus. */}
      <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40 group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}

export default function FolderTree() {
  const root = useStore((s) => s.folderRoot);
  const activeFile = useStore((s) => s.filePath);
  const setFolderRoot = useStore((s) => s.setFolderRoot);
  const toggleFolderTree = useStore((s) => s.toggleFolderTree);
  const savedWidth = useStore((s) => sidebarWidthOf(s.settings));
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const width = liveWidth ?? savedWidth;
  const [state, setState] = useState<LoadState>(INITIAL);
  const t = useT();

  const loadRoot = useCallback(async (path: string) => {
    setState({ entries: null, loading: true, error: null });
    try {
      const entries = await api.listDirectory(path, path);
      setState({ entries, loading: false, error: null });
    } catch (e) {
      setState({ entries: null, loading: false, error: message(e) });
    }
  }, []);

  // Follow the open file: show its folder unless it's already inside the tree.
  // Keyed on the file only, so choosing another folder isn't undone.
  useEffect(() => {
    const next = folderToFollow(useStore.getState().folderRoot, activeFile);
    if (next) setFolderRoot(next);
  }, [activeFile, setFolderRoot]);

  useEffect(() => {
    if (root) void loadRoot(root);
    else setState(INITIAL);
  }, [root, loadRoot]);

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-gray-200 bg-white font-sans"
      style={{ width }}
      aria-label={t("Folder tree")}
    >
      <ResizeHandle width={width} onLive={setLiveWidth} />
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-2.5">
        <div className="truncate text-xs font-semibold text-ink" title={root ?? undefined}>
          {root ? folderDisplayName(root) : t("Files")}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {root && (
            <button
              type="button"
              onClick={() => void openFolder()}
              title={t("Choose a different folder")}
              className="text-xs text-ink-faint hover:text-ink"
            >
              {t("Change…")}
            </button>
          )}
          {/* The section carries its own hide control, so the sidebar can be
              dismissed from where the user is looking; the toolbar's Files
              button brings it back. */}
          <button
            type="button"
            onClick={() => toggleFolderTree(false)}
            title={t("Hide the files sidebar")}
            aria-label={t("Hide the files sidebar")}
            className="text-xs text-ink-faint hover:text-ink"
          >
            {t("Hide")}
          </button>
        </div>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        {!root ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
            <div className="text-xs text-ink-faint">{t("Open a file or folder to browse its files.")}</div>
            <button
              type="button"
              onClick={() => void openFolder()}
              className="rounded border border-ink-faint/30 px-2.5 py-1 text-xs text-ink-soft hover:bg-accent/5"
            >
              {t("Choose Folder…")}
            </button>
          </div>
        ) : (
          <>
            {state.loading && <div className="px-3 py-4 text-xs text-ink-faint">{t("Loading…")}</div>}
            {state.error && (
              <div role="alert" className="px-3 py-2 text-xs text-ink-soft">
                {t("Couldn't read this folder:")} {state.error}
              </div>
            )}
            {state.entries?.length === 0 && (
              <div className="px-3 py-4 text-xs text-ink-faint">{t("Empty folder.")}</div>
            )}
            {state.entries?.map((entry) => (
              <EntryRow key={entry.path} root={root} entry={entry} depth={0} />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
