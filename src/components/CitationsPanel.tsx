// Citation management (開発.txt Stage 3, item 3-2): import a BibTeX (.bib)
// file, look up a DOI/arXiv id to auto-fill a new entry's metadata, browse
// the imported library, insert a formatted citation at the cursor, and build
// an end-of-document bibliography from the entries actually cited.
//
// Deliberately "bring your own references and format them" — NOT a
// literature-search engine (Elicit/Consensus and similar are an explicit
// non-goal). Only two citation styles are supported: APA (7th ed.,
// author-date) and IEEE (numbered bracket) — see src-tauri/src/citations.rs's
// module doc for the full rationale; this panel surfaces that limitation
// directly (a plain style picker naming exactly those two, nothing implying
// broader coverage).
//
// Persistence is per-document (a JSON sidecar next to the `.aix` file, keyed
// by the document's saved path — see citations.rs). A document that has
// never been saved has nowhere to keep one yet; this panel's empty state
// says so explicitly rather than silently no-op'ing the import button.
//
// Mount point: opened via the command palette (and rendered unconditionally,
// self-hiding, from HealthBar.tsx — the SAME pattern PersonalLibraryPanel.tsx
// and CriteriaPanel.tsx already use for exactly this reason). It owns its own
// open/closed state via the tiny store below.
//
// NOTE for the next integration step: mounting `<CitationsPanel />` once
// (e.g. alongside `<PersonalLibraryPanel />` in HealthBar.tsx) is required
// for this panel to ever be visible — HealthBar.tsx is outside this
// feature's owned-files list, so that one-line mount is left for whoever
// next touches HealthBar.tsx.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { api } from "../api";
import { spliceTextAtCursor } from "../citationInsert";
import { useStore } from "../store";
import type {
  CitationEntry,
  CitationLookupResult,
  CitationStyleName,
} from "../types";
import {
  CloseIcon,
  FileIcon,
  ImportIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
} from "./icons";

interface CitationsPanelStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Standalone panel-visibility store — see the module doc comment above. */
export const useCitationsPanelStore = create<CitationsPanelStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

/** Imperative helper for callers outside React (CommandPalette). */
export function openCitationsPanel(): void {
  useCitationsPanelStore.getState().setOpen(true);
}

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Insert `text` into the currently-focused chunk's textarea at the cursor.
 * ChunkView.tsx renders each chunk's editing surface inside a container with
 * `id="chunk-<chunkId>"` (see its `data-chunk-id`/`id` container attributes)
 * containing exactly one `<textarea>`; when that textarea is the live
 * `document.activeElement` we read its real `selectionStart`/`selectionEnd`
 * for a true "insert at cursor" (not an approximation). Falls back to
 * appending to the end of the focused chunk's content when no textarea is
 * focused (e.g. the user clicked a panel button without first clicking into
 * text) or the DOM element can't be found. */
function insertAtCursor(citationText: string): boolean {
  const st = useStore.getState();
  const chunkId = st.focusedChunkId;
  if (!chunkId) return false;
  const chunk = st.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk) return false;

  const container = document.getElementById(`chunk-${chunkId}`);
  const textarea = container?.querySelector("textarea") ?? null;
  const isFocused = textarea !== null && document.activeElement === textarea;

  const caret = isFocused ? textarea!.selectionStart : chunk.content.length;
  const { content: newContent, caretAfter } = spliceTextAtCursor(chunk.content, caret, citationText);

  st.updateChunkContent(chunkId, newContent);
  if (isFocused) {
    requestAnimationFrame(() => textarea!.setSelectionRange(caretAfter, caretAfter));
  }
  return true;
}

type Tab = "library" | "lookup";

export default function CitationsPanel() {
  const open_ = useCitationsPanelStore((s) => s.open);
  const setOpen = useCitationsPanelStore((s) => s.setOpen);
  const filePath = useStore((s) => s.filePath);

  const [tab, setTab] = useState<Tab>("library");
  const [entries, setEntries] = useState<CitationEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [style, setStyle] = useState<CitationStyleName>("apa");
  const [citedIds, setCitedIds] = useState<string[]>([]);
  const [bibliography, setBibliography] = useState<string[] | null>(null);
  const [buildingBibliography, setBuildingBibliography] = useState(false);

  // DOI/arXiv lookup tab state.
  const [lookupKind, setLookupKind] = useState<"doi" | "arxiv">("doi");
  const [lookupQuery, setLookupQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupResult, setLookupResult] = useState<CitationLookupResult | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  const refresh = async () => {
    if (!filePath) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEntries(await api.citationsList(filePath));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open_) {
      setError(null);
      setBibliography(null);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open_, filePath]);

  if (!open_) return null;

  const importBibtex = async () => {
    if (!filePath) return;
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "BibTeX", extensions: ["bib"] }],
      });
      if (typeof selected !== "string") return;
      setImporting(true);
      setError(null);
      const result = await api.citationsImportBibtex(filePath, selected);
      if (result.warnings.length > 0) {
        useStore
          .getState()
          .notify(
            `Imported ${result.added.length} citation${result.added.length === 1 ? "" : "s"} from ${fileName(selected)}, ${result.warnings.length} skipped — see the details below.`,
            "info"
          );
      } else {
        useStore
          .getState()
          .notify(
            `Imported ${result.added.length} citation${result.added.length === 1 ? "" : "s"} from ${fileName(selected)}.`,
            "success"
          );
      }
      setImportWarnings(result.warnings);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setImporting(false);
    }
  };

  const removeEntry = async (id: string, title: string) => {
    if (!filePath) return;
    setRemovingId(id);
    setError(null);
    try {
      await api.citationsRemoveEntry(filePath, id);
      useStore.getState().notify(`Removed "${title}" from the citation library.`, "success");
      setCitedIds((ids) => ids.filter((i) => i !== id));
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setRemovingId(null);
    }
  };

  const insertCitation = async (entry: CitationEntry) => {
    if (!filePath) return;
    try {
      const index = citedIds.includes(entry.id)
        ? citedIds.indexOf(entry.id) + 1
        : citedIds.length + 1;
      const text = await api.citationsFormat(filePath, entry.id, style, index);
      const inserted = insertAtCursor(text);
      if (inserted) {
        if (!citedIds.includes(entry.id)) setCitedIds((ids) => [...ids, entry.id]);
        useStore.getState().notify("Citation inserted.", "success");
      } else {
        useStore
          .getState()
          .notify("Click into a paragraph first, then insert the citation.", "info");
      }
    } catch (e) {
      setError(message(e));
    }
  };

  const runLookup = async () => {
    const q = lookupQuery.trim();
    if (!q || looking) return;
    setLooking(true);
    setError(null);
    setLookupResult(null);
    try {
      const result =
        lookupKind === "doi"
          ? await api.citationsLookupDoi(q)
          : await api.citationsLookupArxiv(q);
      setLookupResult(result);
    } catch (e) {
      setError(message(e));
    } finally {
      setLooking(false);
    }
  };

  const addLookupResult = async () => {
    if (!filePath || !lookupResult) return;
    try {
      await api.citationsAddLookupResult(filePath, lookupResult, lookupQuery.trim());
      useStore.getState().notify(`Added "${lookupResult.title}" to the citation library.`, "success");
      setLookupResult(null);
      setLookupQuery("");
      setTab("library");
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  };

  const buildBibliography = async () => {
    if (!filePath || citedIds.length === 0) return;
    setBuildingBibliography(true);
    setError(null);
    try {
      setBibliography(await api.citationsBibliography(filePath, citedIds, style));
    } catch (e) {
      setError(message(e));
    } finally {
      setBuildingBibliography(false);
    }
  };

  const insertBibliography = () => {
    if (!bibliography || bibliography.length === 0) return;
    // Both supported styles conventionally head their list "References".
    const text = `References\n\n${bibliography.join("\n\n")}`;
    const inserted = insertAtCursor(text);
    if (inserted) {
      useStore.getState().notify("Bibliography inserted.", "success");
    } else {
      useStore.getState().notify("Click into a paragraph first, then insert the bibliography.", "info");
    }
  };

  return (
    <div className="fixed bottom-9 right-2 z-40 w-[26rem] rounded-lg border border-gray-200 bg-white p-3 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <FileIcon className="h-4 w-4" />
          Citations
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink"
          aria-label="Close citations panel"
          title="Close"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-2 text-xs text-ink-faint">
        Import your own BibTeX library (from Zotero or any reference manager),
        or look up a DOI/arXiv id — this is not a literature search engine, it
        only formats references you already have. Supported styles: APA
        (7th ed.) and IEEE.
      </p>

      {!filePath && (
        <div className="rounded-md bg-amber-50/60 px-2 py-3 text-center text-xs text-amber-700">
          Save this document first — the citation library is stored alongside
          the saved file.
        </div>
      )}

      {filePath && (
        <>
          <div className="mb-2 flex items-center gap-1 border-b border-gray-100 text-xs">
            <button
              onClick={() => setTab("library")}
              className={`px-2 py-1.5 font-medium ${tab === "library" ? "border-b-2 border-accent text-accent" : "text-ink-faint"}`}
            >
              Library
            </button>
            <button
              onClick={() => setTab("lookup")}
              className={`px-2 py-1.5 font-medium ${tab === "lookup" ? "border-b-2 border-accent text-accent" : "text-ink-faint"}`}
            >
              Look up DOI / arXiv
            </button>
            <div className="ml-auto flex items-center gap-1 pr-1">
              <label className="text-[10px] text-ink-faint" htmlFor="citation-style">
                Style
              </label>
              <select
                id="citation-style"
                value={style}
                onChange={(e) => setStyle(e.target.value as CitationStyleName)}
                className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px]"
              >
                <option value="apa">APA</option>
                <option value="ieee">IEEE</option>
              </select>
            </div>
          </div>

          {error && (
            <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {tab === "library" && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-faint">
                  {entries === null ? "" : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}
                </span>
                <button
                  onClick={() => void importBibtex()}
                  disabled={importing}
                  className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-soft disabled:opacity-50"
                >
                  {importing ? <SpinnerIcon className="h-3.5 w-3.5" /> : <ImportIcon className="h-3.5 w-3.5" />}
                  Import citations (.bib)…
                </button>
              </div>

              {importWarnings.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                  {importWarnings.length} entr{importWarnings.length === 1 ? "y" : "ies"} skipped during import:
                  <ul className="mt-1 list-disc pl-4">
                    {importWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {loading && (
                <p className="mt-3 text-center text-xs text-ink-faint">Loading your citation library…</p>
              )}

              {!loading && entries !== null && entries.length === 0 && !error && (
                <p className="mt-3 rounded-md bg-gray-50/60 px-2 py-3 text-center text-xs text-ink-faint">
                  Nothing imported yet. Import a .bib file above, or look up a DOI/arXiv id.
                </p>
              )}

              {!loading && entries !== null && entries.length > 0 && (
                <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto pr-1">
                  {entries.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-md border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink" title={e.title}>
                            {e.title}
                          </div>
                          <div className="truncate text-[10px] text-ink-faint">
                            {e.authors.join(", ") || "Unknown author"}
                            {e.year ? ` · ${e.year}` : ""}
                            {citedIds.includes(e.id) ? ` · cited [${citedIds.indexOf(e.id) + 1}]` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => void insertCitation(e)}
                            className="rounded bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
                          >
                            Insert citation
                          </button>
                          <button
                            onClick={() => void removeEntry(e.id, e.title)}
                            disabled={removingId === e.id}
                            className="text-ink-faint hover:text-red-600 disabled:opacity-50"
                            aria-label={`Remove "${e.title}" from the citation library`}
                            title="Remove from library"
                          >
                            {removingId === e.id ? (
                              <SpinnerIcon className="h-3.5 w-3.5" />
                            ) : (
                              <TrashIcon className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 border-t border-gray-100 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink-faint">
                    {citedIds.length} cited entr{citedIds.length === 1 ? "y" : "ies"} this session
                  </span>
                  <button
                    onClick={() => void buildBibliography()}
                    disabled={citedIds.length === 0 || buildingBibliography}
                    className="rounded-md px-2.5 py-1.5 text-xs text-ink-soft hover:bg-gray-100 disabled:opacity-40"
                  >
                    {buildingBibliography ? "…" : "Build references list"}
                  </button>
                </div>
                {bibliography && bibliography.length > 0 && (
                  <div className="mt-2 rounded-md border border-gray-100 bg-gray-50/60 p-2">
                    <ul className="max-h-32 space-y-1.5 overflow-y-auto text-[11px] text-ink-soft">
                      {bibliography.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                    <button
                      onClick={insertBibliography}
                      className="mt-2 w-full rounded bg-accent px-2 py-1.5 text-[11px] font-medium text-white hover:bg-accent-soft"
                    >
                      Insert references list at cursor
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === "lookup" && (
            <>
              <div className="flex gap-1.5">
                <select
                  value={lookupKind}
                  onChange={(e) => setLookupKind(e.target.value as "doi" | "arxiv")}
                  className="rounded-md border border-gray-300 px-1.5 py-1.5 text-xs"
                >
                  <option value="doi">DOI</option>
                  <option value="arxiv">arXiv id</option>
                </select>
                <input
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runLookup();
                  }}
                  placeholder={lookupKind === "doi" ? "10.1234/abcd.5678" : "2101.00001"}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-accent"
                />
                <button
                  onClick={() => void runLookup()}
                  disabled={!lookupQuery.trim() || looking}
                  className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-soft disabled:opacity-50"
                >
                  {looking ? <SpinnerIcon className="h-3.5 w-3.5" /> : "Look up"}
                </button>
              </div>

              {lookupResult && (
                <div className="mt-2 rounded-md border border-gray-100 bg-gray-50/60 p-2 text-xs">
                  <div className="font-medium text-ink">{lookupResult.title}</div>
                  <div className="mt-0.5 text-[10px] text-ink-faint">
                    {lookupResult.authors.join(", ") || "Unknown author"}
                    {lookupResult.year ? ` · ${lookupResult.year}` : ""}
                    {lookupResult.venue ? ` · ${lookupResult.venue}` : ""}
                  </div>
                  {lookupResult.abstractText && (
                    <p className="mt-1 line-clamp-3 text-[11px] text-ink-soft">
                      {lookupResult.abstractText}
                    </p>
                  )}
                  <button
                    onClick={() => void addLookupResult()}
                    className="mt-2 flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent-soft"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Add to citation library
                  </button>
                </div>
              )}

              {!lookupResult && !looking && (
                <p className="mt-3 rounded-md bg-gray-50/60 px-2 py-3 text-center text-xs text-ink-faint">
                  Enter a DOI or arXiv id above to fetch its metadata.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
