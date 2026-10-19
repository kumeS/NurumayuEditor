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
// - Markdown mode: matches are located in the store's source (LF-normalized,
//   so offsets are CodeMirror positions); the CodeMirror view
//   (markdownSourceBridge) only selects and replaces (BUG-002, QA 20261003).
//   Opening the bar from the Preview switches to Split so matches are
//   visible; replaces are ONE isolated CodeMirror transaction that the update
//   listener commits as its own store undo step. Go to Line works here only,
//   and only for a line in 1..N (`parseLineNumber`, BUG-004, QA 20261003).
// - "Replaced N." is shown only while the searched text and the find options
//   are the ones Replace All left; any later undo / redo / edit, or a Match
//   case / Whole word toggle, shows the live matches again (BUG-002, C13).
// - A match that already reads the replacement is not replaced: Replace
//   moves past it, an all-identity Replace All says "Nothing to change.", and
//   ⌘Z in the bar is armed only by a replace that changed the store (C12).
// - Slides mode: planned — the bar says so instead of searching.
// Focus stays in the bar while stepping (Enter / ⇧Enter, ⌘G / ⇧⌘G); Esc
// (IME-safe) closes it and returns focus to the editor on the current match.
// A button press keeps focus where it is only when focus is already in the
// bar; from a Markdown Preview block it blurs that block first, which commits
// its typed text before the replace runs (C11). C11–C14: review follow-up,
// QA 20261003.

import { type MouseEvent, type ReactNode, type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import type { EditorState } from "@codemirror/state";
import {
  applyChanges,
  type ChunkMatch,
  chunkDocOffset,
  chunkSearchText,
  findAvailability,
  findInChunks,
  findMatches,
  findSeed,
  freshReplaceReport,
  isNoOpChange,
  lineCount,
  lineStartOffset,
  nextMatch,
  parseLineNumber,
  type ReplaceReport,
  replacementChanges,
  type TextMatch,
} from "../findReplace";
import { translateWith, type UiLang, useLang, useT } from "../i18n";
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
  | { kind: "chunks"; text: string; hits: ChunkMatch[]; matches: TextMatch[] };

/** The text a location searched ("" when find is unavailable). */
const searchedText = (loc: Located): string => (loc.kind === "unavailable" ? "" : loc.text);

/** The searchable text of the current view and its matches. Markdown mode
 *  searches the STORE's source, LF-normalized, so offsets are the CodeMirror
 *  positions `select` uses. Never the mounted view's own text: after a store
 *  undo / redo MarkdownEditor syncs the view in a (layout) effect, i.e.
 *  after this bar has rendered and re-located, and nothing re-renders the bar
 *  once it has — so reading the view found the pre-undo text (BUG-002, QA
 *  20261003). */
export function locate(s: State): Located {
  const mode = s.doc.mode ?? "editor";
  if (findAvailability(mode) !== "available") return { kind: "unavailable" };
  const opts = { caseSensitive: s.find.caseSensitive, wholeWord: s.find.wholeWord };
  if (mode === "markdown") {
    const text = normalizeEol(documentToMarkdown(s.doc));
    return { kind: "markdown", text, matches: findMatches(text, s.find.query, opts) };
  }
  const hits = findInChunks(s.doc.chunks, s.find.query, opts);
  return {
    kind: "chunks",
    text: chunkSearchText(s.doc.chunks),
    hits,
    matches: hits.map((h) => ({ from: h.docFrom, to: h.docTo })),
  };
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

/** Whether the mounted source view shows `text` (the LF store text a
 *  location searched): its selection and offsets mean nothing for any other
 *  text (C11 defense in depth, review follow-up, QA 20261003). */
function viewShows<V extends { readonly state: EditorState }>(view: V | null, text: string): view is V {
  return view !== null && view.state.doc.toString() === text;
}

/** Index of the match the source view's selection is exactly on, or -1 —
 *  and -1 while the view does not show the searched text yet (C14, review
 *  follow-up, QA 20261003; the view syncs in a layout effect, see FindBar's
 *  [loc] effect). */
export function selectedSourceMatch(
  view: { readonly state: EditorState } | null,
  loc: { text: string; matches: readonly TextMatch[] }
): number {
  if (!viewShows(view, loc.text)) return -1;
  const sel = view.state.selection.main;
  return loc.matches.findIndex((m) => m.from === sel.from && m.to === sel.to);
}

/** Whether the store's document changed since `before`, i.e. a replace made
 *  an undo step for ⌘Z in the bar to undo (C12, review follow-up, QA
 *  20261003). Doc identity, not past.length: that saturates at the history cap. */
const docChangedSince = (before: State): boolean => useStore.getState().doc !== before.doc;

/** Replace the current match, then move to the next one. With no current
 *  match yet, the first press only selects one. A match that already reads
 *  the replacement is moved past, not rewritten, and ⌘Z in the bar is armed
 *  only when the store really changed (C12). Never blurs anything: the press
 *  already committed a Preview edit (keepFieldFocus, C11). */
export function replaceCurrent() {
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
    const noOp = isNoOpChange(loc.text, { from: live.docFrom, to: live.docTo, insert: replacement });
    if (!noOp && !s.replaceMatchInChunk(live.chunkId, live.from, live.to, replacement)) return;
    if (docChangedSince(s)) useStore.getState().setFind({ replacePending: true });
    const after = useStore.getState();
    const next = locate(after);
    if (next.kind !== "chunks") return;
    const caret = chunkDocOffset(after.doc.chunks, live.chunkId, live.from + replacement.length);
    goTo(next, nextMatch(next.matches, caret, "next"));
    return;
  }
  const view = markdownSourceBridge.view();
  // A view still showing other text has its selection in other offsets (-1).
  const cur = view ? loc.matches[selectedSourceMatch(view, loc)] : loc.matches[s.find.current];
  if (!cur) {
    step("next");
    return;
  }
  const change = { from: cur.from, to: cur.to, insert: replacement };
  if (!isNoOpChange(loc.text, change) && !markdownSourceBridge.replace([change], false)) {
    s.setMarkdownSource(restoreEol(applyChanges(loc.text, [change]), eolOf(documentToMarkdown(s.doc))), {
      newUndoStep: true,
    });
  }
  if (docChangedSince(s)) useStore.getState().setFind({ replacePending: true });
  const next = locate(useStore.getState());
  if (next.kind !== "markdown") return;
  goTo(next, nextMatch(next.matches, cur.from + replacement.length, "next"));
}

/** Replace every match as one undo step; returns how many matches it
 *  changed and the search it leaves (text + options: the report is shown only
 *  while both are current, BUG-002 / C13). Matches that already read the
 *  replacement are not changes (`replacementChanges`), so an all-identity
 *  Replace All changes nothing, reports 0 and does not arm ⌘Z in the bar —
 *  an earlier replace that armed it stays the latest step (C12, review
 *  follow-up, QA 20261003). Never blurs anything (C11, see keepFieldFocus). */
export function replaceEverything(): ReplaceReport {
  const s = useStore.getState();
  const loc = locate(s);
  const { query, replacement, caseSensitive, wholeWord } = s.find;
  const opts = { caseSensitive, wholeWord };
  if (loc.kind === "unavailable" || !query) return { count: 0, text: searchedText(loc), ...opts };
  let count: number;
  if (loc.kind === "chunks") {
    count = s.replaceAllInChunks(query, replacement, opts);
  } else {
    const changes = replacementChanges(loc.text, query, replacement, opts);
    count = changes.length;
    // The view takes the change list only while it shows the searched text
    // (else, or with no view, the store applies it; the view then syncs).
    const view = markdownSourceBridge.view();
    if (count > 0 && !(viewShows(view, loc.text) && markdownSourceBridge.replace(changes, true))) {
      count = s.replaceAllInMarkdown(query, replacement, opts);
    }
  }
  const changed = docChangedSince(s);
  s.setFind({ current: -1, hit: null, ...(changed ? { replacePending: true } : {}) });
  // Both paths update the store synchronously (CodeMirror's update listener
  // commits the replace), so this is the text the next render searches.
  return { count: changed ? count : 0, text: searchedText(locate(useStore.getState())), ...opts };
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

/** Jump to a line that `parseLineNumber` accepted (1..N). */
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

/**
 * Whether a press on a find-bar button keeps focus where it is (C11, review
 * follow-up, QA 20261003): only when focus is already in the bar, so Enter /
 * Esc keep working in the field after a click (the click itself still
 * fires). A press that starts anywhere else blurs natively: a Markdown
 * Preview block or draft commits its typed text on that blur, and the store
 * update, its render and the source view's layout-effect sync all finish
 * before the click runs the replace. Claiming that press (preventDefault)
 * kept the block focused and uncommitted, and the replace remounted it —
 * the typed text was lost. The replace handlers must not blur instead:
 * React renders only after the click handler returns, so the source view
 * would still show the old text and its write-back would undo the commit.
 * The predicate and the handler's shape are guarded (findBarRender /
 * findBarWiring tests); that WKWebView blurs the block on a button press and
 * renders before the click is NOT guarded by this suite (no DOM) — manual QA
 * in the installed app. After a press from outside the bar, focus does not
 * move into the bar (WebKit leaves it on the page body).
 */
export function keepsFocusOnPress(active: unknown): boolean {
  const el = (active ?? null) as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && Boolean(el.closest("[data-find-bar]"));
}

/** onMouseDown of every find-bar button (findBarWiring.test.ts). */
const keepFieldFocus = (e: MouseEvent) => {
  if (keepsFocusOnPress(document.activeElement)) e.preventDefault();
};

/**
 * The bar's status line. `report` is the FRESH Replace All report
 * (freshReplaceReport) or null. A report that changed nothing — every match
 * already read the replacement — says so while those matches are still live
 * (C12), never "No matches" next to enabled buttons. `t` / `lang` are
 * parameters so this runs without the store (findBarRender.test.ts).
 */
export function findStatus(
  { report, query, total, current }: { report: ReplaceReport | null; query: string; total: number; current: number },
  t: (key: string) => string,
  lang: UiLang
): string {
  if (report !== null) {
    if (report.count > 0) return translateWith("Replaced {n}.", lang, { n: report.count });
    return total > 0 ? t("Nothing to change.") : t("No matches");
  }
  if (!query) return "";
  if (total === 0) return t("No matches");
  return current >= 0 ? `${current + 1} / ${total}` : translateWith("{n} matches", lang, { n: total });
}

const btn =
  "rounded border border-chrome-edge bg-white px-2 py-1 text-xs text-ink-soft hover:bg-chrome-hairline disabled:cursor-not-allowed disabled:opacity-40";
const iconBtn =
  "flex h-6 min-w-[1.5rem] items-center justify-center rounded px-1 text-xs text-ink-soft hover:bg-chrome-line disabled:opacity-40";
const field =
  "h-7 min-w-0 rounded border border-chrome-edge bg-white px-2 text-xs text-ink outline-none focus:border-accent";

/**
 * The Go to Line row (BUG-004, QA 20261003). The field keeps exactly what was
 * typed — nothing is stripped or rewritten, so an IME composition is never
 * disturbed — and `parseLineNumber` decides: Go (button or Enter) acts only
 * on a line in 1..total, never a clamped one. Anything else disables Go and
 * says why next to the field, which is aria-invalid and described by that
 * message; an empty field only disables Go. `t` / `lang` are props so the
 * row renders without the store (findBarRender.test.ts).
 */
export function GoToLineField({
  value,
  total,
  onValue,
  onClose,
  inputRef,
  closeButton,
  t,
  lang,
}: {
  value: string;
  total: number;
  onValue: (value: string) => void;
  onClose: () => void;
  inputRef?: Ref<HTMLInputElement>;
  closeButton?: ReactNode;
  t: (key: string) => string;
  lang: UiLang;
}) {
  const descriptionId = useId();
  const check = parseLineNumber(value, total);
  const invalid = !check.ok && check.reason !== "empty";
  const go = () => {
    if (check.ok) goToLine(check.line);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        inputMode="numeric"
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKeyEvent(e.nativeEvent)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            go();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        aria-label={t("Line number")}
        aria-invalid={invalid}
        aria-describedby={descriptionId}
        placeholder={t("Line number")}
        className={`${field} w-28`}
      />
      <button onMouseDown={keepFieldFocus} type="button" className={btn} disabled={!check.ok} onClick={go}>
        {t("Go")}
      </button>
      <span id={descriptionId} aria-live="polite" className={invalid ? "text-danger" : "text-ink-faint"}>
        {invalid
          ? translateWith("Enter a whole number from 1 to {total}.", lang, { total })
          : translateWith("Lines 1–{total}", lang, { total })}
      </span>
      {closeButton}
    </div>
  );
}

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
  const [replaced, setReplaced] = useState<ReplaceReport | null>(null);
  const [line, setLine] = useState("");

  const available = findAvailability(docMode) === "available";
  const loc = useMemo<Located>(
    () => (find.open ? locate(useStore.getState()) : { kind: "unavailable" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [find.open, find.query, find.caseSensitive, find.wholeWord, chunks, source, docMode]
  );
  const total = loc.kind === "unavailable" ? 0 : loc.matches.length;
  // "Replaced N." describes only the text Replace All left: an undo, redo or
  // edit after it shows the live matches again (BUG-002, QA 20261003).
  const report = freshReplaceReport(replaced, searchedText(loc), {
    caseSensitive: find.caseSensitive,
    wholeWord: find.wholeWord,
  });

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
      // This is a PASSIVE effect and MarkdownEditor syncs the view from the
      // store in a LAYOUT effect, which React runs first for the whole
      // commit: after a store undo / redo the view already shows the searched
      // text here, its selection mapped onto it, so a selected match reads
      // "k / N" (C14, review follow-up, QA 20261003). The check stays for a
      // view that does not show it (BUG-002).
      const i = selectedSourceMatch(markdownSourceBridge.view(), loc);
      if (i !== s.find.current) setFind({ current: i });
    }
  }, [loc, find.open, setFind]);

  useEffect(() => setReplaced(null), [find.query, find.replacement, find.open]);
  // One-shot: a stale report is dropped, so a redo back to the replaced text
  // shows its matches (none), not a revived "Replaced N.".
  useEffect(() => {
    if (replaced !== null && report === null) setReplaced(null);
  }, [replaced, report]);

  if (!find.open) return null;

  const close = () => closeAndReturnFocus();
  const unavailable = !available
    ? t("Find in Slides is planned — switch to Editor or Markdown to search.")
    : find.mode === "line" && docMode !== "markdown"
      ? t("Go to Line works in Markdown source — switch to Markdown to use it.")
      : null;

  const status = findStatus({ report, query: find.query, total, current: find.current }, t, lang);

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
        <GoToLineField
          value={line}
          onValue={setLine}
          total={lineCount(searchedText(loc))}
          onClose={close}
          inputRef={lineRef}
          closeButton={closeButton}
          t={t}
          lang={lang}
        />
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
            <span role="status" aria-live="polite" title={status} className="w-[9.5rem] shrink-0 truncate whitespace-nowrap px-1 tabular-nums text-ink-faint">
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
