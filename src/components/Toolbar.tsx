// Global toolbar: file operations, export menu, undo/redo, document analysis,
// and settings. Kept visually quiet to honour the "Clarity & Simplicity" goal.

import { useEffect, useRef, useState } from "react";
import { analyzeDocument, speakChunks, stopSpeaking } from "../aiActions";
import {
  exportDocument,
  exportPdf,
  exportPptx,
  importDocument,
  openNative,
  saveNative,
} from "../fileActions";
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
  const speaking = useStore((s) => s.speakingChunkId !== null);

  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);

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
        <ToolButton onClick={() => void openNative()} title="Open .aix document in a new tab">
          <FolderIcon /> Open
        </ToolButton>
        <ToolButton onClick={() => void saveNative()} title="Save (⌘/Ctrl+S)">
          <SaveIcon /> Save
        </ToolButton>

        {/* Import + Export merged into one menu (choose after clicking). */}
        <div ref={fileMenuRef} className="relative">
          <ToolButton
            onClick={() => setFileMenuOpen((v) => !v)}
            title="Import or export .txt / .md / .rtf"
          >
            <ImportIcon /> Import / Export
          </ToolButton>
          {fileMenuOpen && (
            <div className="absolute left-0 top-9 z-30 w-52 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
              <button
                onClick={onImport}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-gray-100"
              >
                <ImportIcon className="h-4 w-4" /> Import .txt / .md / .rtf…
              </button>
              <div className="my-1 border-t border-gray-100" />
              <div className="px-2.5 pb-0.5 pt-1 text-xs font-medium text-ink-faint">
                Export as
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

      {/* View mode: switch the current document between prose Editor and Slides.
          Both are the same chunks, presented differently. */}
      <span className="shrink-0 pr-0.5 text-xs font-medium text-ink-faint">View</span>
      <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-200 text-sm shadow-sm">
        {(["editor", "slide"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={m === "editor" ? "Prose editor view" : "Slide deck view"}
            className={`flex items-center gap-1.5 px-2.5 py-1 ${
              mode === m ? "bg-accent text-white" : "bg-white text-ink-soft hover:bg-gray-100"
            }`}
          >
            {m === "editor" ? (
              <FileIcon className="h-3.5 w-3.5" />
            ) : (
              <SlidesIcon className="h-3.5 w-3.5" />
            )}
            {m === "editor" ? "Editor" : "Slides"}
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <ToolButton onClick={undo} title="Undo (⌘/Ctrl+Z)" disabled={!canUndo}>
        Undo
      </ToolButton>
      <ToolButton onClick={redo} title="Redo (⌘/Ctrl+Shift+Z)" disabled={!canRedo}>
        Redo
      </ToolButton>

      <div className="mx-1 h-5 w-px bg-gray-200" />

      <ToolButton
        onClick={openDraft}
        title="Draft a whole document by AI — set length and attach reference material"
        disabled={!!globalBusy}
      >
        <DraftIcon /> Draft by AI
      </ToolButton>

      <ToolButton
        onClick={() => {
          if (networkOpen) toggleNetwork(false);
          else void analyzeDocument();
        }}
        // UI2: don't let a second Analyze start while one is running (analyzeDocument
        // also guards internally); "Hide graph" stays available.
        disabled={!networkOpen && !!globalBusy}
        title="Analyze relationships → network graph"
      >
        <NetworkIcon /> {networkOpen ? "Hide graph" : "Analyze"}
      </ToolButton>

      <ToolButton onClick={() => toggleReviewPanel()} title="Review comments">
        <CommentIcon /> {reviewPanelOpen ? "Hide review" : "Review"}
      </ToolButton>

      {/* Whole-document read-aloud (item 14): reads from the focused paragraph
          onward (or the top). Becomes Stop while anything is speaking. */}
      {speaking ? (
        <ToolButton onClick={() => void stopSpeaking()} title="Stop reading aloud">
          <StopIcon /> Stop
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
          title="Read the document aloud from the current paragraph"
        >
          <SpeakerIcon /> Read
        </ToolButton>
      )}

      <ToolButton onClick={openHelp} title="How to write with NurumayuFacet — workflow guide">
        <HelpIcon /> Help
      </ToolButton>

      {/* Right cluster: hugs the right edge on wide windows, wraps cleanly on
          narrow ones (ml-auto instead of a flex-1 spacer, so nothing is clipped). */}
      <div className="ml-auto flex items-center gap-1">
        {globalBusy && (
          <div className="mr-2 flex items-center gap-1.5 text-sm text-accent">
            <SpinnerIcon className="text-accent" /> {globalBusy}
          </div>
        )}

        <button
          onClick={openSettings}
          title={
            hasApiKey
              ? `Model: ${model || "(default)"}`
              : "API key not set — click to configure"
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
