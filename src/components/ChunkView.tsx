// A single paragraph "chunk" — the Jupyter-cell-like editing unit (spec §3.1).
//
// Noiseless by design: an unfocused text chunk reads like plain prose; focusing
// it reveals a subtle accent rail and the gutter controls. Diagram chunks render
// inline Mermaid with an editable code area when focused.
//
// Selectors are per-chunk, so typing in one paragraph re-renders only this
// component (Phase 5 performance goal).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  cancelChunkAction,
  generateImageFromChunk,
  regenerateImageChunk,
  runChunkAction,
  speakChunk,
  stopSpeaking,
} from "../aiActions";
import { caretVerticalEdge } from "../caret";
import { changed, wordDiff } from "../diff";
import { editorBodyFontStyle } from "../fonts";
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

  if (!chunk) return null;
  const type = chunk.metadata.chunkType;
  const isText = type === "text";
  const isHeading = type === "heading";
  const isImage = type === "image";
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
              alt={chunk.metadata.summary || "Generated image"}
              className="max-h-[28rem] max-w-full rounded-lg border border-gray-200"
            />
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-ink-faint">
              (empty image)
            </div>
          )}
          {chunk.metadata.summary && (
            <div className="mt-1 text-xs italic text-ink-faint">
              {chunk.metadata.summary}
            </div>
          )}
          {imageVersions.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-ink-faint">Versions:</span>
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
              placeholder={`Heading ${headingLevel}`}
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
          <textarea
            ref={textRef}
            value={chunk.content}
            spellCheck
            placeholder={
              isSubtitle
                ? "Subtitle"
                : index === 0
                  ? "Start writing your first paragraph…"
                  : "…"
            }
            onFocus={() => setFocused(chunkId)}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className={textCls}
            style={bodyFontStyle}
          />
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
          title="Stop this AI action (the result will be discarded)"
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
                {showDiff && hasTextDiff ? "What changed (vs previous)" : "Version history"}
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
                    Revert
                  </button>
                )}
                <button
                  className="text-ink-faint hover:text-ink"
                  aria-label="Dismiss"
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
                  <div className="px-2 py-1 text-xs text-ink-faint">No earlier versions.</div>
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
        <Tooltip label={isSelected ? "Deselect paragraph" : "Select for batch edit / image generation"}>
          <button
            className={`${gutterBtn} ${isSelected ? "text-accent" : ""}`}
            aria-pressed={isSelected}
            onClick={() => toggleSelectChunk(chunkId)}
          >
            {isSelected ? <CheckSquareIcon /> : <SquareIcon />}
          </button>
        </Tooltip>
        {(isText || isHeading) && (
          <Tooltip label={speaking ? "Stop reading" : "Read this paragraph aloud"}>
            <button
              className={`${gutterBtn} hover:text-accent ${speaking ? "text-accent" : ""}`}
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
              disabled={busy}
              onClick={() => void generateImageFromChunk(chunkId)}
            >
              <ImageIcon />
            </button>
          </Tooltip>
        )}
        {isImage && (
          <Tooltip label="Regenerate this image (keeps previous versions)">
            <button
              className={`${gutterBtn} hover:text-accent`}
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
          <button className={gutterBtn} onClick={() => addChunkAfter(chunkId, "text")}>
            <PlusIcon />
          </button>
        </Tooltip>
        <Tooltip label="Move up">
          <button
            className={gutterBtn}
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
            disabled={slideScope ? !slideScope.canMoveDown : index === total - 1}
            onClick={() => (slideScope ? slideScope.moveDown() : moveChunk(chunkId, 1))}
          >
            <ArrowDownIcon />
          </button>
        </Tooltip>
        {isText && (
          <Tooltip label={chunk.metadata.subtitle ? "Unmark as subtitle" : "Mark as subtitle"}>
            <button
              className={`${gutterBtn} ${chunk.metadata.subtitle ? "text-accent" : ""}`}
              aria-pressed={!!chunk.metadata.subtitle}
              onClick={() => setChunkSubtitle(chunkId, !chunk.metadata.subtitle)}
            >
              <span className="text-[11px] font-bold leading-none">S</span>
            </button>
          </Tooltip>
        )}
        {!isImage && !slideScope && (
          <Tooltip label={isText ? "Convert to diagram" : "Convert to text"}>
            <button
              className={gutterBtn}
              onClick={() => setChunkType(chunkId, isText ? "diagram" : "text")}
            >
              <FlowIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Delete this paragraph">
          <button
            className={`${gutterBtn} hover:text-red-500`}
            onClick={() => deleteChunk(chunkId)}
          >
            <TrashIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
