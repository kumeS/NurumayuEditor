// A single paragraph "chunk" — the Jupyter-cell-like editing unit (spec §3.1).
//
// Noiseless by design: an unfocused text chunk reads like plain prose; focusing
// it reveals a subtle accent rail and the gutter controls. Diagram chunks render
// inline Mermaid with an editable code area when focused.
//
// Selectors are per-chunk, so typing in one paragraph re-renders only this
// component (Phase 5 performance goal).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  aiReady,
  cancelChunkAction,
  generateImageFromChunk,
  regenerateImageChunk,
  runChunkAction,
  speakChunk,
  stopSpeaking,
} from "../aiActions";
import { caretVerticalEdge } from "../caret";
import { changed, wordDiff } from "../diff";
import { pickAndInsertLocalImage } from "../fileActions";
import { editorBodyFontStyle } from "../fonts";
import { useT } from "../i18n";
import { useStore } from "../store";
import ChunkAiMenu from "./ChunkAiMenu";
import MermaidChunk from "./MermaidChunk";
import Tooltip from "./Tooltip";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckSquareIcon,
  CloseIcon,
  CommentIcon,
  FlowIcon,
  HistoryIcon,
  ImageIcon,
  ImportIcon,
  PlusIcon,
  RegenerateIcon,
  SpeakerIcon,
  SquareIcon,
  StopIcon,
  SummaryIcon,
  TrashIcon,
} from "./icons";

// Desired caret offset to apply when a chunk gains focus via keyboard nav.
const pendingCaret = new Map<string, number>();
export function setPendingCaret(id: string, offset: number) {
  pendingCaret.set(id, offset);
}

// Ghost-text inline completion (開発.txt Stage 2, item 2-4). A nice-to-have
// quality-of-life feature, not a differentiator — kept deliberately lean:
// debounce after typing stops, one in-flight request per chunk (last one
// wins), no error surface (a failed/slow completion is simply invisible).
const GHOST_DEBOUNCE_MS = 400;

interface Props {
  chunkId: string;
  index: number;
  total: number;
  /**
   * When set, this chunk is rendered inside the Slide editor (B2/UI4/D4). It
   * constrains structural editing to the current slide: moves stay within the
   * slide (and never displace the title), arrow-nav/merge can't leave it, and
   * the heading-creating shortcuts that would silently re-cut slides are
   * disabled. New slides / titles are made via explicit slide controls instead.
   */
  slideScope?: {
    ids: string[];
    canMoveUp: boolean;
    canMoveDown: boolean;
    moveUp: () => void;
    moveDown: () => void;
  };
}

export default function ChunkView({ chunkId, index, total, slideScope }: Props) {
  const t = useT();
  const chunk = useStore((s) => s.doc.chunks.find((c) => c.id === chunkId));
  const busy = useStore((s) => !!s.busyChunks[chunkId]);
  const isFocused = useStore((s) => s.focusedChunkId === chunkId);
  const isFlashing = useStore(
    (s) => s.flashChunkId === chunkId || s.flashChunkIds.includes(chunkId)
  );
  const isStreaming = useStore((s) => s.streamingChunkId === chunkId);
  const streamingText = useStore((s) => (s.streamingChunkId === chunkId ? s.streamingText : ""));

  const updateChunkContent = useStore((s) => s.updateChunkContent);
  const setFocused = useStore((s) => s.setFocused);
  const splitChunk = useStore((s) => s.splitChunk);
  const mergeWithPrevious = useStore((s) => s.mergeWithPrevious);
  const deleteChunk = useStore((s) => s.deleteChunk);
  const moveChunk = useStore((s) => s.moveChunk);
  const addChunkAfter = useStore((s) => s.addChunkAfter);
  const setChunkType = useStore((s) => s.setChunkType);
  const setHeadingLevel = useStore((s) => s.setHeadingLevel);
  const setChunkSubtitle = useStore((s) => s.setChunkSubtitle);
  const setChunkConfirmed = useStore((s) => s.setChunkConfirmed);
  const convertToHeading = useStore((s) => s.convertToHeading);
  const isSelected = useStore((s) => s.selectedChunkIds.includes(chunkId));
  const toggleSelectChunk = useStore((s) => s.toggleSelectChunk);
  const selectChunkVersion = useStore((s) => s.selectChunkVersion);
  const justAiEdited = useStore((s) => s.lastAiEditChunkId === chunkId);
  const dismissAiEdit = useStore((s) => s.dismissAiEdit);
  const settings = useStore((s) => s.settings);
  // Review comments: open the panel with this chunk as the composer target.
  const toggleReviewPanel = useStore((s) => s.toggleReviewPanel);
  const setReviewTarget = useStore((s) => s.setReviewTarget);
  const flashChunk = useStore((s) => s.flashChunk);

  // Ghost-text inline completion (開発.txt Stage 2, item 2-4).
  const ghostText = useStore((s) =>
    s.ghostSuggestion?.chunkId === chunkId ? s.ghostSuggestion.text : null
  );
  const startGhostRequest = useStore((s) => s.startGhostRequest);
  const setGhostSuggestion = useStore((s) => s.setGhostSuggestion);
  const clearGhostSuggestion = useStore((s) => s.clearGhostSuggestion);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  // UI3: read-aloud state lives in the store (a single global "speaking" chunk),
  // so completion/Stop clears exactly this button and never another chunk's.
  const speaking = useStore((s) => s.speakingChunkId === chunkId);
  // Auto-open the "what changed" panel right after an AI edit.
  const [showDiff, setShowDiff] = useState(false);
  useEffect(() => {
    if (justAiEdited) setShowDiff(true);
  }, [justAiEdited]);

  // Auto-grow the textarea to fit its content.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [chunk?.content, chunk?.metadata.chunkType, isFocused]);

  // Apply focus + any pending caret when this chunk becomes the focused one.
  useEffect(() => {
    if (!isFocused) return;
    const el = textRef.current;
    if (!el) return;
    if (document.activeElement !== el) el.focus();
    const caret = pendingCaret.get(chunkId);
    if (caret !== undefined) {
      const pos = Math.min(caret, el.value.length);
      el.setSelectionRange(pos, pos);
      pendingCaret.delete(chunkId);
    }
  }, [isFocused, chunkId]);

  // Scroll into view + flash when navigated from the network graph.
  useEffect(() => {
    if (isFlashing) {
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isFlashing]);

  // Ghost-text inline completion (開発.txt Stage 2, item 2-4): after the user
  // stops typing in a focused, non-empty TEXT chunk (headings/diagrams/images
  // are out of scope — this is a prose quality-of-life feature, not a
  // differentiator) with the caret at the very END of the content, wait
  // GHOST_DEBOUNCE_MS and then request one short continuation. Any keystroke
  // (content or caret move) cancels the pending timer and clears whatever
  // suggestion was showing — "let normal typing win" beats a stale ghost.
  useEffect(() => {
    clearGhostSuggestion();
    if (!chunk || chunk.metadata.chunkType !== "text" || !isFocused) return;
    if (!chunk.content.trim()) return;
    if (!aiReady()) return; // silent — no toast for a background nicety

    const timer = window.setTimeout(() => {
      // Check the CURRENT caret/content right before firing, not what the
      // effect captured when it started — the user may have kept the caret
      // still but moved it away from the end (e.g. arrow keys) without a new
      // content change re-running this effect.
      const el = textRef.current;
      if (
        !el ||
        el.selectionStart !== el.value.length ||
        el.selectionEnd !== el.value.length
      ) {
        return;
      }
      const live = useStore.getState().doc.chunks.find((c) => c.id === chunkId);
      if (!live || !live.content.trim()) return;

      // Cheap context hint: the nearest preceding heading, if any — NOT a
      // full document map (that's for one-click actions, not a
      // must-feel-instant background completion).
      const chunks = useStore.getState().doc.chunks;
      const idx = chunks.findIndex((c) => c.id === chunkId);
      let contextHint = "";
      for (let i = idx - 1; i >= 0; i--) {
        if (chunks[i].metadata.chunkType === "heading" && chunks[i].content.trim()) {
          contextHint = chunks[i].content.trim();
          break;
        }
      }

      const requestId = startGhostRequest();
      void api
        .aiGhostCompleteStream(live.content, contextHint, (text) => {
          setGhostSuggestion(chunkId, text, requestId);
        })
        .then((finalText) => setGhostSuggestion(chunkId, finalText, requestId))
        .catch(() => {
          // Silent by design (item 8 of the spec): a completion failing or
          // being slow is invisible — never a toast for this background
          // nicety. A superseded request's late arrival is already a no-op
          // via the requestId guard in setGhostSuggestion.
        });
    }, GHOST_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // Re-run on every content change so the debounce restarts; also on focus
    // change so switching away cancels a pending timer for this chunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk?.content, isFocused, chunkId]);

  if (!chunk) return null;
  const type = chunk.metadata.chunkType;
  const isText = type === "text";
  const isHeading = type === "heading";
  const isImage = type === "image";
  // A locally-inserted image (file picker / drag-drop / paste) has no
  // generation prompt, so "Regenerate" (which re-runs the AI image prompt)
  // doesn't apply to it — only to an AI-generated image (the default for
  // pre-v1.3 documents predating this distinction; see models.rs normalize()).
  const isLocalImage = isImage && chunk.metadata.imageSource === "local";
  const isSubtitle = isText && !!chunk.metadata.subtitle; // Req 3
  // A subtitle renders larger and lighter than a body paragraph. Body prose
  // follows the user's editor font settings (提案5 — family/size as inline
  // style, see fonts.ts); subtitles/headings keep their designed sans styling.
  const textCls = isSubtitle
    ? "w-full resize-none overflow-hidden bg-transparent font-sans text-2xl font-medium leading-snug text-ink-soft outline-none placeholder:text-ink-faint/40"
    : "w-full resize-none overflow-hidden bg-transparent text-ink-soft outline-none placeholder:text-ink-faint/50";
  const bodyFontStyle = isSubtitle ? undefined : editorBodyFontStyle(settings);
  const headingLevel = Math.min(Math.max(chunk.metadata.level ?? 1, 1), 3);

  // Per-chunk version history (prior text revisions / image URLs).
  const history = chunk.metadata.contentHistory ?? [];
  const prevVersion = history.length ? history[history.length - 1] : null;
  // All distinct image versions, newest (current) last, for the picker strip.
  const imageVersions = isImage
    ? Array.from(new Set([...history, chunk.content].filter(Boolean)))
    : [];
  const hasTextDiff =
    (isText || isHeading) && !!prevVersion && changed(prevVersion, chunk.content);

  // Unresolved review comments on this chunk — drives the gutter badge.
  const unresolvedComments = (chunk.metadata.comments ?? []).filter(
    (cm) => !cm.resolved
  ).length;

  // Typing "# ", "## " or "### " at the start of a text chunk turns it into a
  // heading of that level (Markdown-style). Disabled inside the slide editor
  // (D4): a heading there starts a NEW slide, so auto-converting a bullet you're
  // typing would silently split the current slide.
  const handleTextChange = (value: string) => {
    const m = /^(#{1,3})[ \t](.*)$/.exec(value);
    if (m && !slideScope) convertToHeading(chunkId, m[1].length, m[2]);
    else updateChunkContent(chunkId, value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // don't interrupt IME composition
    const mod = e.metaKey || e.ctrlKey;
    const el = e.currentTarget;

    // Ghost-text (開発.txt Stage 2, item 2-4): plain Tab (no modifier) accepts
    // the visible suggestion by inserting it at the cursor. Only intercepted
    // when a suggestion is actually showing — with nothing suggested, Tab
    // falls through untouched (normal focus-move behaviour is preserved; this
    // codebase has no other global Tab handler to conflict with). Escape
    // dismisses; every other key just lets the suggestion vanish naturally on
    // the next debounce effect run — no explicit handling needed here.
    if (ghostText && !mod && !e.shiftKey && !e.altKey && e.key === "Tab") {
      e.preventDefault();
      const accepted = chunk.content + ghostText;
      clearGhostSuggestion();
      updateChunkContent(chunkId, accepted);
      setPendingCaret(chunkId, accepted.length);
      return;
    }
    if (ghostText && e.key === "Escape") {
      e.preventDefault();
      clearGhostSuggestion();
      return;
    }

    if (mod && e.key === "Enter" && e.shiftKey) {
      // Split this chunk at the caret.
      e.preventDefault();
      const newId = splitChunk(chunkId, el.selectionStart);
      if (newId) setPendingCaret(newId, 0);
      return;
    }
    if (mod && e.key === "Enter") {
      // Run the default one-click AI action.
      e.preventDefault();
      void runChunkAction(chunkId, "proofread");
      return;
    }
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !mod &&
      !e.shiftKey &&
      !e.altKey &&
      el.selectionStart === el.selectionEnd
    ) {
      // Move between chunks when the caret is at the paragraph's top/bottom
      // visual line; otherwise let the textarea move the caret normally.
      const chunks = useStore.getState().doc.chunks;
      const here = chunks.findIndex((c) => c.id === chunkId);
      const up = e.key === "ArrowUp";
      // Skip image chunks (they have no editable textarea to land in).
      let ti = up ? here - 1 : here + 1;
      while (
        ti >= 0 &&
        ti < chunks.length &&
        chunks[ti].metadata.chunkType === "image"
      ) {
        ti += up ? -1 : 1;
      }
      const target = chunks[ti];
      // UI4: in the slide editor, never move focus to a chunk outside the current
      // slide (that would scroll the cursor off the visible canvas).
      if (target && (!slideScope || slideScope.ids.includes(target.id))) {
        const edge = caretVerticalEdge(el);
        if ((up && edge.atFirstLine) || (!up && edge.atLastLine)) {
          e.preventDefault();
          // Up → caret at the end of the previous chunk; Down → start of the next.
          setPendingCaret(target.id, up ? target.content.length : 0);
          setFocused(target.id);
          return;
        }
      }
    }
    if (
      e.key === "Backspace" &&
      el.selectionStart === 0 &&
      el.selectionEnd === 0
    ) {
      // An empty heading + Backspace at start demotes it back to a text chunk.
      // Disabled in the slide editor (D4): the heading is the slide's title, so
      // demoting it would silently merge this slide into the previous one.
      if (isHeading && chunk.content === "" && !slideScope) {
        e.preventDefault();
        setChunkType(chunkId, "text");
        return;
      }
      // Merge a text paragraph into the previous text paragraph — but in the
      // slide editor only when the previous paragraph is in the SAME slide (D4),
      // so a backspace can't pull text across a slide boundary.
      if (index > 0 && isText) {
        const chunks = useStore.getState().doc.chunks;
        const prev = chunks[index - 1];
        if (
          prev &&
          prev.metadata.chunkType === "text" &&
          (!slideScope || slideScope.ids.includes(prev.id))
        ) {
          e.preventDefault();
          setPendingCaret(prev.id, prev.content.length);
          mergeWithPrevious(chunkId);
        }
      }
    }
  };

  const gutterBtn =
    "flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-gray-100 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div
      ref={containerRef}
      id={`chunk-${chunkId}`}
      data-chunk-id={chunkId}
      className={`group relative rounded-md transition-shadow ${
        isFlashing ? "ring-2 ring-accent/60" : ""
      } ${isSelected ? "bg-accent/5 ring-1 ring-accent/40" : ""}`}
    >
      {/* Left gutter: AI actions + focused accent rail. Shown only for the
          selected (focused) chunk — or while a chunk is busy — so menus don't
          appear on every chunk the mouse passes over. */}
      <div className="absolute -left-11 top-0 flex flex-col items-center opacity-0 pointer-events-none transition-opacity focus-within:opacity-100 data-[on=true]:opacity-100 data-[on=true]:pointer-events-auto"
        data-on={isFocused || busy}>
        {isHeading ? (
          <div className="flex flex-col items-center gap-1">
            {/* AI actions for the subtitle/heading, plus the H1/H2/H3 picker. */}
            <ChunkAiMenu chunkId={chunkId} chunkType={type} busy={busy} />
            <div className="flex flex-col items-center gap-0.5">
              {[1, 2, 3].map((lv) => (
                <Tooltip key={lv} label={`Set heading level ${lv}`}>
                  <button
                    onClick={() => setHeadingLevel(chunkId, lv)}
                    className={`h-5 w-6 rounded text-[11px] font-semibold ${
                      headingLevel === lv
                        ? "bg-accent/10 text-accent"
                        : "text-ink-faint hover:bg-gray-100 hover:text-ink"
                    }`}
                  >
                    H{lv}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        ) : isImage ? null : (
          <ChunkAiMenu chunkId={chunkId} chunkType={type} busy={busy} />
        )}
      </div>
      <div
        className={`absolute -left-3 top-1 bottom-1 w-0.5 rounded-full transition-colors ${
          isFocused ? "bg-accent/70" : "bg-transparent"
        }`}
      />

      {/* Body */}
      {isImage ? (
        <div
          tabIndex={0}
          onFocus={() => setFocused(chunkId)}
          className="my-1 outline-none"
        >
          {chunk.content ? (
            <img
              src={chunk.content}
              alt={chunk.metadata.summary || (isLocalImage ? t("Inserted image") : t("Generated image"))}
              className="max-h-[28rem] max-w-full rounded-lg border border-gray-200"
            />
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-ink-faint">
              (empty image)
            </div>
          )}
          {chunk.content && (
            <Tooltip
              label={
                isLocalImage
                  ? "Your figure — inserted from a file on your computer"
                  : "AI-generated image"
              }
            >
              <span className="mt-1 inline-block rounded-full border border-gray-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                {isLocalImage ? t("Your figure") : t("AI-generated")}
              </span>
            </Tooltip>
          )}
          {chunk.metadata.summary && (
            <div className="mt-1 text-xs italic text-ink-faint">
              {chunk.metadata.summary}
            </div>
          )}
          {imageVersions.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-faint">{t("Versions:")}</span>
              {imageVersions.map((v, i) => (
                <Tooltip
                  key={v}
                  label={v === chunk.content ? "Current version" : `Use version ${i + 1}`}
                >
                  <button
                    onClick={() => selectChunkVersion(chunkId, v)}
                    className={`h-10 w-10 overflow-hidden rounded border ${
                      v === chunk.content
                        ? "border-accent ring-1 ring-accent"
                        : "border-gray-200 hover:border-accent"
                    }`}
                  >
                    <img src={v} alt={`version ${i + 1}`} className="h-full w-full object-cover" />
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      ) : isHeading ? (
        (() => {
          const headingCls = `w-full resize-none overflow-hidden bg-transparent font-sans text-ink outline-none placeholder:text-ink-faint/40 ${
            headingLevel === 1
              ? "mt-3 text-3xl font-bold leading-tight"
              : headingLevel === 2
                ? "mt-2 text-2xl font-bold leading-tight"
                : "mt-1 text-xl font-semibold leading-snug"
          }`;
          return isStreaming ? (
            <div className={`${headingCls} whitespace-pre-wrap break-words`}>
              {streamingText}
              <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-accent align-middle" />
            </div>
          ) : (
            <textarea
              ref={textRef}
              value={chunk.content}
              spellCheck
              placeholder={`${t("Heading")} ${headingLevel}`}
              onFocus={() => setFocused(chunkId)}
              onChange={(e) => updateChunkContent(chunkId, e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              className={headingCls}
            />
          );
        })()
      ) : isText ? (
        isStreaming ? (
          <div className={`${textCls} whitespace-pre-wrap break-words`} style={bodyFontStyle}>
            {streamingText}
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-accent align-middle" />
          </div>
        ) : (
          <div className="relative">
            {/* Ghost-text overlay (開発.txt Stage 2, item 2-4): a non-interactive,
                non-editable preview positioned right after the cursor. Mirrors the
                textarea's own text in transparent ink (to occupy identical space/
                wrapping) so the muted suggestion lands exactly after the real
                content — never part of the editable value, so it can't be copied,
                pasted, or saved into the document by accident. Only shown when the
                caret is at the end (the debounce effect's own precondition), which
                is also why appending after the mirrored text is always correct. */}
            {ghostText && (
              <div
                aria-hidden="true"
                className={`${textCls} pointer-events-none absolute inset-0 whitespace-pre-wrap break-words !text-transparent`}
                style={bodyFontStyle}
              >
                {chunk.content}
                <span className="text-ink-faint/50">{ghostText}</span>
              </div>
            )}
            <textarea
              ref={textRef}
              value={chunk.content}
              spellCheck
              placeholder={
                isSubtitle
                  ? t("Subtitle")
                  : index === 0
                    ? t("Start writing your first paragraph…")
                    : "…"
              }
              onFocus={() => setFocused(chunkId)}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              className={textCls}
              style={bodyFontStyle}
            />
          </div>
        )
      ) : (
        <div>
          <MermaidChunk code={chunk.content} />
          <textarea
            ref={textRef}
            value={chunk.content}
            spellCheck={false}
            onFocus={() => setFocused(chunkId)}
            onChange={(e) => updateChunkContent(chunkId, e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className={`mt-1 w-full resize-none overflow-hidden rounded-md border bg-gray-50/70 p-2 font-mono text-xs leading-5 text-ink-soft outline-none transition-all ${
              isFocused
                ? "border-gray-200 opacity-100"
                : "border-transparent opacity-50 hover:opacity-100"
            }`}
          />
        </div>
      )}

      {/* FE cancel (item 22): stop an in-flight AI action on this chunk. The
          backend request itself is not aborted — its result is discarded when
          it arrives; this clears the busy/streaming UI immediately. */}
      {(busy || isStreaming) && (
        <button
          onClick={() => cancelChunkAction(chunkId)}
          className="mt-1 flex items-center gap-1 text-xs text-ink-faint hover:text-red-500"
          title={t("Stop this AI action (the result will be discarded)")}
        >
          <StopIcon className="h-3 w-3" /> Stop
        </button>
      )}

      {/* Summary metadata badge (set via Summarize action). Image chunks show
          their prompt inline, so skip the duplicate badge here. */}
      {!isImage && chunk.metadata.summary && (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-ink-faint">
          <SummaryIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="italic">{chunk.metadata.summary}</span>
        </div>
      )}

      {/* Change highlight (after an AI edit) + version history for text/heading. */}
      {(isText || isHeading) &&
        (showDiff || showHistory) &&
        (hasTextDiff || history.length > 0) && (
          <div className="mt-1.5 rounded-md border border-gray-200 bg-gray-50/80 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-soft">
                {showDiff && hasTextDiff ? t("What changed (vs previous)") : t("Version history")}
              </span>
              <div className="flex items-center gap-2">
                {prevVersion && (
                  <button
                    className="text-xs text-accent hover:underline"
                    onClick={() => {
                      selectChunkVersion(chunkId, prevVersion);
                      setShowDiff(false);
                      dismissAiEdit();
                    }}
                  >
                    {t("Revert")}
                  </button>
                )}
                <button
                  className="text-ink-faint hover:text-ink"
                  aria-label={t("Dismiss")}
                  onClick={() => {
                    setShowDiff(false);
                    setShowHistory(false);
                    dismissAiEdit();
                  }}
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            {showDiff && hasTextDiff && prevVersion ? (
              <p className="font-serif text-[1.02rem] leading-7 text-ink-soft">
                {wordDiff(prevVersion, chunk.content).map((op, i) =>
                  op.type === "equal" ? (
                    <span key={i}>{op.text}</span>
                  ) : op.type === "insert" ? (
                    <mark key={i} className="rounded bg-emerald-200/70 text-ink">
                      {op.text}
                    </mark>
                  ) : (
                    <span key={i} className="rounded bg-red-200/50 text-ink-faint line-through">
                      {op.text}
                    </span>
                  )
                )}
              </p>
            ) : (
              <div className="space-y-1">
                {history.length === 0 && (
                  <div className="px-2 py-1 text-xs text-ink-faint">{t("No earlier versions.")}</div>
                )}
                {[...history].reverse().map((v, i) => (
                  <button
                    key={`${i}-${v.slice(0, 12)}`}
                    onClick={() => selectChunkVersion(chunkId, v)}
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs text-ink-soft hover:bg-white"
                    title={v}
                  >
                    {v.trim().slice(0, 140) || "(empty)"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Right gutter: structural + image controls. Shown for the focused or
          selected chunk. */}
      <div
        className="absolute -right-11 top-0 flex flex-col gap-0.5 opacity-0 pointer-events-none transition-opacity focus-within:opacity-100 data-[on=true]:opacity-100 data-[on=true]:pointer-events-auto"
        data-on={isFocused || isSelected}
      >
        <Tooltip label={isSelected ? t("Deselect paragraph") : t("Select for batch edit / image generation")}>
          <button
            className={`${gutterBtn} ${isSelected ? "text-accent" : ""}`}
            aria-label={isSelected ? t("Deselect paragraph") : t("Select for batch edit / image generation")}
            aria-pressed={isSelected}
            onClick={() => toggleSelectChunk(chunkId)}
          >
            {isSelected ? <CheckSquareIcon /> : <SquareIcon />}
          </button>
        </Tooltip>
        {(isText || isHeading) && (
          <Tooltip label={speaking ? t("Stop reading") : t("Read this paragraph aloud")}>
            <button
              className={`${gutterBtn} hover:text-accent ${speaking ? "text-accent" : ""}`}
              aria-label={speaking ? t("Stop reading") : t("Read this paragraph aloud")}
              onClick={() => {
                if (speaking) void stopSpeaking();
                else void speakChunk(chunkId);
              }}
            >
              {speaking ? <StopIcon /> : <SpeakerIcon />}
            </button>
          </Tooltip>
        )}
        {(isText || isHeading) && (
          <Tooltip label="Generate an image from this paragraph">
            <button
              className={`${gutterBtn} hover:text-accent`}
              aria-label={t("Generate an image from this paragraph")}
              disabled={busy}
              onClick={() => void generateImageFromChunk(chunkId)}
            >
              <ImageIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Insert an image from a file on your computer">
          <button
            className={`${gutterBtn} hover:text-accent`}
            aria-label={t("Insert an image from a file on your computer")}
            disabled={busy}
            onClick={() => void pickAndInsertLocalImage(chunkId)}
          >
            <ImportIcon />
          </button>
        </Tooltip>
        {isImage && !isLocalImage && (
          <Tooltip label="Regenerate this image (keeps previous versions)">
            <button
              className={`${gutterBtn} hover:text-accent`}
              aria-label={t("Regenerate this image (keeps previous versions)")}
              disabled={busy}
              onClick={() => void regenerateImageChunk(chunkId)}
            >
              <RegenerateIcon />
            </button>
          </Tooltip>
        )}
        {(isText || isHeading) && history.length > 0 && (
          <Tooltip label="Version history (swap to an earlier version)">
            <button
              className={`${gutterBtn} ${showHistory ? "text-accent" : ""}`}
              aria-label={t("Version history (swap to an earlier version)")}
              onClick={() => {
                setShowHistory((v) => !v);
                setShowDiff(false);
              }}
            >
              <HistoryIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            unresolvedComments
              ? `Review comments (${unresolvedComments} open)`
              : "Add a review comment"
          }
        >
          <button
            className={`${gutterBtn} relative hover:text-accent ${
              unresolvedComments ? "text-accent" : ""
            }`}
            aria-label={
              unresolvedComments
                ? `Review comments (${unresolvedComments} open)`
                : "Add a review comment"
            }
            onClick={() => {
              setReviewTarget(chunkId);
              toggleReviewPanel(true);
              flashChunk(chunkId); // make the panel group easy to spot
            }}
          >
            <CommentIcon />
            {unresolvedComments > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold leading-none text-white">
                {unresolvedComments}
              </span>
            )}
          </button>
        </Tooltip>
        <Tooltip label="Add a paragraph below">
          <button
            className={gutterBtn}
            aria-label={t("Add a paragraph below")}
            onClick={() => addChunkAfter(chunkId, "text")}
          >
            <PlusIcon />
          </button>
        </Tooltip>
        <Tooltip label="Move up">
          <button
            className={gutterBtn}
            aria-label={t("Move up")}
            // B2: in a slide, the move range is the slide itself (not the whole
            // document), so a reorder can't reach into the neighbouring slide.
            disabled={slideScope ? !slideScope.canMoveUp : index === 0}
            onClick={() => (slideScope ? slideScope.moveUp() : moveChunk(chunkId, -1))}
          >
            <ArrowUpIcon />
          </button>
        </Tooltip>
        <Tooltip label="Move down">
          <button
            className={gutterBtn}
            aria-label={t("Move down")}
            disabled={slideScope ? !slideScope.canMoveDown : index === total - 1}
            onClick={() => (slideScope ? slideScope.moveDown() : moveChunk(chunkId, 1))}
          >
            <ArrowDownIcon />
          </button>
        </Tooltip>
        {isText && (
          <Tooltip label={chunk.metadata.subtitle ? t("Unmark as subtitle") : t("Mark as subtitle")}>
            <button
              className={`${gutterBtn} ${chunk.metadata.subtitle ? "text-accent" : ""}`}
              aria-label={chunk.metadata.subtitle ? t("Unmark as subtitle") : t("Mark as subtitle")}
              aria-pressed={!!chunk.metadata.subtitle}
              onClick={() => setChunkSubtitle(chunkId, !chunk.metadata.subtitle)}
            >
              <span className="text-[11px] font-bold leading-none">S</span>
            </button>
          </Tooltip>
        )}
        {isText && (
          // Personal RAG (開発.txt Stage 3, item 3-1) auto-accumulation
          // (Q11/Q16): mark this paragraph as vetted enough to feed into the
          // user's own personal library — synced into the index on the next
          // save, only when Settings' "Personal knowledge base" is on.
          <Tooltip label={chunk.metadata.confirmed ? t("Confirmed — click to unmark") : t("Mark as confirmed")}>
            <button
              className={`${gutterBtn} ${chunk.metadata.confirmed ? "text-accent" : ""}`}
              aria-label={chunk.metadata.confirmed ? t("Confirmed — click to unmark") : t("Mark as confirmed")}
              aria-pressed={!!chunk.metadata.confirmed}
              onClick={() => setChunkConfirmed(chunkId, !chunk.metadata.confirmed)}
            >
              <CheckSquareIcon className={chunk.metadata.confirmed ? "" : "opacity-40"} />
            </button>
          </Tooltip>
        )}
        {!isImage && !slideScope && (
          <Tooltip label={isText ? t("Convert to diagram") : t("Convert to text")}>
            <button
              className={gutterBtn}
              aria-label={isText ? t("Convert to diagram") : t("Convert to text")}
              onClick={() => setChunkType(chunkId, isText ? "diagram" : "text")}
            >
              <FlowIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Delete this paragraph">
          <button
            className={`${gutterBtn} hover:text-red-500`}
            aria-label={t("Delete this paragraph")}
            onClick={() => deleteChunk(chunkId)}
          >
            <TrashIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
