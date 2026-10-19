import { describe, expect, it } from "vitest";

// Wiring guards for the Markdown source's store → view sync (QA 20261003
// follow-up) and the LinkPopover Esc fix. No DOM in this suite: the sync's
// behaviour is proven in sourceHistory.test.ts (EditorState + the real
// store); these prove MarkdownEditor actually mounts and calls it. The real
// keydown handling in WKWebView is verified by manual QA.

const sources = import.meta.glob("./components/{MarkdownEditor,FindBar}.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const md = sources["./components/MarkdownEditor.tsx"];
const findBar = sources["./components/FindBar.tsx"];

/** Source from `start` up to (not including) the first `end` after it. */
function between(s: string, start: string, end: string): string {
  const at = s.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const stop = s.indexOf(end, at + start.length);
  expect(stop, `${start} … ${end}`).toBeGreaterThan(at);
  return s.slice(at, stop);
}

describe("MarkdownEditor — CodeMirror's own history, reset by the store → view sync", () => {
  const extensions = () => between(md, "const extensions = useMemo(", "\n    [onLink, setMarkdownSource, historyReset]");

  // Fails if the reset slot is dropped (sourceHistory.test.ts: an unmounted
  // reset is silently ignored) or history() is replaced by the slot alone
  // (that loses history()'s beforeinput handler, which cancels WebKit's
  // native historyUndo / historyRedo).
  it("mounts history() AND the reset slot", () => {
    expect(extensions()).toMatch(/\n      history\(\),\n      historyReset\.extension,\n/);
    const editor = between(md, "function CodeMirrorEditor(", "\nfunction LinkPopover(");
    expect(editor).toContain("const historyReset = useMemo(createHistoryReset, []);");
  });

  // Fails if anything but CodeMirror's own keymap handles ⌘Z / ⇧⌘Z in the
  // source: historyKeymap must stay in the keymap (it also claims the keys on
  // an empty history), and no beforeinput override, keydown handler or direct
  // store undo/redo call may act on undo input first.
  it("keeps historyKeymap in CodeMirror's keymap, and no beforeinput undo override", () => {
    expect(between(extensions(), "keymap.of(", ")")).toBe("keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]");
    expect(md).not.toMatch(/Prec\.highest/);
    expect(md).not.toMatch(/historyUndo|historyRedo/);
    const editor = between(md, "function CodeMirrorEditor(", "\nfunction LinkPopover(");
    expect(editor).not.toMatch(/\bkeydown\s*[:(]/);
    expect(editor).not.toMatch(/\.(undo|redo)\(\)/);
  });

  // Fails if the update listener writes a store → view sync back (a mixed
  // line-ending source then records a spurious store step).
  it("the update listener skips store → view syncs", () => {
    const listener = between(md, "EditorView.updateListener.of((update) => {", "}),");
    expect(listener).toMatch(/if \(!update\.docChanged \|\| onlyStoreSync\(update\.transactions\)\) return;/);
  });

  // Fails if the [source] effect goes back to the recorded full-document
  // dispatch (the defect) or skips the sync.
  it("the [source] effect syncs through syncFromStore with the mounted slot", () => {
    const effect = between(md, "useLayoutEffect(() => {\n    const view = viewRef.current;\n    if (view) syncFromStore", "}, [source]);");
    expect(effect).toContain("if (view) syncFromStore(view, historyReset, source);");
    expect(md).not.toMatch(/view\.dispatch\(\{ changes: \{ from: 0, to: view\.state\.doc\.length/);
    expect(md.match(/syncFromStore\(/g)).toHaveLength(1);
  });

  // C14 (review follow-up, QA 20261003). FindBar renders BEFORE MarkdownEditor
  // (App.tsx), so with two passive effects FindBar's [loc] effect ran first,
  // found the view still on the pre-undo text and showed "N matches" for a
  // selected match; nothing re-ran it after the sync. React runs every layout
  // effect of a commit before any passive one, whatever the tree order: the
  // sync must be a layout effect and FindBar's reader a passive one. Fails if
  // either side changes kind (the proof that the sync puts the selection on
  // the match is in sourceHistory.test.ts).
  it("the store → view sync is a LAYOUT effect, so FindBar's passive [loc] effect sees the synced view (C14)", () => {
    expect(md).toMatch(/useLayoutEffect\(\(\) => \{\n {4}const view = viewRef\.current;\n {4}if \(view\) syncFromStore\(/);
    expect(md).not.toMatch(/useEffect\(\(\) => \{\n {4}const view = viewRef\.current;\n {4}if \(view\) syncFromStore\(/);
    const reader = between(findBar, "// Edits can move or remove the current match", "}, [loc, find.open, setFind]);");
    expect(reader).toMatch(/\n {2}useEffect\(\(\) => \{\n {4}if \(!find\.open \|\| loc\.kind === "unavailable"\) return;/);
    expect(reader).not.toContain("useLayoutEffect");
    expect(reader).toContain("const i = selectedSourceMatch(markdownSourceBridge.view(), loc);");
  });
});

describe("LinkPopover Esc — consistent with the other local Esc handlers", () => {
  const popover = () => between(md, "function LinkPopover(", "\nexport default function MarkdownEditor");

  // Fails if the listener moves back to window (it would then run after —
  // or alongside — the docked-panel Esc listener).
  it("listens on document (runs before the docked-panel window listener), never on window", () => {
    const body = popover();
    expect(body).toContain('document.addEventListener("keydown", closeOnEscape)');
    expect(body).toContain('document.removeEventListener("keydown", closeOnEscape)');
    expect(body).not.toContain("window.addEventListener");
  });

  // Fails if the IME / already-claimed guard is dropped, if it goes back to
  // the bare isImeKeyEvent (no post-compositionend window), if the window is
  // read on another clock than the recorded compositionend (a constant, or
  // event.timeStamp), or if the key is not claimed before closing.
  it("ignores IME keys (incl. the 80 ms after compositionend) and already-claimed Escapes, and claims its own", () => {
    const handler = between(popover(), "const closeOnEscape = (event: KeyboardEvent) => {", "\n    };");
    expect(handler).toContain(
      'if (event.key !== "Escape" || isImeKeyEventSince(event, lastCompositionEnd.current, Date.now()) || event.defaultPrevented)\n        return;'
    );
    expect(handler).not.toMatch(/isImeKeyEvent\(/);
    const claim = handler.indexOf("event.preventDefault();");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(handler.indexOf("onClose();"));
  });

  // WebKit can deliver the Esc that cancels a kana→kanji conversion AFTER
  // compositionend, with isComposing false (modalBehavior.ts
  // isImeKeyEventSince) — the case usePanelEscape already covers. Fails if the
  // listener is dropped, leaves document capture phase on either side (a
  // stopPropagation on the way would hide the event), stops writing Date.now(),
  // or keeps the time in a `let` inside the effect: the effect re-subscribes
  // whenever onClose changes (a parent render), which would forget it.
  it("records compositionend (document, capture phase) in a ref that outlives the effect", () => {
    const body = popover();
    const ref = body.indexOf("const lastCompositionEnd = useRef(0);");
    expect(ref).toBeGreaterThan(-1);
    const effectAt = body.indexOf("useEffect(() => {");
    expect(ref).toBeLessThan(effectAt);
    const effect = between(body, "useEffect(() => {", "}, [onClose]);");
    expect(effect).toMatch(/const onCompositionEnd = \(\) => \{\s*lastCompositionEnd\.current = Date\.now\(\);\s*\};/);
    expect(effect).toContain('document.addEventListener("compositionend", onCompositionEnd, true);');
    expect(effect).toContain('document.removeEventListener("compositionend", onCompositionEnd, true);');
    expect([...body.matchAll(/addEventListener\("compositionend"/g)]).toHaveLength(1);
  });
});
