import { describe, expect, it } from "vitest";
import { history, historyKeymap, isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorState, type Extension, Transaction } from "@codemirror/state";
import { findStatus, locate, selectedSourceMatch } from "./components/FindBar";
import { FIND_REPLACE_EVENT } from "./components/MarkdownEditor";
import type { TextChange } from "./findReplace";
import { documentToMarkdown, eolOf, normalizeEol, restoreEol } from "./markdown";
import { createHistoryReset, minimalChange, onlyStoreSync, type SourceViewLike, syncFromStore } from "./sourceHistory";
import { useStore } from "./store";
import type { Document } from "./types";

// QA 20261003 follow-up: the store → view sync of the Markdown source never
// leaves anything in CodeMirror's history that a later ⌘Z in the source could
// use to re-apply what the store undid. No DOM here: EditorState plus a tiny
// "view" mounted exactly like MarkdownEditor's (history() + the reset slot),
// and, for the round trips, the REAL store. Real keydown handling in
// WKWebView is manual QA.

const st = () => useStore.getState();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const depths = (s: EditorState) => ({ undoDepth: undoDepth(s), redoDepth: redoDepth(s) });

/** A typing transaction at `at` (default: the end), its own history event. */
function typing(s: EditorState, insert: string, time: number, at = s.doc.length) {
  return s.update({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    userEvent: "input.type",
    annotations: Transaction.time.of(time),
  });
}

/** Every occurrence of `query` → `replacement`, as the find bar computes it. */
function replaceAllChanges(text: string, query: string, replacement: string): TextChange[] {
  const changes: TextChange[] = [];
  for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) {
    changes.push({ from: i, to: i + query.length, insert: replacement });
  }
  return changes;
}

/** markdownSourceBridge.replace's transaction (guarded in findBarWiring.test.ts). */
function bridgeReplace(s: EditorState, changes: TextChange[]) {
  return s.update({
    changes: [...changes],
    annotations: isolateHistory.of("full"),
    userEvent: `${FIND_REPLACE_EVENT}.all`,
  });
}

/** A view mounted with `extensions`; `onDispatch` sees every transaction. */
function viewOf(doc: string, extensions: Extension, onDispatch: (tr: Transaction) => void = () => {}) {
  let state = EditorState.create({ doc, extensions });
  const view: SourceViewLike & { dispatched: Transaction[] } = {
    dispatched: [],
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
      view.dispatched.push(tr);
      onDispatch(tr);
    },
  };
  return view;
}

/** MarkdownEditor's history extensions: history() plus the reset slot. */
function mounted(doc: string, onDispatch?: (tr: Transaction) => void) {
  const reset = createHistoryReset();
  return { view: viewOf(doc, [history(), reset.extension], onDispatch), reset };
}

describe("premises (why the sync is what it is)", () => {
  // The defect itself: with the old [source] effect, ⌘Z in the source after a
  // store undo re-applied the replacement the store had just undone. (These
  // premises pin CodeMirror's behaviour: they fail if an upgrade changes it,
  // which would make the sync's design moot or insufficient.)
  it("the old sync — a RECORDED full-document dispatch — can be undone by CodeMirror and re-applies the external change", () => {
    let s = EditorState.create({ doc: "猫が好き。\n猫も。", extensions: history() });
    s = bridgeReplace(s, replaceAllChanges(s.doc.toString(), "猫", "犬")).state;
    expect(s.doc.toString()).toBe("犬が好き。\n犬も。");
    // Find-bar ⌘Z undid the replace in the store; the old effect then did:
    s = s.update({ changes: { from: 0, to: s.doc.length, insert: "猫が好き。\n猫も。" } }).state;
    undo({ state: s, dispatch: (tr) => (s = tr.state) });
    expect(s.doc.toString()).toBe("犬が好き。\n犬も。");
  });

  it("an unrecorded sync alone is not enough: CodeMirror keeps the older events (they no longer describe the text)", () => {
    let s = EditorState.create({ doc: "猫が好き。", extensions: history() });
    s = typing(s, "猫も。", 1000).state;
    s = bridgeReplace(s, replaceAllChanges(s.doc.toString(), "猫", "犬")).state;
    s = s.update({ changes: { from: 0, to: 1, insert: "猫" }, annotations: Transaction.addToHistory.of(false) }).state;
    expect(undoDepth(s)).toBe(2);
  });

  it("reconfiguring a compartment to history() KEEPS the old events (same field) — so the reset re-initialises the field instead", () => {
    const c = new Compartment();
    let s = EditorState.create({ doc: "", extensions: c.of(history()) });
    s = typing(typing(s, "a", 1000).state, "b", 3000).state;
    s = s.update({ effects: c.reconfigure(history()) }).state;
    expect(undoDepth(s)).toBe(2);
  });

  // Why sourceHistoryWiring.test.ts insists the slot is mounted: a reset
  // whose compartment is not in the state is silently ignored.
  it("the reset only works when its slot is mounted next to history()", () => {
    const unmounted = createHistoryReset();
    const v = viewOf("猫", history());
    v.dispatch(typing(v.state, "犬", 1000));
    // (A sync that deleted the typed text would drop its event by mapping.)
    expect(syncFromStore(v, unmounted, "猫犬です")).toBe(true);
    expect(undoDepth(v.state)).toBe(1);
    const { view, reset } = mounted("猫");
    view.dispatch(typing(view.state, "犬", 1000));
    syncFromStore(view, reset, "猫犬です");
    expect(undoDepth(view.state)).toBe(0);
  });
});

describe("MarkdownEditor's configuration: history() + the reset slot", () => {
  // Fails if the slot stops being the same history field (e.g. a second,
  // separate history) or starts non-empty.
  it("mounts one empty history that records typing and runs undo/redo as before", () => {
    const { view } = mounted("# 題\n");
    expect(depths(view.state)).toEqual({ undoDepth: 0, redoDepth: 0 });
    view.dispatch(typing(view.state, "本文", 1000));
    view.dispatch(typing(view.state, "です", 3000));
    expect(undoDepth(view.state)).toBe(2);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("# 題\n本文");
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("# 題\n本文です");
  });

  // Fails if a @codemirror/commands upgrade drops `preventDefault` from these
  // bindings: an empty-history ⌘Z would then fall through to WebKit's native
  // contentEditable undo, and the source would need its own swallow entry
  // after historyKeymap. (That @codemirror/view then marks such a binding
  // handled — and preventDefaults the key — even when its command returns
  // false was read in @codemirror/view 6.43.7; it needs a DOM, so it is not
  // tested here.)
  it("⌘Z / ⇧⌘Z on an empty history: undo/redo return false, and historyKeymap still claims the keys (preventDefault)", () => {
    const { view } = mounted("x");
    expect(undo(view)).toBe(false);
    expect(redo(view)).toBe(false);
    const undoKey = historyKeymap.find((b) => b.key === "Mod-z");
    const redoKey = historyKeymap.find((b) => b.mac === "Mod-Shift-z");
    expect(undoKey?.run).toBe(undo);
    expect(undoKey?.preventDefault).toBe(true);
    expect(redoKey?.run).toBe(redo);
    expect(redoKey?.preventDefault).toBe(true);
  });
});

describe("syncFromStore", () => {
  // Fails if the reset effect is dropped from the sync transaction.
  it("leaves CodeMirror's history empty: undoDepth 0 AND redoDepth 0", () => {
    const { view, reset } = mounted("a");
    view.dispatch(typing(view.state, "b", 1000));
    view.dispatch(typing(view.state, "c", 3000));
    undo(view);
    expect(depths(view.state)).toEqual({ undoDepth: 1, redoDepth: 1 });
    expect(syncFromStore(view, reset, "a")).toBe(true);
    expect(view.state.doc.toString()).toBe("a");
    expect(depths(view.state)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  // Fails if the sync is recorded again, or stops resetting the history
  // (the replace event would survive the sync).
  it("CJK: typing → Replace All 猫→犬 → (store undo) sync back: a CodeMirror undo/redo can not re-apply 犬", () => {
    const { view, reset } = mounted("猫が好き。\n");
    view.dispatch(typing(view.state, "猫も。", 1000));
    const before = view.state.doc.toString();
    view.dispatch(bridgeReplace(view.state, replaceAllChanges(before, "猫", "犬")));
    expect(view.state.doc.toString()).toBe("犬が好き。\n犬も。");
    syncFromStore(view, reset, before);
    expect(view.state.doc.toString()).toBe(before);
    expect(undo(view)).toBe(false);
    expect(redo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });

  // Fails if the reset reuses one history instance (only the FIRST sync would
  // then empty CodeMirror's history; from the second store undo on, ⌘Z in the
  // source re-applied the replace, worse each cycle).
  it("holds on every cycle: type → Replace All → sync back, twice", () => {
    const { view, reset } = mounted("猫\n");
    for (const t of [1000, 5000]) {
      view.dispatch(typing(view.state, "猫猫", t));
      const before = view.state.doc.toString();
      view.dispatch(bridgeReplace(view.state, replaceAllChanges(before, "猫", "犬")));
      syncFromStore(view, reset, before);
      expect(depths(view.state)).toEqual({ undoDepth: 0, redoDepth: 0 });
      expect(undo(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(before);
    }
  });

  // Fails if the sync is recorded (undo would then step over it).
  it("the sync itself is never undoable: typing after it undoes back to the synced text, no further", () => {
    const { view, reset } = mounted("# 題\n\n");
    view.dispatch(typing(view.state, "下書き", 1000));
    syncFromStore(view, reset, "# 題\n\n本文\n");
    view.dispatch(typing(view.state, "追記", 5000));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("# 題\n\n本文\n");
    expect(undo(view)).toBe(false);
  });

  // Fails if the effect stops comparing LF-normalised text: opening or
  // editing a CRLF file would wipe CodeMirror's history on every keystroke.
  it("is a no-op (no transaction) when the LF texts agree — a CRLF store source keeps CodeMirror's history", () => {
    const { view, reset } = mounted("# T\n\nx\n");
    view.dispatch(typing(view.state, "y", 1000, 6));
    expect(view.state.doc.toString()).toBe("# T\n\nxy\n");
    const sent = view.dispatched.length;
    expect(syncFromStore(view, reset, "# T\r\n\r\nxy\r\n")).toBe(false);
    expect(view.dispatched.length).toBe(sent);
    expect(undoDepth(view.state)).toBe(1);
  });

  // Fails if the sync inserts the store's raw text (a "\r" in CodeMirror).
  it("a differing CRLF store source is shown as LF text (CodeMirror stores LF only)", () => {
    const { view, reset } = mounted("# T\n\nx\n");
    expect(syncFromStore(view, reset, "# T\r\n\r\nxy\r\nz\r\n")).toBe(true);
    expect(view.state.doc.toString()).toBe("# T\n\nxy\nz\n");
  });

  // Fails if the sync goes back to replacing the whole document.
  it("changes only the differing span: unrelated text and the caret stay", () => {
    const { view, reset } = mounted("# 見出し\n\n本文です。\n");
    view.dispatch(view.state.update({ selection: { anchor: 2 } })); // inside the heading
    syncFromStore(view, reset, "# 見出し\n\n本文でした。\n");
    expect(view.state.doc.toString()).toBe("# 見出し\n\n本文でした。\n");
    expect(view.state.selection.main.head).toBe(2);
    const ranges: [number, number][] = [];
    view.dispatched[view.dispatched.length - 1].changes.iterChangedRanges((fromA, toA) => ranges.push([fromA, toA]));
    expect(ranges).toEqual([[10, 11]]); // "す" → "した"
  });
});

describe("minimalChange", () => {
  // Fails if the prefix/suffix scans are off by one or overlap (aaa → aaaa).
  it("null for equal texts; the differing span otherwise", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(minimalChange("", "abc")).toEqual({ from: 0, to: 0, insert: "abc" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
  });

  // Fails if the scan compares bytes/code points inconsistently with
  // CodeMirror's UTF-16 offsets.
  it("CJK and mixed script", () => {
    expect(minimalChange("猫が好き", "犬が好き")).toEqual({ from: 0, to: 1, insert: "犬" });
    expect(minimalChange("Tokyo 東京", "Tokyo 京都")).toEqual({ from: 6, to: 8, insert: "京都" });
  });

  // Fails if either surrogate step is removed: emoji (and 𠮷 / 𠮟) share a
  // HIGH surrogate, so the prefix scan stops mid-pair; U+20BB7 𠮷 / U+21BB7
  // share a LOW surrogate, so the suffix scan does.
  it("never splits a surrogate pair", () => {
    expect(minimalChange("a😀b", "a😃b")).toEqual({ from: 1, to: 3, insert: "😃" });
    expect(minimalChange("😀", "😃")).toEqual({ from: 0, to: 2, insert: "😃" });
    expect(minimalChange("x😀", "😀")).toEqual({ from: 0, to: 1, insert: "" });
    expect(minimalChange("\u{20BB7}野家", "\u{21BB7}野家")).toEqual({ from: 0, to: 2, insert: "\u{21BB7}" });
    for (const [a, b] of [
      ["a😀b", "a😃b"],
      ["😀😀", "😀"],
      ["𠮷野家", "𠮟野家"],
      ["😀x😀", "😀y😀"],
      ["\u{20BB7}野家", "\u{21BB7}野家"],
    ]) {
      const c = minimalChange(a, b)!;
      expect(a.slice(0, c.from) + c.insert + a.slice(c.to)).toBe(b);
      expect(c.insert).not.toMatch(LONE_SURROGATE);
      expect(a.slice(c.from, c.to)).not.toMatch(LONE_SURROGATE);
    }
  });
});

// The real store, with MarkdownEditor's update listener (which never writes
// a store → view sync back) and its [source] effect.
describe("round trips through the real store", () => {
  function harness(initial: string) {
    const doc: Document = { id: "d", title: "T", chunks: [], mode: "markdown", markdownSource: initial };
    st().loadDocument(doc);
    const eol = eolOf(initial);
    // MarkdownEditor's update listener: every doc change is written back.
    const { view, reset } = mounted(normalizeEol(initial), (tr) => {
      if (!tr.docChanged || onlyStoreSync([tr])) return;
      const replaced = tr.isUserEvent(FIND_REPLACE_EVENT);
      st().setMarkdownSource(restoreEol(tr.state.doc.toString(), eol), replaced ? { newUndoStep: true } : undefined);
    });
    // MarkdownEditor's [source] effect (source = documentToMarkdown(doc)).
    const effect = () => syncFromStore(view, reset, documentToMarkdown(st().doc));
    let clock = 0;
    return {
      view,
      effect,
      type(insert: string, at?: number) {
        clock += 1000;
        view.dispatch(typing(view.state, insert, clock, at));
        return effect();
      },
    };
  }

  // Fails if the write-back stops round-tripping (e.g. the store starts
  // normalising typed Markdown): every keystroke would then wipe CodeMirror's
  // history through the [source] effect.
  it("CodeMirror's own edits come back unchanged: heading, CJK body and a CRLF source keep their history", () => {
    for (const initial of ["# 題\n\n本文。\n", "# T\r\n\r\nx\r\n"]) {
      const h = harness(initial);
      expect(h.type("名", 3)).toBe(false); // in the heading line
      expect(h.type("\n\n## 見出し")).toBe(false);
      expect(h.type("猫が好き😀")).toBe(false);
      expect(undoDepth(h.view.state)).toBe(3);
      expect(undo(h.view)).toBe(true);
      expect(h.effect()).toBe(false);
      expect(redoDepth(h.view.state)).toBe(1);
    }
  });

  // The reported sequence end to end. Fails if anything lets CodeMirror bring
  // the replacement back (it would also land as a NEW store step and clear
  // the store's redo).
  it("Replace All → find-bar ⌘Z (store undo) → ⌘Z in the source: nothing happens and the store's redo survives", () => {
    const h = harness("# 猫\n\n猫が好き。\n");
    h.type("猫も。");
    const typed = h.view.state.doc.toString();
    h.view.dispatch(bridgeReplace(h.view.state, replaceAllChanges(typed, "猫", "犬")));
    expect(h.effect()).toBe(false);
    const replaced = "# 犬\n\n犬が好き。\n犬も。";
    expect(st().doc.markdownSource).toBe(replaced);
    st().undo(); // ⌘Z in the find bar right after the replace
    expect(h.effect()).toBe(true);
    expect(h.view.state.doc.toString()).toBe(typed);
    expect(undo(h.view)).toBe(false);
    expect(redo(h.view)).toBe(false);
    expect(st().doc.markdownSource).toBe(typed);
    expect(st().future).toHaveLength(1);
    st().redo();
    expect(h.effect()).toBe(true);
    expect(h.view.state.doc.toString()).toBe(replaced);
  });

  // Fails if the listener writes the sync back: for a source with mixed line
  // endings restoreEol(LF text) differs from the store's text, so the sync
  // recorded a spurious store step that dropped the redo.
  it("a mixed-line-ending source: type → store undo → the sync adds no store step and redo survives", () => {
    for (const initial of ["a\r\nb\nc", "a\rb\nc"]) {
      const h = harness(initial);
      h.type("!");
      const past = st().past.length;
      st().undo();
      expect(h.effect()).toBe(true);
      expect(st().past.length).toBe(past - 1);
      expect(st().future).toHaveLength(1);
      expect(st().doc.markdownSource).toBe(initial);
    }
  });

  // MISS-12 (CHANGELOG v1.4.0): a save ends the typing session so undo lands
  // exactly on the saved state, which clears the unsaved marker. Fails if the
  // sync's own write-back (the listener sees its transaction too) created a
  // store step or touched `dirty` — e.g. if the sync and the write-back
  // disagreed on line endings.
  it("type → save → type → Edit → Undo lands on the saved state, clean; the sync adds no store step", () => {
    const h = harness("# T\r\n\r\n");
    h.type("one");
    st().markClean(undefined, st().doc);
    const saved = st().doc.markdownSource;
    h.type(" two");
    expect(st().dirty).toBe(true);
    st().undo(); // Edit → Undo / 元に戻す
    const past = st().past.length;
    expect(h.effect()).toBe(true);
    expect(st().doc.markdownSource).toBe(saved);
    expect(st().dirty).toBe(false);
    expect(st().past.length).toBe(past);
    expect(st().future).toHaveLength(1);
    expect(h.view.state.doc.toString()).toBe("# T\n\none");
    expect(undo(h.view)).toBe(false); // the known limit: nothing until the user types
  });

  // C14 (review follow-up, QA 20261003): a store undo with a find match
  // selected in the source. FindBar's [loc] effect reads the selection with
  // selectedSourceMatch; it runs AFTER this sync because the sync is a layout
  // effect (pinned in sourceHistoryWiring.test.ts). Fails if the sync stops
  // mapping the selection onto the restored text (whole-document replace),
  // or if selectedSourceMatch trusts a view that still shows the old text
  // (it would read [8, 9) as match 3 of the restored text).
  it("store undo of an earlier edit with match 2 of 猫 selected: after the sync the bar reads 2 / 3", () => {
    const h = harness("前文\n\n猫 猫\n猫\n");
    h.type("追記", 0);
    st().openFind("find", "猫");
    const typed = locate(st());
    if (typed.kind !== "markdown") throw new Error(typed.kind);
    expect(typed.matches.map((m) => m.from)).toEqual([6, 8, 10]);
    h.view.dispatch(h.view.state.update({ selection: { anchor: 8, head: 9 } })); // ⌘G → match 2
    expect(selectedSourceMatch(h.view, typed)).toBe(1);

    st().undo(); // Edit → Undo of the earlier "追記"
    const loc = locate(st());
    if (loc.kind !== "markdown") throw new Error(loc.kind);
    expect(loc.matches.map((m) => m.from)).toEqual([4, 6, 8]);
    // What a reader running BEFORE the sync sees: not the searched text yet.
    expect(selectedSourceMatch(h.view, loc)).toBe(-1);
    expect(h.effect()).toBe(true); // the layout-effect sync
    expect(h.view.state.selection.main).toMatchObject({ from: 6, to: 7 });
    const i = selectedSourceMatch(h.view, loc);
    expect(i).toBe(1);
    expect(findStatus({ report: null, query: "猫", total: loc.matches.length, current: i }, (k) => k, "ja")).toBe("2 / 3");
  });
});
