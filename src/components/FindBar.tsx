// Docked find / replace / go-to-line bar (BUG-010).
//
// Docked between the toolbar and the editor — NOT a modal (ui.md #8): the
// document stays live and editable while it is open. Matching and replacing
// are the pure functions in findReplace.ts; this component only locates the
// matches for the current view, keeps the current one selected, and routes
// replacements to the right history:
// - Editor mode: chunk text (text + heading chunks). The current match is
//   handed to ChunkView through `find.hit` (highlighted + selected + scrolled);
//   Replace / Replace All go through store actions (one undo step each).
// - Markdown mode: the CodeMirror source (markdownSourceBridge). Opening the
//   bar from the Preview switches to Split so matches are visible; replaces
//   are ONE isolated CodeMirror transaction that the update listener commits
//   as its own store undo step. Go to Line works here only.
// - Slides mode: planned — the bar says so instead of searching.
// Focus stays in the bar while stepping (Enter / ⇧Enter, ⌘G / ⇧⌘G); Esc
// (IME-safe) closes it and returns focus to the editor on the current match.

import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  applyChanges,
  type ChunkMatch,
  chunkDocOffset,
  findAvailability,
  findInChunks,
  findMatches,
  findSeed,
  lineCount,
  lineInputDigits,
  lineStartOffset,
  nextMatch,
  replacementChanges,
  type TextMatch,
} from "../findReplace";
import { translateWith, useLang, useT } from "../i18n";
import { documentToMarkdown, eolOf, normalizeEol, restoreEol } from "../markdown";
import { isImeKeyEvent } from "../modalBehavior";
import { type FindMode, useStore } from "../store";
import { focusChunkRange } from "./ChunkView";
import { markdownSourceBridge } from "./MarkdownEditor";
import Tooltip from "./Tooltip";

type State = ReturnType<typeof useStore.getState>;
type Dir = "next" | "prev";

type Located =
  | { kind: "unavailable" }
  | { kind: "markdown"; text: string; matches: TextMatch[] }
  | { kind: "chunks"; hits: ChunkMatch[]; matches: TextMatch[] };

/** The searchable text of the current view and its matches. While the
 *  CodeMirror source is mounted its own text is searched, so offsets are
 *  CodeMirror positions (it normalises CRLF). */
function locate(s: State): Located {
  const mode = s.doc.mode ?? "editor";
  if (findAvailability(mode) !== "available") return { kind: "unavailable" };
  const opts = { caseSensitive: s.find.caseSensitive, wholeWord: s.find.wholeWord };
  if (mode === "markdown") {
    const view = markdownSourceBridge.view();
    // No view mounted (Preview): search the LF-normalized source, so offsets
    // are the CodeMirror positions `select` uses once Split mounts it.
    const text = view ? view.state.doc.toString() : normalizeEol(documentToMarkdown(s.doc));
    return { kind: "markdown", text, matches: findMatches(text, s.find.query, opts) };
  }
  const hits = findInChunks(s.doc.chunks, s.find.query, opts);
  return { kind: "chunks", hits, matches: hits.map((h) => ({ from: h.docFrom, to: h.docTo })) };
}

/** Run `fn` once the source view exists (Preview → Split mounts it a render later). */
function whenSourceMounted(fn: () => void, frames = 10) {
  if (markdownSourceBridge.view() || frames <= 0) {
    fn();
    return;
  }
  requestAnimationFrame(() => whenSourceMounted(fn, frames - 1));
}

/** The textarea of a chunk, for its caret (find starts from the caret). */
function chunkTextarea(id: string): HTMLTextAreaElement | null {
  return document.querySelector(`[data-chunk-id="${CSS.escape(id)}"] textarea`);
}

/** Where a search with no current match starts: the editor selection's end
 *  (next) or start (previous), so ⌘G after closing the bar on a match moves
 *  on instead of re-selecting it. */
function startCaret(s: State, dir: Dir): number {
  const id = s.focusedChunkId;
  if (!id) return 0;
  const el = chunkTextarea(id);
  const at = (dir === "next" ? el?.selectionEnd : el?.selectionStart) ?? 0;
  return chunkDocOffset(s.doc.chunks, id, at);
}

/** Make match `i` the current one: selected, highlighted, scrolled into view. */
function goTo(loc: Exclude<Located, { kind: "unavailable" }>, i: number) {
  const { setFind } = useStore.getState();
  if (i < 0) {
    setFind({ current: -1, hit: null });
    return;
  }
  if (loc.kind === "chunks") {
    const h = loc.hits[i];
    setFind({ current: i, hit: { chunkId: h.chunkId, from: h.from, to: h.to } });
    return;
  }
  const m = loc.matches[i];
  setFind({ current: i, hit: null });
  if (!markdownSourceBridge.select(m.from, m.to)) {
    markdownSourceBridge.show();
    whenSourceMounted(() => markdownSourceBridge.select(m.from, m.to));
  }
}

/** The caret the next/previous search moves from: the current match. */
function caretFor(s: State, loc: Exclude<Located, { kind: "unavailable" }>, dir: Dir): number {
  if (loc.kind === "chunks") {
    const hit = s.find.hit;
    if (hit && loc.hits.some((h) => h.chunkId === hit.chunkId)) {
      return chunkDocOffset(s.doc.chunks, hit.chunkId, dir === "next" ? hit.to : hit.from);
    }
    return startCaret(s, dir);
  }
  const view = markdownSourceBridge.view();
  if (view) {
    const sel = view.state.selection.main;
    return dir === "next" ? sel.to : sel.from;
  }
  const cur = loc.matches[s.find.current];
  return cur ? (dir === "next" ? cur.to : cur.from) : 0;
}

function step(dir: Dir) {
  const s = useStore.getState();
  const loc = locate(s);
  if (loc.kind === "unavailable") return;
  goTo(loc, nextMatch(loc.matches, caretFor(s, loc, dir), dir));
}

/** The editor selection, as a find query (single line only). */
function selectionSeed(): string | null {
  const view = markdownSourceBridge.view();
  if (view?.hasFocus) {
    const r = view.state.selection.main;
    return findSeed(view.state.sliceDoc(r.from, r.to));
  }
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.closest("[data-find-bar]") || el.closest('[role="dialog"]')) return null;
    const a = el.selectionStart ?? 0;
    const b = el.selectionEnd ?? a;
    return findSeed(el.value.slice(a, b));
  }
  return findSeed(window.getSelection()?.toString() ?? "");
}

/** Open the bar (⌘F, ⌥⌘F, ⌘L, menu, palette), prefilled with the selection. */
export function openFindBar(mode: FindMode) {
  useStore.getState().openFind(mode, mode === "line" ? null : selectionSeed());
}

/** Find Next / Previous (⌘G, ⇧⌘G). With no query yet it opens Find instead. */
export function findStep(dir: Dir) {
  const s = useStore.getState();
  if (!s.find.query) {
    openFindBar("find");
    return;
  }
  if (!s.find.open) s.openFind("find", null);
  step(dir);
}

/** Replace the current match, then move to the next one. With no current
 *  match yet, the first press only selects one. */
function replaceCurrent() {
  const s = useStore.getState();
  const loc = locate(s);
  if (loc.kind === "unavailable" || !s.find.query) return;
  const replacement = s.find.replacement;
  if (loc.kind === "chunks") {
    const hit = s.find.hit;
    const live = hit && loc.hits.find((h) => h.chunkId === hit.chunkId && h.from === hit.from && h.to === hit.to);
    if (!live) {
      step("next");
      return;
    }
    if (!s.replaceMatchInChunk(live.chunkId, live.from, live.to, replacement)) return;
    useStore.getState().setFind({ replacePending: true });
    const after = useStore.getState();
    const next = locate(after);
    if (next.kind !== "chunks") return;
    const caret = chunkDocOffset(after.doc.chunks, live.chunkId, live.from + replacement.length);
    goTo(next, nextMatch(next.matches, caret, "next"));
    return;
  }
  const view = markdownSourceBridge.view();
  const sel = view?.state.selection.main;
  const cur = view
    ? loc.matches.find((m) => m.from === sel?.from && m.to === sel?.to)
    : loc.matches[s.find.current];
  if (!cur) {
    step("next");
    return;
  }
  const change = { from: cur.from, to: cur.to, insert: replacement };
  if (!markdownSourceBridge.replace([change], false)) {
    s.setMarkdownSource(restoreEol(applyChanges(loc.text, [change]), eolOf(documentToMarkdown(s.doc))), {
      newUndoStep: true,
    });
  }
  useStore.getState().setFind({ replacePending: true });
  const next = locate(useStore.getState());
  if (next.kind !== "markdown") return;
  goTo(next, nextMatch(next.matches, cur.from + replacement.length, "next"));
}

/** Replace every match as one undo step; returns the count. */
function replaceEverything(): number {
  const s = useStore.getState();
  const loc = locate(s);
  const { query, replacement, caseSensitive, wholeWord } = s.find;
  if (loc.kind === "unavailable" || !query) return 0;
  const opts = { caseSensitive, wholeWord };
  let count: number;
  if (loc.kind === "chunks") {
    count = s.replaceAllInChunks(query, replacement, opts);
  } else {
    const changes = replacementChanges(loc.text, query, replacement, opts);
    count = changes.length;
    if (!markdownSourceBridge.replace(changes, true)) {
      count = s.replaceAllInMarkdown(query, replacement, opts);
    }
  }
  s.setFind({ current: -1, hit: null, replacePending: count > 0 });
  return count;
}

/** Close the bar and give focus back to the editor, on the current match. */
function closeAndReturnFocus() {
  const s = useStore.getState();
  const hit = s.find.hit;
  const mode = s.doc.mode ?? "editor";
  s.closeFind();
  if (mode === "markdown") {
    markdownSourceBridge.view()?.focus();
  } else if (mode === "editor") {
    if (hit) focusChunkRange(hit.chunkId, hit.from, hit.to);
    else if (s.focusedChunkId) focusChunkRange(s.focusedChunkId);
  }
}

function goToLine(line: number) {
  const s = useStore.getState();
  if ((s.doc.mode ?? "editor") !== "markdown") return;
  const jump = () => {
    const view = markdownSourceBridge.view();
    if (!view) return;
    const at = lineStartOffset(view.state.doc.toString(), line);
    markdownSourceBridge.select(at, at, true);
  };
  s.closeFind();
  if (markdownSourceBridge.view()) jump();
  else {
    markdownSourceBridge.show();
    whenSourceMounted(jump);
  }
}

/** Buttons keep focus in the field, so Enter / Esc keep working after a
 *  click (the click itself still fires). */
const keepFieldFocus = (e: MouseEvent) => e.preventDefault();

const btn =
  "rounded border border-chrome-edge bg-white px-2 py-1 text-xs text-ink-soft hover:bg-chrome-hairline disabled:cursor-not-allowed disabled:opacity-40";
const iconBtn =
  "flex h-6 min-w-[1.5rem] items-center justify-center rounded px-1 text-xs text-ink-soft hover:bg-chrome-line disabled:opacity-40";
const field =
  "h-7 min-w-0 rounded border border-chrome-edge bg-white px-2 text-xs text-ink outline-none focus:border-accent";

export default function FindBar() {
  const t = useT();
  const lang = useLang();
  const find = useStore((s) => s.find);
  const setFind = useStore((s) => s.setFind);
  const docMode = useStore((s) => s.doc.mode ?? "editor");
  // Re-locate whenever the searched text changes.
  const chunks = useStore((s) => s.doc.chunks);
  const source = useStore((s) => (s.doc.mode === "markdown" ? documentToMarkdown(s.doc) : ""));
  const queryRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const [replaced, setReplaced] = useState<number | null>(null);
  const [line, setLine] = useState("");

  const available = findAvailability(docMode) === "available";
  const loc = useMemo<Located>(
    () => (find.open ? locate(useStore.getState()) : { kind: "unavailable" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [find.open, find.query, find.caseSensitive, find.wholeWord, chunks, source, docMode]
  );
  const total = loc.kind === "unavailable" ? 0 : loc.matches.length;

  // Focus the field on every open (⌘F again re-focuses an open bar). A frame
  // later, so a closing palette's focus restore cannot steal it back.
  useEffect(() => {
    if (!find.open) return;
    if (docMode === "markdown") markdownSourceBridge.show();
    const frame = requestAnimationFrame(() => {
      const el = find.mode === "line" ? lineRef.current : queryRef.current;
      el?.focus();
      el?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [find.open, find.focusNonce, find.mode, docMode]);

  // Edits can move or remove the current match: keep `current` pointing at it.
  useEffect(() => {
    if (!find.open || loc.kind === "unavailable") return;
    const s = useStore.getState();
    if (loc.kind === "chunks") {
      const hit = s.find.hit;
      const i = hit ? loc.hits.findIndex((h) => h.chunkId === hit.chunkId && h.from === hit.from && h.to === hit.to) : -1;
      if (i !== s.find.current || (i < 0 && hit)) setFind({ current: i, hit: i < 0 ? null : hit });
    } else {
      // Markdown: the current match is the source selection, if it is one.
      const sel = markdownSourceBridge.view()?.state.selection.main;
      const i = sel ? loc.matches.findIndex((m) => m.from === sel.from && m.to === sel.to) : -1;
      if (i !== s.find.current) setFind({ current: i });
    }
  }, [loc, find.open, setFind]);

  useEffect(() => setReplaced(null), [find.query, find.replacement, find.open]);

  if (!find.open) return null;

  const close = () => closeAndReturnFocus();
  const unavailable = !available
    ? t("Find in Slides is planned — switch to Editor or Markdown to search.")
    : find.mode === "line" && docMode !== "markdown"
      ? t("Go to Line works in Markdown source — switch to Markdown to use it.")
      : null;

  const status =
    replaced !== null
      ? replaced > 0
        ? translateWith("Replaced {n}.", lang, { n: replaced })
        : t("No matches")
      : !find.query
        ? ""
        : total === 0
          ? t("No matches")
          : find.current >= 0
            ? `${find.current + 1} / ${total}`
            : translateWith("{n} matches", lang, { n: total });

  const closeButton = (
    <Tooltip label={t("Close find bar (Esc)")}>
      <button onMouseDown={keepFieldFocus} type="button" onClick={close} aria-label={t("Close find bar (Esc)")} className={`${iconBtn} ml-auto`}>
        ✕
      </button>
    </Tooltip>
  );

  return (
    <div
      role="search"
      aria-label={t("Find and replace")}
      data-find-bar="true"
      onKeyDown={(e) => {
        // Esc from a toggle reached with Tab (the fields handle their own).
        if (isImeKeyEvent(e.nativeEvent) || e.defaultPrevented) return;
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      className="flex shrink-0 flex-col gap-1 border-b border-chrome-line bg-chrome px-3 py-1.5 font-sans text-xs text-ink-soft"
    >
      {unavailable ? (
        <div className="flex items-center gap-2">
          <span role="status">{unavailable}</span>
          {closeButton}
        </div>
      ) : find.mode === "line" ? (
        <div className="flex items-center gap-2">
          <input
            ref={lineRef}
            inputMode="numeric"
            value={line}
            // Full-width digits (IME) are folded after the composition ends —
            // rewriting the value mid-composition would break the IME.
            onChange={(e) => {
              const v = e.target.value;
              setLine((e.nativeEvent as InputEvent).isComposing ? v : lineInputDigits(v));
            }}
            onCompositionEnd={(e) => setLine(lineInputDigits(e.currentTarget.value))}
            onKeyDown={(e) => {
              if (isImeKeyEvent(e.nativeEvent)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                if (line) goToLine(Number(line));
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            aria-label={t("Line number")}
            placeholder={t("Line number")}
            className={`${field} w-28`}
          />
          <button onMouseDown={keepFieldFocus} type="button" className={btn} disabled={!line} onClick={() => goToLine(Number(line))}>
            {t("Go")}
          </button>
          <span className="text-ink-faint">
            {translateWith("Lines 1–{total}", lang, {
              total: lineCount(loc.kind === "markdown" ? loc.text : source),
            })}
          </span>
          {closeButton}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <Tooltip label={find.mode === "replace" ? t("Hide replace") : t("Show replace (⌥⌘F)")}>
              <button onMouseDown={keepFieldFocus}
                type="button"
                aria-label={find.mode === "replace" ? t("Hide replace") : t("Show replace (⌥⌘F)")}
                aria-expanded={find.mode === "replace"}
                onClick={() => useStore.getState().openFind(find.mode === "replace" ? "find" : "replace", null)}
                className={iconBtn}
              >
                {find.mode === "replace" ? "▾" : "▸"}
              </button>
            </Tooltip>
            <input
              ref={queryRef}
              value={find.query}
              onChange={(e) => setFind({ query: e.target.value, current: -1, hit: null })}
              onKeyDown={(e) => {
                if (isImeKeyEvent(e.nativeEvent)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? "prev" : "next");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
              aria-label={t("Find")}
              placeholder={t("Find")}
              spellCheck={false}
              className={`${field} w-56`}
            />
            <Tooltip label={t("Match case")}>
              <button onMouseDown={keepFieldFocus}
                type="button"
                aria-label={t("Match case")}
                aria-pressed={find.caseSensitive}
                onClick={() => setFind({ caseSensitive: !find.caseSensitive, current: -1, hit: null })}
                className={`${iconBtn} ${find.caseSensitive ? "bg-accent/10 text-accent" : ""}`}
              >
                {"Aa"}
              </button>
            </Tooltip>
            <Tooltip label={t("Whole word")}>
              <button onMouseDown={keepFieldFocus}
                type="button"
                aria-label={t("Whole word")}
                aria-pressed={find.wholeWord}
                onClick={() => setFind({ wholeWord: !find.wholeWord, current: -1, hit: null })}
                className={`${iconBtn} underline decoration-dotted ${find.wholeWord ? "bg-accent/10 text-accent" : ""}`}
              >
                {"ab"}
              </button>
            </Tooltip>
            <span role="status" aria-live="polite" className="min-w-[5rem] px-1 tabular-nums text-ink-faint">
              {status}
            </span>
            <Tooltip label={t("Previous match (⇧Enter / ⇧⌘G)")}>
              <button onMouseDown={keepFieldFocus}
                type="button"
                aria-label={t("Previous match (⇧Enter / ⇧⌘G)")}
                disabled={total === 0}
                onClick={() => step("prev")}
                className={iconBtn}
              >
                ↑
              </button>
            </Tooltip>
            <Tooltip label={t("Next match (Enter / ⌘G)")}>
              <button onMouseDown={keepFieldFocus}
                type="button"
                aria-label={t("Next match (Enter / ⌘G)")}
                disabled={total === 0}
                onClick={() => step("next")}
                className={iconBtn}
              >
                ↓
              </button>
            </Tooltip>
            {closeButton}
          </div>
          {find.mode === "replace" && (
            <div className="flex items-center gap-1.5 pl-[1.875rem]">
              <input
                value={find.replacement}
                onChange={(e) => setFind({ replacement: e.target.value })}
                onKeyDown={(e) => {
                  if (isImeKeyEvent(e.nativeEvent)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    replaceCurrent();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                  }
                }}
                aria-label={t("Replace with")}
                placeholder={t("Replace with")}
                spellCheck={false}
                className={`${field} w-56`}
              />
              <button onMouseDown={keepFieldFocus} type="button" className={btn} disabled={total === 0} onClick={replaceCurrent}>
                {t("Replace")}
              </button>
              <button onMouseDown={keepFieldFocus}
                type="button"
                className={btn}
                disabled={total === 0}
                onClick={() => setReplaced(replaceEverything())}
              >
                {t("Replace All")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
