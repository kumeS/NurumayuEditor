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
  openNative,
  saveNative,
} from "../fileActions";
import { useStore } from "../store";

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
      { id: "save", label: "Save document", group: "File", keywords: "aix write ⌘S", run: wrap(saveNative) },
      { id: "open", label: "Open document…", group: "File", keywords: "aix load ⌘O", run: wrap(openNative) },
      { id: "import", label: "Import (txt / md / rtf)…", group: "File", keywords: "load text markdown", run: wrap(importDocument) },
      { id: "new-tab", label: "New tab (editor)", group: "File", keywords: "document ⌘T", run: wrap(() => s.newTab()) },
      { id: "new-slide", label: "New tab (slides)", group: "File", keywords: "deck presentation", run: wrap(() => s.newTab("slide")) },
      {
        id: "close-tab",
        label: "Close tab",
        group: "File",
        keywords: "⌘W",
        visible: s.tabOrder.length > 1,
        run: wrap(async () => {
          const st = useStore.getState();
          if (st.dirty && !(await confirmDiscard("tab"))) return;
          st.closeTab(st.activeTabId);
        }),
      },
      { id: "export-md", label: "Export as Markdown", group: "Export", keywords: "md", run: wrap(() => exportDocument("md")) },
      { id: "export-txt", label: "Export as Text", group: "Export", keywords: "txt plain", run: wrap(() => exportDocument("txt")) },
      { id: "export-rtf", label: "Export as RTF", group: "Export", keywords: "word rich", run: wrap(() => exportDocument("rtf")) },
      { id: "export-pdf", label: "Export as PDF", group: "Export", keywords: "print", run: wrap(exportPdf) },
      { id: "export-pptx", label: "Export as PowerPoint (PPTX)", group: "Export", keywords: "slides deck presentation", run: wrap(exportPptx) },
      { id: "draft", label: "Draft with AI…", group: "AI", keywords: "generate write", run: wrap(() => s.openDraft()) },
      { id: "analyze", label: "Analyze relationships", group: "AI", keywords: "graph network claims", run: wrap(analyzeDocument) },
      { id: "review", label: "AI review (comments per paragraph)", group: "AI", keywords: "feedback critique", run: wrap(reviewDocument) },
      { id: "integrity", label: "Check integrity (claims & contradictions)", group: "AI", keywords: "evidence fact unsupported", run: wrap(checkIntegrity) },
      { id: "toggle-graph", label: s.networkOpen ? "Hide relationship graph" : "Show relationship graph", group: "View", keywords: "network panel", run: wrap(() => s.toggleNetwork()) },
      { id: "toggle-review", label: s.reviewPanelOpen ? "Hide review comments" : "Show review comments", group: "View", keywords: "comments panel", run: wrap(() => s.toggleReviewPanel()) },
      { id: "mode", label: s.doc.mode === "slide" ? "Switch to editor view" : "Switch to slide view", group: "View", keywords: "mode slides editor", run: wrap(() => s.setMode(s.doc.mode === "slide" ? "editor" : "slide")) },
      {
        id: "read-aloud",
        label: "Read document aloud",
        group: "Speech",
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
        label: "Stop reading aloud",
        group: "Speech",
        keywords: "speak tts",
        visible: s.speakingChunkId !== null,
        run: wrap(stopSpeaking),
      },
      { id: "undo", label: "Undo", group: "Edit", keywords: "⌘Z revert", visible: s.past.length > 0, run: wrap(() => s.undo()) },
      { id: "redo", label: "Redo", group: "Edit", keywords: "⌘⇧Z", visible: s.future.length > 0, run: wrap(() => s.redo()) },
      { id: "settings", label: "Open Settings", group: "App", keywords: "api key model font language ⌘,", run: wrap(() => s.openSettings()) },
      { id: "help", label: "Open Help", group: "App", keywords: "guide tutorial", run: wrap(() => s.openHelp()) },
    ].filter((c) => c.visible !== false);
  }, [open, togglePalette]);

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
          placeholder="Type a command… (translate, export, analyze, read aloud…)"
          className="w-full border-b border-gray-100 px-4 py-3 text-sm outline-none placeholder:text-ink-faint/60"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">
              No matching command.
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
          ↑↓ navigate · Enter run · Esc close
        </div>
      </div>
    </div>
  );
}
