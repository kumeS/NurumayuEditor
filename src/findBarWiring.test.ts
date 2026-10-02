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

  it("prefills from the selection with findSeed and Go to Line clamps with lineStartOffset", () => {
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
    expect(bar()).toMatch(/const keepFieldFocus = \(e: MouseEvent\) => e\.preventDefault\(\);/);
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
    expect(e).toMatch(/view\.state\.doc\.toString\(\) === normalizeEol\(source\)/);
    expect(e).toMatch(/insert: normalizeEol\(source\)/);
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
  it("replaceEverything sets replacePending when something was replaced", () => {
    const body = fnBody(src("FindBar"), "replaceEverything");
    expect(body).toMatch(/s\.setFind\(\{ current: -1, hit: null, replacePending: count > 0 \}\)/);
  });

  it("replaceCurrent sets it after both the chunk and the Markdown replacement", () => {
    const body = fnBody(src("FindBar"), "replaceCurrent");
    expect(body.match(/setFind\(\{ replacePending: true \}\)/g)).toHaveLength(2);
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

describe("ux-a11y-i18n-7 — the Go to Line field normalizes after composition, not during it", () => {
  it("onChange keeps the raw text while composing and normalizes otherwise; compositionend normalizes", () => {
    const s = src("FindBar");
    const at = s.indexOf("ref={lineRef}");
    const tag = s.slice(at, s.indexOf("/>", at));
    expect(tag).toMatch(/\.isComposing \? v : lineInputDigits\(v\)/);
    expect(tag).toMatch(/onCompositionEnd=\{\(e\) => setLine\(lineInputDigits\(e\.currentTarget\.value\)\)\}/);
    expect(tag).not.toMatch(/replace\(\/\[\^0-9\]\/g/);
  });
});
