// Personal RAG (開発.txt Stage 3, item 3-1) management panel: add/list/remove
// source files in the user's local, on-device knowledge base, and run a
// manual search/preview against it. Everything here calls the `rag_*` Tauri
// commands (src-tauri/src/commands.rs → rag.rs) — embedding, indexing, and
// search all happen locally; the only network traffic this feature EVER
// causes is the one-time embedding-model download on first add/search after
// the user enables it in Settings.
//
// Mount point: opened via the command palette (and Settings' "personal
// library panel" link); rendered unconditionally, self-hiding, from
// HealthBar.tsx — the SAME pattern CriteriaPanel.tsx already uses for exactly
// this reason (a fixed-position, self-hiding panel keeps this feature's
// changes confined to its own owned files instead of touching the shared
// App.tsx docked-panel layout). It owns its own open/closed state via the
// tiny store below, just like CriteriaPanel's.
//
// NOTE for the next integration step: mounting `<PersonalLibraryPanel />`
// once (e.g. alongside `<CriteriaPanel />` in HealthBar.tsx) is required for
// this panel to ever be visible — HealthBar.tsx is outside this feature's
// owned-files list, so that one-line mount is left for whoever next touches
// HealthBar.tsx (see this task's final report).

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { api } from "../api";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { RagSearchHit, RagSourceInfo } from "../types";
import { CloseIcon, FolderIcon, PlusIcon, SpinnerIcon, TrashIcon } from "./icons";

interface PersonalLibraryPanelStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Standalone panel-visibility store — see the module doc comment above. */
export const usePersonalLibraryPanelStore = create<PersonalLibraryPanelStore>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
  })
);

/** Imperative helper for callers outside React (CommandPalette, Settings). */
export function openPersonalLibraryPanel(): void {
  usePersonalLibraryPanelStore.getState().setOpen(true);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export default function PersonalLibraryPanel() {
  const t = useT();
  const open_ = usePersonalLibraryPanelStore((s) => s.open);
  const setOpen = usePersonalLibraryPanelStore((s) => s.setOpen);
  const settings = useStore((s) => s.settings);
  const enabled = settings?.personalRagEnabled ?? false;

  const [sources, setSources] = useState<RagSourceInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<RagSearchHit[] | null>(null);

  const refresh = async () => {
    if (!enabled) {
      setSources([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSources(await api.ragListSources());
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open_) {
      setError(null);
      setResults(null);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open_, enabled]);

  if (!open_) return null;

  const addSource = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Reference", extensions: ["txt", "md", "markdown", "rtf", "pdf"] },
        ],
      });
      if (typeof selected !== "string") return;
      setAdding(true);
      setError(null);
      const count = await api.ragAddSource(selected);
      if (count === 0) {
        useStore
          .getState()
          .notify(`No extractable text found in ${fileName(selected)}.`, "info");
      } else {
        useStore
          .getState()
          .notify(`Added ${fileName(selected)} (${count} passage${count === 1 ? "" : "s"}).`, "success");
      }
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setAdding(false);
    }
  };

  const removeSource = async (path: string) => {
    setRemovingPath(path);
    setError(null);
    try {
      await api.ragRemoveSource(path);
      useStore.getState().notify(`Removed ${fileName(path)} from the personal library.`, "success");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setRemovingPath(null);
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.ragSearch(q, 5));
    } catch (e) {
      setError(message(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="fixed bottom-9 right-2 z-40 w-96 rounded-lg border border-gray-200 bg-white p-3 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <FolderIcon className="h-4 w-4" />
          {t("Personal library")}
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink"
          aria-label={t("Close personal library panel")}
          title={t("Close")}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-2 text-xs text-ink-faint">
        Add your own past papers/notes so AI actions can optionally ground
        writing in them — fully on-device (embedding, indexing, and search all
        run locally; only a one-time embedding-model download touches the
        network).
      </p>

      {/* Off state: the setting itself is disabled — this is a distinct state
          from "enabled but empty", so the user knows exactly what to do. */}
      {!enabled && (
        <div className="rounded-md bg-amber-50/60 px-2 py-3 text-center text-xs text-amber-700">
          Personal RAG is off. Turn on "Personal knowledge base" in Settings to
          add files here.
        </div>
      )}

      {enabled && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-faint">
              {sources === null
                ? ""
                : `${sources.length} source${sources.length === 1 ? "" : "s"} indexed`}
            </span>
            <button
              onClick={() => void addSource()}
              disabled={adding}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-soft disabled:opacity-50"
            >
              {adding ? <SpinnerIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
              {t("Add file…")}
            </button>
          </div>

          {/* Loading state. */}
          {loading && (
            <p className="mt-3 text-center text-xs text-ink-faint">{t("Loading your library…")}</p>
          )}

          {/* Error state — persistent, not just a toast. */}
          {error && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {/* Empty state: enabled, loaded, but nothing indexed yet. */}
          {!loading && sources !== null && sources.length === 0 && !error && (
            <p className="mt-3 rounded-md bg-gray-50/60 px-2 py-3 text-center text-xs text-ink-faint">
              {t("Nothing indexed yet. Add a .txt/.md/.rtf/.pdf file above.")}
            </p>
          )}

          {/* Source list. */}
          {!loading && sources !== null && sources.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
              {sources.map((s) => (
                <li
                  key={s.path}
                  className="flex items-center justify-between gap-2 rounded-md border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-xs"
                >
                  <span className="truncate text-ink" title={s.path}>
                    {fileName(s.path)}
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-faint">
                    {s.passageCount} passage{s.passageCount === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => void removeSource(s.path)}
                    disabled={removingPath === s.path}
                    className="shrink-0 text-ink-faint hover:text-red-600 disabled:opacity-50"
                    aria-label={`Remove ${fileName(s.path)} from the personal library`}
                    title={t("Remove from library")}
                  >
                    {removingPath === s.path ? (
                      <SpinnerIcon className="h-3.5 w-3.5" />
                    ) : (
                      <TrashIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Manual search/preview. */}
          <div className="mt-3 border-t border-gray-100 pt-2">
            <label className="mb-1 block text-xs font-medium text-ink-soft">
              {t("Preview search")}
            </label>
            <div className="flex gap-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                }}
                placeholder={t("Try a phrase from your writing…")}
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-accent"
              />
              <button
                onClick={() => void runSearch()}
                disabled={!query.trim() || searching || (sources?.length ?? 0) === 0}
                className="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-ink-soft hover:bg-gray-100 disabled:opacity-40"
              >
                {searching ? "…" : "Search"}
              </button>
            </div>

            {results !== null && results.length === 0 && (
              <p className="mt-2 text-center text-[11px] text-ink-faint">{t("No matches.")}</p>
            )}
            {results !== null && results.length > 0 && (
              <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                {results.map((r, i) => (
                  <li
                    key={`${r.sourcePath}-${i}`}
                    className="rounded-md border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-xs"
                  >
                    <div className="mb-0.5 truncate text-[10px] font-medium text-ink-faint" title={r.sourcePath}>
                      {fileName(r.sourcePath)}
                    </div>
                    <div className="text-ink-soft">{r.snippet}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
