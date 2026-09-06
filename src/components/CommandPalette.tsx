// Command palette (提案1 — ⌘K): every major action, searchable from anywhere,
// so the 80+ features scattered across menus/gutters stay discoverable.
// Deliberately dependency-free: substring filter over label+keywords, arrow-key
// navigation, Enter to run.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeDocument,
  checkIntegrity,
  reviewDocument,
  speakChunks,
  stopSpeaking,
} from "../aiActions";
import { confirmDiscard } from "../confirm";
import {
  exportDocument,
  exportPdf,
  exportPptx,
  importDocument,
  openFolder,
  openNative,
  pickAndInsertLocalImage,
  saveNative,
} from "../fileActions";
import { useT } from "../i18n";
import { useStore } from "../store";
import { openCitationsPanel } from "./CitationsPanel";
import { openCriteriaPanel } from "./CriteriaPanel";
import { openPersonalLibraryPanel } from "./PersonalLibraryPanel";

interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  /** When present and false, the command is hidden from the list. */
  visible?: boolean;
  run: () => void | Promise<void>;
}

export default function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const togglePalette = useStore((s) => s.togglePalette);
  const [query, setQuery] = useState("");
  const t = useT();
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // Focus after the portal paints.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Build the command list fresh each open — cheap, and it snapshots current
  // state (mode, tabs, speaking) for visibility flags.
  const commands = useMemo<Command[]>(() => {
    if (!open) return [];
    const s = useStore.getState();
    const close = () => togglePalette(false);
    const wrap = (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    };
    return [
      { id: "save", label: t("Save document"), group: t("File"), keywords: "aix write ⌘S", run: wrap(saveNative) },
      { id: "open", label: t("Open File…"), group: t("File"), keywords: "aix md load ⌘O", run: wrap(openNative) },
      {
        id: "open-folder",
        label: t("Open Folder…"),
        group: t("File"),
        keywords: "directory tree sidebar explorer browse ⌘⇧O",
        run: wrap(openFolder),
      },
      {
        id: "toggle-folder-tree",
        label: s.folderTreeOpen ? t("Hide files sidebar") : t("Show files sidebar"),
        group: t("View"),
        keywords: "folder tree explorer sidebar files",
        run: wrap(() => s.toggleFolderTree()),
      },
      { id: "import", label: t("Import (txt / md / rtf)…"), group: t("File"), keywords: "load text markdown", run: wrap(importDocument) },
      {
        id: "insert-image",
        label: t("Insert image from file…"),
        group: t("File"),
        keywords: "image figure photo picture upload local png jpg",
        run: wrap(() => pickAndInsertLocalImage(s.focusedChunkId)),
      },
      { id: "new-tab", label: t("New tab (editor)"), group: t("File"), keywords: "document ⌘T", run: wrap(() => s.newTab()) },
      { id: "new-markdown", label: t("New Markdown document"), group: t("File"), keywords: "md source preview", run: wrap(() => s.newTab("markdown")) },
      { id: "new-slide", label: t("New tab (slides)"), group: t("File"), keywords: "deck presentation", run: wrap(() => s.newTab("slide")) },
      {
        id: "close-tab",
        label: t("Close tab"),
        group: t("File"),
        keywords: "⌘W",
        visible: s.tabOrder.length > 1,
        run: wrap(async () => {
          const st = useStore.getState();
          if (st.dirty && !(await confirmDiscard("tab"))) return;
          st.closeTab(st.activeTabId);
        }),
      },
      { id: "export-md", label: t("Export as Markdown"), group: t("Export"), keywords: "md", run: wrap(() => exportDocument("md")) },
      { id: "export-txt", label: t("Export as Text"), group: t("Export"), keywords: "txt plain", run: wrap(() => exportDocument("txt")) },
      { id: "export-rtf", label: t("Export as RTF"), group: t("Export"), keywords: "word rich", run: wrap(() => exportDocument("rtf")) },
      { id: "export-pdf", label: t("Export as PDF"), group: t("Export"), keywords: "print", run: wrap(exportPdf) },
      { id: "export-pptx", label: t("Export as PowerPoint (PPTX)"), group: t("Export"), keywords: "slides deck presentation", run: wrap(exportPptx) },
      { id: "draft", label: t("Draft with AI…"), group: t("AI"), keywords: "generate write", run: wrap(() => s.openDraft()) },
      { id: "analyze", label: t("Analyze relationships"), group: t("AI"), keywords: "graph network claims", run: wrap(analyzeDocument) },
      { id: "review", label: t("AI review (comments per paragraph)"), group: t("AI"), keywords: "feedback critique", run: wrap(reviewDocument) },
      { id: "integrity", label: t("Map logic (possibly-unsupported claims & contradictions)"), group: t("AI"), keywords: "evidence fact unsupported integrity check", run: wrap(checkIntegrity) },
      { id: "criteria", label: t("Check against review criteria"), group: t("AI"), keywords: "criteria grant review coverage 科研費", run: wrap(openCriteriaPanel) },
      { id: "personal-library", label: t("Open personal library (RAG)"), group: t("AI"), keywords: "rag knowledge base sources embeddings grounding personal", run: wrap(openPersonalLibraryPanel) },
      { id: "citations", label: t("Open citations (BibTeX, APA/IEEE)"), group: t("AI"), keywords: "citation reference bibliography bibtex zotero doi arxiv apa ieee cite", run: wrap(openCitationsPanel) },
      { id: "toggle-graph", label: s.networkOpen ? t("Hide relationship graph") : t("Show relationship graph"), group: t("View"), keywords: "network panel", run: wrap(() => s.toggleNetwork()) },
      { id: "toggle-review", label: s.reviewPanelOpen ? t("Hide review comments") : t("Show review comments"), group: t("View"), keywords: "comments panel", run: wrap(() => s.toggleReviewPanel()) },
      { id: "toggle-diff", label: s.diffPanelOpen ? t("Hide changes since last save") : t("Show changes since last save"), group: t("View"), keywords: "diff changes compare save history", run: wrap(() => s.toggleDiffPanel()) },
      {
        id: "zoom-in",
        label: t("Zoom in (Markdown preview)"),
        group: t("View"),
        keywords: "zoom bigger larger preview markdown 拡大",
        visible: s.doc.mode === "markdown",
        run: wrap(() => s.setMarkdownZoom(useStore.getState().markdownZoom + 0.1)),
      },
      {
        id: "zoom-out",
        label: t("Zoom out (Markdown preview)"),
        group: t("View"),
        keywords: "zoom smaller preview markdown 縮小",
        visible: s.doc.mode === "markdown",
        run: wrap(() => s.setMarkdownZoom(useStore.getState().markdownZoom - 0.1)),
      },
      {
        id: "zoom-reset",
        label: t("Reset zoom to 100%"),
        group: t("View"),
        keywords: "zoom reset 100 preview markdown 等倍",
        visible: s.doc.mode === "markdown",
        run: wrap(() => s.setMarkdownZoom(1)),
      },
      { id: "mode-editor", label: t("Switch to paragraph editor"), group: t("View"), keywords: "mode prose chunks", visible: s.doc.mode !== "editor", run: wrap(() => s.setMode("editor")) },
      { id: "mode-markdown", label: t("Switch to Markdown editor and preview"), group: t("View"), keywords: "mode md source split", visible: s.doc.mode !== "markdown", run: wrap(() => s.setMode("markdown")) },
      { id: "mode-slides", label: t("Switch to slide view"), group: t("View"), keywords: "mode deck presentation", visible: s.doc.mode !== "slide", run: wrap(() => s.setMode("slide")) },
      {
        id: "present",
        label: t("Start presentation"),
        group: t("View"),
        keywords: "fullscreen slideshow present slides",
        visible: s.doc.mode === "slide",
        run: wrap(() => s.openPresentation()),
      },
      {
        id: "read-aloud",
        label: t("Read document aloud"),
        group: t("Speech"),
        keywords: "speak tts voice 読み上げ",
        run: wrap(() => {
          const st = useStore.getState();
          const chunks = st.doc.chunks;
          const focusIdx = st.focusedChunkId
            ? chunks.findIndex((c) => c.id === st.focusedChunkId)
            : -1;
          void speakChunks(chunks.slice(focusIdx >= 0 ? focusIdx : 0).map((c) => c.id));
        }),
      },
      {
        id: "stop-reading",
        label: t("Stop reading aloud"),
        group: t("Speech"),
        keywords: "speak tts",
        visible: s.speakingChunkId !== null,
        run: wrap(stopSpeaking),
      },
      { id: "undo", label: t("Undo"), group: t("Edit"), keywords: "⌘Z revert", visible: s.past.length > 0, run: wrap(() => s.undo()) },
      { id: "redo", label: t("Redo"), group: t("Edit"), keywords: "⌘⇧Z", visible: s.future.length > 0, run: wrap(() => s.redo()) },
      { id: "settings", label: t("Open Settings"), group: t("App"), keywords: "api key model font language ⌘,", run: wrap(() => s.openSettings()) },
      { id: "help", label: t("Open Help"), group: t("App"), keywords: "guide tutorial", run: wrap(() => s.openHelp()) },
    ].filter((c) => c.visible !== false);
  }, [open, togglePalette, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.group} ${c.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Keep the highlighted row in range and visible.
  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length, index]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      togglePalette(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[index]?.run();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh]"
      onMouseDown={() => togglePalette(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("Type a command… (translate, export, analyze, read aloud…)")}
          className="w-full border-b border-gray-100 px-4 py-3 text-sm outline-none placeholder:text-ink-faint/60"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">
              {t("No matching command.")}
            </div>
          )}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                    {c.group}
                  </div>
                )}
                <button
                  data-idx={i}
                  onClick={() => c.run()}
                  onMouseEnter={() => setIndex(i)}
                  className={`block w-full px-4 py-1.5 text-left text-sm ${
                    i === index ? "bg-accent/10 text-accent" : "text-ink-soft"
                  }`}
                >
                  {c.label}
                </button>
              </div>
            );
          })}
        </div>
        <div className="border-t border-gray-100 px-4 py-1.5 text-[10px] text-ink-faint">
          ↑↓ {t("navigate")} · Enter {t("run")} · Esc {t("close")}
        </div>
      </div>
    </div>
  );
}
