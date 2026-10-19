import { describe, expect, it } from "vitest";

// BUG-010 wiring guards. There is no DOM in this suite: findReplace.test.ts
// and store.test.ts prove the behaviour; these prove the components actually
// call it (a pure helper the UI never calls would pass on its own). Real
// selection painting / scrolling is left to manual QA.

const components = import.meta.glob("./components/{FindBar,MarkdownEditor,ChunkView,CommandPalette}.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const src = (name: string): string => {
  const s = components[`./components/${name}.tsx`];
  if (typeof s !== "string") throw new Error(`missing component source ${name}`);
  return s;
};

/** The body of a top-level `function name(` in a source file. */
const fnBody = (s: string, name: string): string => {
  const at = s.indexOf(`function ${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const next = s.indexOf("\nfunction ", at + 1);
  const nextExport = s.indexOf("\nexport ", at + 1);
  const ends = [next, nextExport, s.length].filter((n) => n > at);
  return s.slice(at, Math.min(...ends));
};

describe("FindBar uses the pure core and the store actions", () => {
  const bar = () => src("FindBar");

  it("locates matches with findInChunks (Editor) and findMatches (Markdown), gated by findAvailability", () => {
    const body = fnBody(bar(), "locate");
    expect(body).toContain("findAvailability(");
    expect(body).toContain("findInChunks(s.doc.chunks");
    expect(body).toContain("findMatches(text");
  });

  it("steps with nextMatch from the current match", () => {
    expect(fnBody(bar(), "step")).toMatch(/nextMatch\(loc\.matches, caretFor\(/);
  });

  it("Replace All: chunks through replaceAllInChunks; Markdown through ONE CodeMirror change list, else the store", () => {
    const body = fnBody(bar(), "replaceEverything");
    expect(body).toContain("s.replaceAllInChunks(");
    expect(body).toContain("replacementChanges(loc.text");
    expect(body).toMatch(/markdownSourceBridge\.replace\(changes, true\)/);
    expect(body).toContain("s.replaceAllInMarkdown(");
  });

  it("Replace: chunk matches through replaceMatchInChunk; Markdown through the bridge or a new undo step", () => {
    const body = fnBody(bar(), "replaceCurrent");
    expect(body).toContain("s.replaceMatchInChunk(");
    expect(body).toMatch(/markdownSourceBridge\.replace\(\[change\], false\)/);
    expect(body).toMatch(
      /setMarkdownSource\(restoreEol\(applyChanges\(loc\.text, \[change\]\), eolOf\(documentToMarkdown\(s\.doc\)\)\), \{\s*newUndoStep: true,\s*\}\)/
    );
  });

  it("prefills from the selection with findSeed and Go to Line jumps with lineStartOffset (its clamp is only a safety net, BUG-004)", () => {
    expect(fnBody(bar(), "selectionSeed")).toContain("findSeed(");
    expect(fnBody(bar(), "goToLine")).toContain("lineStartOffset(");
  });

  it("Esc / Close hand focus back to the editor on the current match", () => {
    const body = fnBody(bar(), "closeAndReturnFocus");
    expect(body).toContain("s.closeFind()");
    expect(body).toMatch(/focusChunkRange\(hit\.chunkId, hit\.from, hit\.to\)/);
    expect(body).toMatch(/markdownSourceBridge\.view\(\)\?\.focus\(\)/);
  });

  it("every button keeps focus in the field, so Enter / Esc still work after a click", () => {
    const tags = bar().split("<button").slice(1);
    expect(tags.length).toBeGreaterThanOrEqual(9);
    for (const tag of tags) expect(tag.slice(0, 40)).toMatch(/^ onMouseDown=\{keepFieldFocus\}/);
  });

  // C11 (review follow-up, QA 20261003). Fails if the handler claims every
  // press again (unconditional preventDefault): a Preview block with typed
  // text then never blurs, so never commits, and the replace remounts it.
  // keepsFocusOnPress itself is proven in findBarRender.test.ts.
  it("keepFieldFocus claims a press only when focus is already in the bar (C11)", () => {
    const b = bar();
    const at = b.indexOf("const keepFieldFocus = (e: MouseEvent) => {");
    expect(at).toBeGreaterThan(-1);
    const handler = b.slice(at, b.indexOf("\n};", at) + 3);
    expect(handler).toMatch(
      /^const keepFieldFocus = \(e: MouseEvent\) => \{\n {2}if \(keepsFocusOnPress\(document\.activeElement\)\) e\.preventDefault\(\);\n\};$/
    );
  });

  // C11: the fix is the native blur of the press, NOT a blur inside the
  // handlers — React renders only after the click handler returns, so the
  // source view would still show the old text and its write-back would undo
  // the commit. Fails if either replace handler starts blurring / flushing.
  it("the replace handlers never blur or flush the focused element themselves (C11)", () => {
    for (const name of ["replaceEverything", "replaceCurrent"]) {
      expect(fnBody(bar(), name), name).not.toMatch(/\.blur\(|flushPendingEdit|flushesPendingEditBeforeHistory|activeElement/);
    }
  });

  it("opening the bar in Markdown mode asks the editor to show the source (Preview → Split)", () => {
    const b = bar();
    const effect = b.slice(b.indexOf("// Focus the field on every open"));
    expect(effect.slice(0, 400)).toMatch(/docMode === "markdown"\) markdownSourceBridge\.show\(\)/);
  });
});

describe("MarkdownEditor find bridge", () => {
  const md = () => src("MarkdownEditor");

  it("a find-bar replace is one isolated CodeMirror history event", () => {
    const at = md().indexOf("replace(changes: readonly TextChange[]");
    expect(at).toBeGreaterThan(-1);
    const body = md().slice(at, md().indexOf("},\n};", at));
    expect(body).toContain('annotations: isolateHistory.of("full")');
    expect(body).toMatch(/userEvent: all \? `\$\{FIND_REPLACE_EVENT\}\.all` : FIND_REPLACE_EVENT/);
  });

  it("the update listener commits that replace as its own store undo step", () => {
    const at = md().indexOf("EditorView.updateListener.of(");
    const body = md().slice(at, md().indexOf("}),", at));
    expect(body).toMatch(/tr\.isUserEvent\(FIND_REPLACE_EVENT\)/);
    expect(body).toMatch(
      /setMarkdownSource\(\s*restoreEol\(update\.state\.doc\.toString\(\), eolRef\.current\),\s*replaced \? \{ newUndoStep: true \} : undefined\s*\)/
    );
  });

  it("Preview → Split is what show() requests", () => {
    const at = md().indexOf("showSourceRequest = request");
    const body = md().slice(md().lastIndexOf("const request", at), at);
    expect(body).toMatch(/surface === "preview"\) switchSurface\("split"\)/);
  });

  it("the mounted view is published to (and withdrawn from) the bridge", () => {
    expect(md()).toMatch(/mountedSourceView = view;/);
    expect(md()).toMatch(/if \(mountedSourceView === view\) mountedSourceView = null;/);
  });
});

describe("ChunkView shows the find bar's current match", () => {
  const cv = () => src("ChunkView");

  it("scrolls to find.hit without touching the textarea selection (focus stays in the bar)", () => {
    const at = cv().indexOf("if (!findHit) return;");
    expect(at).toBeGreaterThan(-1);
    const body = cv().slice(at, cv().indexOf("}, [findHit]);", at));
    expect(body).toMatch(/\(findMarkRef\.current \?\? containerRef\.current\)\?\.scrollIntoView\(/);
    expect(body).not.toContain("setSelectionRange");
    expect(body).not.toContain("focus(");
  });

  it("the pending selection (caret or find match) is applied when the textarea takes focus", () => {
    const at = cv().indexOf("const applyFocus = useCallback(");
    expect(at).toBeGreaterThan(-1);
    const body = cv().slice(at, cv().indexOf("}, [chunkId]);", at));
    expect(body).toContain("el.focus()");
    expect(body).toMatch(/setSelectionRange\(Math\.min\(sel\.from, len\), Math\.min\(sel\.to, len\)\)/);
  });

  it("paints the match with a <mark> overlay, because WebKit hides an unfocused textarea selection", () => {
    const at = cv().indexOf("{findHit && !ghostText && (");
    expect(at).toBeGreaterThan(-1);
    const overlay = cv().slice(at, cv().indexOf("</div>", at));
    expect(overlay).toContain('aria-hidden="true"');
    expect(overlay).toMatch(/<mark ref=\{findMarkRef\}/);
    expect(overlay).toContain("chunk.content.slice(findHit.from, findHit.to)");
  });

  it("focusChunkRange focuses an already-focused chunk directly (its focus effect would not re-run)", () => {
    const at = cv().indexOf("export function focusChunkRange(");
    const body = cv().slice(at, cv().indexOf("\n}\n", at));
    expect(body).toMatch(/st\.focusedChunkId === id\) focusers\.get\(id\)\?\.\(\)/);
    expect(body).toMatch(/else st\.setFocused\(id\)/);
  });
});

describe("palette visibility", () => {
  it("find entries hide in Slides (planned) and Go to Line shows in Markdown only", () => {
    const p = src("CommandPalette");
    const entry = (id: string) => {
      const at = p.indexOf(`id: "${id}",`);
      expect(at, id).toBeGreaterThan(-1);
      return p.slice(at, p.indexOf("},", at));
    };
    for (const id of ["find", "find-replace", "find-next", "find-previous"]) {
      expect(entry(id)).toMatch(/visible: findAvailability\(s\.doc\.mode\) === "available"/);
    }
    expect(entry("go-to-line")).toMatch(/visible: s\.doc\.mode === "markdown"/);
    expect(entry("find")).toMatch(/keywords: "[^"]*検索[^"]*"/);
    expect(entry("find-replace")).toMatch(/keywords: "[^"]*置換[^"]*"/);
    expect(entry("go-to-line")).toMatch(/keywords: "[^"]*行[^"]*"/);
  });
});

// KBD-IME-ENTER (optional hardening): WebKit can deliver the
// composition-committing keydown with keyCode 229 and isComposing false, so
// the chunk key handler (Enter splits, ⌘Enter runs AI) uses the shared helper.
describe("ChunkView key handler is IME-guarded with isImeKeyEvent (KBD-IME-ENTER)", () => {
  it("returns early on any IME key event before handling keys", () => {
    const cv = src("ChunkView");
    const at = cv.indexOf("const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {");
    expect(at).toBeGreaterThan(-1);
    const head = cv.slice(at, at + 200);
    expect(head).toContain("if (isImeKeyEvent(e.nativeEvent)) return;");
  });
});

describe("md-slides-export-3 — CRLF sources and the CodeMirror editor", () => {
  const editor = () => src("MarkdownEditor");

  it("the editor is created and synced with LF text, and writes back in the source's EOL", () => {
    const e = editor();
    expect(e).toMatch(/EditorState\.create\(\{ doc: normalizeEol\(source\), extensions \}\)/);
    // The [source] effect hands the store's raw source to syncFromStore, which
    // compares and inserts LF text (CRLF no-op proven in sourceHistory.test.ts).
    // A layout effect (C14, review follow-up, QA 20261003; why: sourceHistoryWiring.test.ts).
    expect(e).toMatch(
      /useLayoutEffect\(\(\) => \{\n {4}const view = viewRef\.current;\n {4}if \(view\) syncFromStore\(view, historyReset, source\);\n {2}\}, \[source\]\);/
    );
    expect(e).toMatch(/setMarkdownSource\(\s*restoreEol\(update\.state\.doc\.toString\(\), eolRef\.current\)/);
  });

  it("Find with no source view searches LF-normalized text (CodeMirror offsets)", () => {
    const body = fnBody(src("FindBar"), "locate");
    expect(body).toContain("normalizeEol(documentToMarkdown(s.doc))");
    const replace = fnBody(src("FindBar"), "replaceCurrent");
    expect(replace).toMatch(/restoreEol\(applyChanges\(loc\.text, \[change\]\), eolOf\(documentToMarkdown\(s\.doc\)\)\)/);
  });
});

describe("ux-a11y-i18n-1 — Replace marks a pending replace for ⌘Z routing", () => {
  // C12 (review follow-up, QA 20261003): armed only when the store really
  // changed (doc identity — past.length saturates at the history cap), and
  // never disarmed by a replace that changed nothing. Fails if it goes back
  // to the match count (`count > 0`), or to past.length.
  it("replaceEverything sets replacePending only when the document changed", () => {
    const body = fnBody(src("FindBar"), "replaceEverything");
    expect(body).toMatch(
      /const changed = docChangedSince\(s\);\s*s\.setFind\(\{ current: -1, hit: null, \.\.\.\(changed \? \{ replacePending: true \} : \{\}\) \}\);/
    );
    expect(body).not.toMatch(/replacePending: count/);
    expect(src("FindBar")).toMatch(
      /const docChangedSince = \(before: State\): boolean => useStore\.getState\(\)\.doc !== before\.doc;/
    );
  });

  it("replaceCurrent sets it after both the chunk and the Markdown replacement, only when the document changed", () => {
    const body = fnBody(src("FindBar"), "replaceCurrent");
    expect(body.match(/setFind\(\{ replacePending: true \}\)/g)).toHaveLength(2);
    const guarded = /if \(docChangedSince\(s\)\) useStore\.getState\(\)\.setFind\(\{ replacePending: true \}\);/g;
    expect(body.match(guarded)).toHaveLength(2);
    const chunkReplace = body.indexOf("s.replaceMatchInChunk(");
    const firstMark = body.indexOf("setFind({ replacePending: true })");
    expect(firstMark).toBeGreaterThan(chunkReplace);
    const mdReplace = body.indexOf("markdownSourceBridge.replace([change], false)");
    expect(body.lastIndexOf("setFind({ replacePending: true })")).toBeGreaterThan(mdReplace);
  });

  it("the bar root carries data-find-bar (the shortcut classifier keys on it)", () => {
    expect(src("FindBar")).toMatch(/data-find-bar/);
  });
});

describe("ux-a11y-i18n-7 / BUG-004 (QA 20261003) — the Go to Line field is validated, never rewritten or clamped", () => {
  const row = () => {
    const s = src("FindBar");
    const at = s.indexOf("export function GoToLineField(");
    expect(at).toBeGreaterThan(-1);
    return s.slice(at, s.indexOf("\nexport default function FindBar(", at));
  };
  const inputTag = () => {
    const r = row();
    const at = r.indexOf("<input");
    return r.slice(at, r.indexOf("/>", at));
  };

  // Fails if the field goes back to filtering keystrokes (the old
  // lineInputDigits turned "-1" into 1 and "1.5" into 15 before any check)
  // or rewrites the value around an IME composition.
  it("the field keeps the raw text; parseLineNumber validates it against the line count", () => {
    expect(inputTag()).toMatch(/onChange=\{\(e\) => onValue\(e\.target\.value\)\}/);
    expect(inputTag()).not.toContain("onCompositionEnd");
    expect(row()).toMatch(/const check = parseLineNumber\(value, total\);/);
  });

  // Fails if Enter or the Go button can reach goToLine with a rejected value,
  // or if Enter commits an IME composition as a jump.
  it("Enter and Go both act only on an accepted line; Enter is IME-guarded", () => {
    expect(row()).toMatch(/const go = \(\) => \{\s*if \(check\.ok\) goToLine\(check\.line\);\s*\};/);
    const keys = inputTag().slice(inputTag().indexOf("onKeyDown="));
    expect(keys).toMatch(/^onKeyDown=\{\(e\) => \{\s*if \(isImeKeyEvent\(e\.nativeEvent\)\) return;\s*if \(e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*go\(\);/);
    expect(row()).not.toMatch(/goToLine\(Number\(/);
    const goButton = row().slice(row().indexOf("<button"), row().indexOf("</button>"));
    expect(goButton).toMatch(/disabled=\{!check\.ok\} onClick=\{go\}/);
  });

  it("the field is aria-invalid and described by the hint / error span (semantic tokens)", () => {
    expect(inputTag()).toMatch(/aria-invalid=\{invalid\}/);
    expect(inputTag()).toMatch(/aria-describedby=\{descriptionId\}/);
    const r = row();
    const span = r.slice(r.indexOf("<span id={descriptionId}"), r.indexOf("</span>", r.indexOf("<span id={descriptionId}")));
    expect(span).toMatch(/className=\{invalid \? "text-danger" : "text-ink-faint"\}/);
    expect(span).toContain('translateWith("Enter a whole number from 1 to {total}.", lang, { total })');
  });

  it("FindBar renders the row with the line count of the text it searches and focuses its field", () => {
    const s = src("FindBar");
    const at = s.indexOf("<GoToLineField");
    expect(at).toBeGreaterThan(-1);
    const tag = s.slice(at, s.indexOf("/>", at));
    expect(tag).toMatch(/total=\{lineCount\(searchedText\(loc\)\)\}/);
    expect(tag).toMatch(/inputRef=\{lineRef\}/);
    expect(tag).toMatch(/value=\{line\}\s+onValue=\{setLine\}/);
  });
});

describe("BUG-002 (QA 20261003) — the Replace All report is checked for freshness where it is shown", () => {
  const bar = () => src("FindBar");

  // Fails if the status goes back to a bare count that only a query /
  // replacement edit clears (the "3 件を置換しました" that outlived ⌘Z).
  // + C13 (review follow-up, QA 20261003): with the find options being used
  // now, so a Match case / Whole word toggle makes the report stale.
  it("the status reads the report through freshReplaceReport with the text and options being searched now", () => {
    const b = bar();
    expect(b).toMatch(
      /const report = freshReplaceReport\(replaced, searchedText\(loc\), \{\s*caseSensitive: find\.caseSensitive,\s*wholeWord: find\.wholeWord,\s*\}\);/
    );
    const status = b.slice(b.indexOf("const status ="), b.indexOf("const closeButton"));
    // findStatus (findBarRender.test.ts) puts a fresh report before the live count.
    expect(status).toMatch(/^const status = findStatus\(\{ report, query: find\.query, total, current: find\.current \}, t, lang\);/);
    expect(status).not.toMatch(/\breplaced\b/);
  });

  it("a stale report is dropped (one-shot), so redo does not revive it", () => {
    expect(bar()).toMatch(
      /useEffect\(\(\) => \{\s*if \(replaced !== null && report === null\) setReplaced\(null\);\s*\}, \[replaced, report\]\);/
    );
  });

  it("replaceEverything reports the text the replace left (re-located from the store)", () => {
    const body = fnBody(bar(), "replaceEverything");
    expect(body).toMatch(
      /return \{ count: changed \? count : 0, text: searchedText\(locate\(useStore\.getState\(\)\)\), \.\.\.opts \};/
    );
    expect(bar()).toMatch(/onClick=\{\(\) => setReplaced\(replaceEverything\(\)\)\}/);
  });
});

// Review follow-up (QA 20261003): a press on ↑ / ↓ that starts in a Preview
// block blurs it (C11), the blur commit makes the "Replaced N." / "Nothing to
// change." report stale, and the status text shrinks — with a min-width the
// arrows to its right slid under the pointer between mousedown and click, so
// the click was lost. The status now has a FIXED width wide enough for the
// longest copy (EN "Nothing to change.", JA 「12345 件を置換しました」), so nothing
// after it moves. Fails if the status goes back to a min-width / auto width.
describe("find bar status keeps the buttons after it in place", () => {
  const findBar = Object.values(
    import.meta.glob("./components/FindBar.tsx", { eager: true, query: "?raw", import: "default" })
  )[0] as string;
  it("the live status span has a fixed width and never wraps", () => {
    const at = findBar.indexOf('<span role="status" aria-live="polite"');
    expect(at).toBeGreaterThan(-1);
    const tag = findBar.slice(at, findBar.indexOf(">", at) + 1);
    // 9.5rem fits a 5-digit Japanese "N 件を置換しました" (CoreText, 12px);
    // anything longer is cut, and the title shows the full text.
    expect(tag).toMatch(/\bw-\[9\.5rem\]/);
    expect(tag).toMatch(/\btitle=\{status\}/);
    expect(tag).toMatch(/\bshrink-0\b/);
    expect(tag).toMatch(/\bwhitespace-nowrap\b/);
    expect(tag).not.toMatch(/min-w-/);
  });
});
