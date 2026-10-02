// Command palette (提案1 — ⌘K): every major action, searchable from anywhere,
// so the 80+ features scattered across menus/gutters stay discoverable.
// Deliberately dependency-free: substring filter over label+keywords, arrow-key
// navigation, Enter to run.

import { useEffect, useMemo, useRef, useState } from "react";
import { PREVIEW_PAN_STEP } from "../previewViewport";
import { requestPreviewPan } from "./usePreviewViewport";
import {
  analyzeDocument,
  checkIntegrity,
  reviewDocument,
  speakChunks,
  stopSpeaking,
  suggestSlideLayout,
  summarizeSlide,
} from "../aiActions";
import { slideCommandTarget } from "../slideCommands";
import {
  exportDocument,
  exportPdf,
  exportPptx,
  importDocument,
  openFolder,
  openNative,
  pickAndInsertLocalImage,
  requestCloseTab,
  saveNative,
  saveNativeAs,
} from "../fileActions";
import { useT } from "../i18n";
import { isImeKeyEvent } from "../modalBehavior";
import Modal from "./Modal";
import { PREVIEW_BACKGROUNDS, PREVIEW_BACKGROUND_LABELS, setPreviewBackground } from "../previewBackground";
import { requestPreviewAdd } from "./MarkdownPreview";
import { findStep, openFindBar } from "./FindBar";
import { findAvailability } from "../findReplace";
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
      // Focus is Modal's job (initialFocusRef).
    }
  }, [open]);

  // Build the command list fresh each open — cheap, and it snapshots current
  // state (mode, tabs, speaking) for visibility flags.
  const commands = useMemo<Command[]>(() => {
    if (!open) return [];
    const s = useStore.getState();
    const close = () => togglePalette(false);
    // `unknown`: actions may resolve to a value (saveNative → saved?) that
    // the palette ignores.
    const wrap = (fn: () => unknown) => () => {
      close();
      void fn();
    };
    // D3 (ui.md #3): the Slides editor's commands, acting on the slide that
    // holds the focused chunk (the rail's own selection rule).
    const slideMode = s.doc.mode === "slide";
    const slide = slideCommandTarget(s.doc.chunks, s.focusedChunkId);
    const slideIds = slide.current?.items.map((c) => c.id) ?? [];
    return [
      { id: "save", label: t("Save document"), group: t("File"), keywords: "aix write ⌘S", run: wrap(saveNative) },
      { id: "save-as", label: t("Save As…"), group: t("File"), keywords: "save as copy rename aix md duplicate 別名 ⇧⌘S", run: wrap(saveNativeAs) },
      { id: "open", label: t("Open File…"), group: t("File"), keywords: "aix md load ⌘O", run: wrap(openNative) },
      {
        id: "open-folder",
        label: t("Open Folder…"),
        group: t("File"),
        // ⇧⌘O is what the toolbar shows (macOS order); ⌘⇧O kept as a search synonym.
        keywords: "directory tree sidebar explorer browse ⇧⌘O ⌘⇧O",
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
        keywords: "⌘W close document 閉じる",
        // Always available: the last tab closes too (BUG-018).
        run: wrap(async () => {
          await requestCloseTab(useStore.getState().activeTabId);
        }),
      },
      { id: "export-md", label: t("Export as Markdown"), group: t("Export"), keywords: "md", run: wrap(() => exportDocument("md")) },
      { id: "export-txt", label: t("Export as Text"), group: t("Export"), keywords: "txt plain", run: wrap(() => exportDocument("txt")) },
      { id: "export-rtf", label: t("Export as RTF"), group: t("Export"), keywords: "word rich", run: wrap(() => exportDocument("rtf")) },
      { id: "export-pdf", label: t("Export as PDF"), group: t("Export"), keywords: "pdf save export", run: wrap(exportPdf) },
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
      {
        id: "preview-pan-left",
        label: t("Move preview left"),
        group: t("View"),
        keywords: "pan shift move left column preview markdown 左 移動 ずらす",
        visible: s.doc.mode === "markdown",
        run: wrap(() => requestPreviewPan(-PREVIEW_PAN_STEP)),
      },
      {
        id: "preview-pan-right",
        label: t("Move preview right"),
        group: t("View"),
        keywords: "pan shift move right column preview markdown 右 移動 ずらす",
        visible: s.doc.mode === "markdown",
        run: wrap(() => requestPreviewPan(PREVIEW_PAN_STEP)),
      },
      {
        id: "preview-recenter",
        label: t("Re-center preview"),
        group: t("View"),
        keywords: "center centre reset pan column preview markdown 中央",
        visible: s.doc.mode === "markdown",
        run: wrap(() => s.setMarkdownOffsetX(0)),
      },
      {
        id: "preview-add-paragraph",
        label: t("Add paragraph (Markdown preview)"),
        group: t("Edit"),
        keywords: "new paragraph chunk block preview markdown 段落 追加",
        visible: s.doc.mode === "markdown",
        run: wrap(() => requestPreviewAdd("paragraph")),
      },
      {
        id: "preview-add-heading",
        label: t("Add heading (Markdown preview)"),
        group: t("Edit"),
        keywords: "new heading section preview markdown 見出し 追加",
        visible: s.doc.mode === "markdown",
        run: wrap(() => requestPreviewAdd("heading")),
      },
      ...PREVIEW_BACKGROUNDS.map((tone) => ({
        id: `preview-bg-${tone}`,
        label: `${t("Preview background")}: ${t(PREVIEW_BACKGROUND_LABELS[tone])}`,
        group: t("View"),
        keywords: `background color colour tone preview markdown 背景 ${tone}`,
        visible: s.doc.mode === "markdown",
        run: wrap(() => setPreviewBackground(tone)),
      })),
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
        id: "slide-add",
        label: t("Add slide"),
        group: t("Slides"),
        keywords: "new slide heading append スライド 追加 新規",
        visible: slideMode,
        run: wrap(() => {
          const last = s.doc.chunks[s.doc.chunks.length - 1]?.id ?? null;
          s.setFocused(s.addChunkAfter(last, "heading"));
        }),
      },
      {
        id: "slide-duplicate",
        label: t("Duplicate slide"),
        group: t("Slides"),
        keywords: "copy clone slide スライド 複製 コピー",
        visible: slideMode && slide.canDuplicate,
        run: wrap(() => {
          const ids = s.duplicateChunksAfter(slideIds);
          if (ids[0]) s.setFocused(ids[0]);
        }),
      },
      {
        id: "slide-delete",
        label: t("Delete slide"),
        group: t("Slides"),
        keywords: "remove slide スライド 削除",
        visible: slideMode && !!slide.current,
        run: wrap(() => {
          const neighbour = slide.slides[slide.index - 1] ?? slide.slides[slide.index + 1];
          s.deleteChunks(slideIds);
          s.setFocused(neighbour?.items[0]?.id ?? null);
        }),
      },
      {
        id: "slide-merge-previous",
        label: t("Merge into previous"),
        group: t("Slides"),
        keywords: "merge join combine slide previous スライド 統合 結合 前",
        visible: slideMode && slide.mergeHeadingId !== null,
        run: wrap(() => slide.mergeHeadingId && s.mergeSlideIntoPrevious(slide.mergeHeadingId)),
      },
      {
        id: "slide-split-here",
        label: t("Split slide here"),
        group: t("Slides"),
        keywords: "split divide slide here スライド 分割 ここで",
        visible: slideMode && slide.splitAt !== null,
        run: wrap(() => slide.splitAt && s.splitSlideBefore(slide.splitAt)),
      },
      {
        id: "slide-ai-layout",
        label: t("AI layout"),
        group: t("Slides"),
        keywords: "ai layout suggest slide レイアウト 提案 スライド AI",
        visible: slideMode && !!slide.layoutHostId && !s.globalBusy,
        run: wrap(() => slide.layoutHostId && suggestSlideLayout(slide.layoutHostId)),
      },
      {
        id: "slide-summarize",
        label: t("Summarize → slide"),
        group: t("Slides"),
        keywords: "summarize summary bullets slide 要約 スライド 箇条書き AI",
        visible: slideMode && slide.textIds.length > 0 && !!slide.layoutHostId && !slide.detached && !s.globalBusy,
        run: wrap(() => slide.layoutHostId && summarizeSlide(slide.textIds, slide.layoutHostId)),
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
      // Find (BUG-010). Slides find is planned (findAvailability), so the
      // entries hide there; Go to Line is Markdown-source only.
      {
        id: "find",
        label: t("Find…"),
        group: t("Edit"),
        keywords: "find search 検索 探す ⌘F",
        visible: findAvailability(s.doc.mode) === "available",
        run: wrap(() => openFindBar("find")),
      },
      {
        id: "find-replace",
        label: t("Find and Replace…"),
        group: t("Edit"),
        keywords: "find replace search substitute 検索 置換 ⌥⌘F",
        visible: findAvailability(s.doc.mode) === "available",
        run: wrap(() => openFindBar("replace")),
      },
      {
        id: "find-next",
        label: t("Find Next"),
        group: t("Edit"),
        keywords: "find next search 次を検索 検索 ⌘G",
        visible: findAvailability(s.doc.mode) === "available",
        run: wrap(() => findStep("next")),
      },
      {
        id: "find-previous",
        label: t("Find Previous"),
        group: t("Edit"),
        keywords: "find previous search 前を検索 検索 ⇧⌘G",
        visible: findAvailability(s.doc.mode) === "available",
        run: wrap(() => findStep("prev")),
      },
      {
        id: "go-to-line",
        label: t("Go to Line…"),
        group: t("Edit"),
        keywords: "go to line jump number 行 行へ移動 ジャンプ ⌘L",
        visible: s.doc.mode === "markdown",
        run: wrap(() => openFindBar("line")),
      },
      { id: "settings", label: t("Open Settings"), group: t("App"), keywords: "api key model font language ⌘,", run: wrap(() => s.openSettings()) },
      {
        // ui.md #3: the model catalog lives in Settings (surface-local); this
        // makes it reachable from the palette too.
        id: "browse-openrouter-models",
        label: t("Browse OpenRouter models…"),
        group: t("AI"),
        keywords: "openrouter model catalog list choose pick price モデル 一覧 選ぶ",
        // Lands on the open text-model catalog with Fetch focused (one more
        // click lists the models; nothing is sent before that).
        run: wrap(() => s.openSettings("model-catalog")),
      },
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

  // Escape is Modal's (IME-safe); a key that commits an IME conversion must not
  // run or move the highlighted command (KBD-IME-ENTER).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKeyEvent(e.nativeEvent)) return;
    if (e.key === "ArrowDown") {
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
    <Modal
      name="palette"
      onClose={() => togglePalette(false)}
      label={t("Command palette")}
      initialFocusRef={inputRef}
      placement="top"
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl"
    >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          aria-label={t("Search commands")}
          placeholder={t("Type a command… (translate, export, analyze, read aloud…)")}
          className="w-full border-b border-chrome-hairline px-4 py-3 text-sm outline-none placeholder:text-ink-faint/60"
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
        <div className="border-t border-chrome-hairline px-4 py-1.5 text-[10px] text-ink-faint">
          ↑↓ {t("navigate")} · Enter {t("run")} · Esc {t("close")}
        </div>
    </Modal>
  );
}
