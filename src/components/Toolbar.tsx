// Global toolbar: file operations, export menu, undo/redo, document analysis,
// and settings. Kept visually quiet to honour the "Clarity & Simplicity" goal.

import { useEffect, useRef, useState } from "react";
import { analyzeDocument, speakChunks, stopSpeaking } from "../aiActions";
import {
  exportDocument,
  exportPdf,
  exportPptx,
  importDocument,
  openFolder,
  openNative,
  saveNative,
} from "../fileActions";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { ExportFormat } from "../types";
import {
  CommentIcon,
  DraftIcon,
  ExportIcon,
  FileIcon,
  FolderIcon,
  HelpIcon,
  ImportIcon,
  NetworkIcon,
  SaveIcon,
  SettingsIcon,
  SlidesIcon,
  SpeakerIcon,
  SpinnerIcon,
  StopIcon,
} from "./icons";

function ToolButton({
  onClick,
  title,
  children,
  disabled,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:bg-gray-100 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export default function Toolbar() {
  const globalBusy = useStore((s) => s.globalBusy);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const mode = useStore((s) => s.doc.mode ?? "editor");
  const setMode = useStore((s) => s.setMode);
  const model = useStore((s) => s.settings?.model ?? "");
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const openSettings = useStore((s) => s.openSettings);
  const openDraft = useStore((s) => s.openDraft);
  const openHelp = useStore((s) => s.openHelp);
  const toggleNetwork = useStore((s) => s.toggleNetwork);
  const networkOpen = useStore((s) => s.networkOpen);
  const toggleReviewPanel = useStore((s) => s.toggleReviewPanel);
  const reviewPanelOpen = useStore((s) => s.reviewPanelOpen);
  const toggleFolderTree = useStore((s) => s.toggleFolderTree);
  const folderTreeOpen = useStore((s) => s.folderTreeOpen);
  const speaking = useStore((s) => s.speakingChunkId !== null);
  const t = useT();

  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setFileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [fileMenuOpen]);

  useEffect(() => {
    if (!openMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) {
        setOpenMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenuOpen]);

  const onOpenFile = () => {
    setOpenMenuOpen(false);
    void openNative();
  };
  const onOpenFolder = () => {
    setOpenMenuOpen(false);
    void openFolder();
  };

  const onImport = () => {
    setFileMenuOpen(false);
    void importDocument();
  };
  const doExport = (fmt: ExportFormat) => {
    setFileMenuOpen(false);
    void exportDocument(fmt);
  };
  const doExportPdf = () => {
    setFileMenuOpen(false);
    void exportPdf();
  };
  const doExportPptx = () => {
    setFileMenuOpen(false);
    void exportPptx();
  };

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white/90 px-3 py-1.5 backdrop-blur">
      <div className="flex items-center gap-0.5">
        <div ref={openMenuRef} className="relative">
          <ToolButton
            onClick={() => setOpenMenuOpen((v) => !v)}
            title={t("Open a file (⌘O) or a folder (⌘⇧O)")}
          >
            <FolderIcon /> {t("Open")}
          </ToolButton>
          {openMenuOpen && (
            <div className="absolute left-0 top-9 z-30 w-48 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
              <button
                onClick={onOpenFile}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <FileIcon className="h-4 w-4" /> {t("Open File…")} <span className="ml-auto text-xs text-ink-faint">⌘O</span>
              </button>
              <button
                onClick={onOpenFolder}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <FolderIcon className="h-4 w-4" /> {t("Open Folder…")} <span className="ml-auto text-xs text-ink-faint">⌘⇧O</span>
              </button>
            </div>
          )}
        </div>
        <ToolButton onClick={() => void saveNative()} title={t("Save (⌘/Ctrl+S)")}>
          <SaveIcon /> {t("Save")}
        </ToolButton>
        <ToolButton
          onClick={() => toggleFolderTree()}
          title={folderTreeOpen ? t("Hide files sidebar") : t("Show files sidebar")}
        >
          <FolderIcon /> {folderTreeOpen ? t("Hide files") : t("Files")}
        </ToolButton>

        {/* Import + Export merged into one menu (choose after clicking). */}
        <div ref={fileMenuRef} className="relative">
          <ToolButton
            onClick={() => setFileMenuOpen((v) => !v)}
            title={t("Import or export .txt / .md / .rtf")}
          >
            <ImportIcon /> {t("Import / Export")}
          </ToolButton>
          {fileMenuOpen && (
            <div className="absolute left-0 top-9 z-30 w-52 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
              <button
                onClick={onImport}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <ImportIcon className="h-4 w-4" /> {t("Import .txt / .md / .rtf…")}
              </button>
              <div className="my-1 border-t border-gray-100" />
              <div className="px-2.5 pb-0.5 pt-1 text-xs font-medium text-ink-faint">
                {t("Export as")}
              </div>
              {(["txt", "md", "rtf"] as ExportFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => doExport(fmt)}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
                >
                  <ExportIcon className="h-4 w-4" /> .{fmt}
                </button>
              ))}
              <button
                onClick={doExportPptx}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <ExportIcon className="h-4 w-4" /> .pptx
              </button>
              <button
                onClick={doExportPdf}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <ExportIcon className="h-4 w-4" /> .pdf
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      {/* Editor, exact-source Markdown, and slide projections share one doc. */}
      <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-200 text-sm shadow-sm">
        {(["editor", "markdown", "slide"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={
              m === "editor"
                ? t("Paragraph editor view")
                : m === "markdown"
                  ? t("Markdown source and preview")
                  : t("Slide deck view")
            }
            className={`flex items-center gap-1.5 px-2.5 py-1 ${
              mode === m ? "bg-accent text-white" : "bg-white text-ink-soft hover:bg-gray-100"
            }`}
          >
            {m === "editor" ? (
              <FileIcon className="h-3.5 w-3.5" />
            ) : m === "markdown" ? (
              <span className="font-mono text-[10px] font-semibold">MD</span>
            ) : (
              <SlidesIcon className="h-3.5 w-3.5" />
            )}
            {m === "editor" ? t("Editor") : m === "markdown" ? t("Markdown") : t("Slides")}
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <ToolButton onClick={undo} title={t("Undo (⌘/Ctrl+Z)")} disabled={!canUndo}>
        {t("Undo")}
      </ToolButton>
      <ToolButton onClick={redo} title={t("Redo (⌘/Ctrl+Shift+Z)")} disabled={!canRedo}>
        {t("Redo")}
      </ToolButton>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <ToolButton
        onClick={openDraft}
        title={t("Draft a whole document by AI — set length and attach reference material")}
        disabled={!!globalBusy}
      >
        <DraftIcon /> {t("Draft by AI")}
      </ToolButton>

      <ToolButton onClick={() => toggleReviewPanel()} title={t("Review comments")}>
        <CommentIcon /> {reviewPanelOpen ? t("Hide review") : t("Review")}
      </ToolButton>

      {/* Whole-document read-aloud (item 14): reads from the focused paragraph
          onward (or the top). Becomes Stop while anything is speaking. */}
      {speaking ? (
        <ToolButton onClick={() => void stopSpeaking()} title={t("Stop reading aloud")}>
          <StopIcon /> {t("Stop")}
        </ToolButton>
      ) : (
        <ToolButton
          onClick={() => {
            const s = useStore.getState();
            const chunks = s.doc.chunks;
            const focusIdx = s.focusedChunkId
              ? chunks.findIndex((c) => c.id === s.focusedChunkId)
              : -1;
            const from = focusIdx >= 0 ? focusIdx : 0;
            void speakChunks(chunks.slice(from).map((c) => c.id));
          }}
          title={t("Read the document aloud from the current paragraph")}
        >
          <SpeakerIcon /> {t("Read")}
        </ToolButton>
      )}

      <ToolButton onClick={openHelp} title={t("How to write with NurumayuEditor — workflow guide")}>
        <HelpIcon /> {t("Help")}
      </ToolButton>

      {/* Right cluster: hugs the right edge on wide windows, wraps cleanly on
          narrow ones (ml-auto instead of a flex-1 spacer, so nothing is clipped). */}
      <div className="ml-auto flex items-center gap-1">
        {globalBusy && (
          <div className="mr-2 flex items-center gap-1.5 text-sm text-accent">
            <SpinnerIcon className="text-accent" /> {globalBusy}
          </div>
        )}

        {/* Relationship graph: an optional, occasional-use tool (not a weekly
            essential), so it lives here in the quiet secondary cluster rather
            than as a hero peer to Draft/Save/Export — still reachable via the
            command palette ("Analyze relationships") as the primary path. */}
        <button
          onClick={() => {
            if (networkOpen) toggleNetwork(false);
            else void analyzeDocument();
          }}
          title={t("Map the logic between paragraphs → optional relationship graph")}
          disabled={!networkOpen && !!globalBusy}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-faint transition-colors hover:bg-gray-100 hover:text-ink-soft disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <NetworkIcon className="h-3.5 w-3.5" /> {networkOpen ? t("Hide graph") : t("Analyze")}
        </button>

        <button
          onClick={openSettings}
          title={
            hasApiKey
              ? `Model: ${model || "(default)"}`
              : t("API key not set — click to configure")
          }
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-soft hover:bg-gray-100 hover:text-ink"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              hasApiKey ? "bg-emerald-500" : "bg-amber-400"
            }`}
          />
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
