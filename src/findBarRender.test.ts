import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  findStatus,
  GoToLineField,
  keepsFocusOnPress,
  locate,
  replaceCurrent,
  replaceEverything,
} from "./components/FindBar";
import { applyChanges, freshReplaceReport, type ReplaceReport, type TextChange } from "./findReplace";
import { translate, type UiLang } from "./i18n";
import { markdownSourceBridge } from "./components/MarkdownEditor";
import { documentToMarkdown } from "./markdown";
import { resolveShortcut } from "./shortcuts";
import { FIND_INITIAL, useStore } from "./store";
import type { Chunk } from "./types";

// Behavioural guards for the find bar (QA 20261003). There is no DOM here:
// `locate` is the function FindBar's match list (count, status, and the
// disabled state of ↑ ↓ / Replace / Replace All, all `total === 0`) is
// computed from; the Go to Line row is server-rendered with its props (the
// store-backed FindBar itself would render the store's INITIAL state).

const st = () => useStore.getState();
const opts = { caseSensitive: false, wholeWord: false };

function chunk(id: string, content: string): Chunk {
  return { id, order: 0, content, metadata: { chunkType: "text", linkedChunks: [] } };
}

function reset(chunks: Chunk[]): void {
  useStore.setState({ find: { ...FIND_INITIAL }, savedDocIsClean: true, lastEditAt: 0 });
  st().loadDocument({ id: "d", title: "T", chunks, mode: "editor" });
}

/** A mounted CodeMirror source whose text is `text` — standing in for the
 *  real view, which MarkdownEditor syncs FROM the store in an effect, i.e.
 *  only after FindBar has rendered. */
let viewText = "";
function mountFakeSourceView() {
  vi.spyOn(markdownSourceBridge, "view").mockImplementation(
    () => ({ state: EditorState.create({ doc: viewText }) }) as unknown as EditorView
  );
}

function matchCount(): number {
  const loc = locate(st());
  return loc.kind === "unavailable" ? -1 : loc.matches.length;
}

describe("BUG-002 (QA 20261003) — after Replace All, undo / redo re-locate matches in the CURRENT text", () => {
  beforeEach(() => {
    viewText = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Fails if `locate` searches the mounted CodeMirror view's text instead of
  // the store's (canonical) source: right after a store undo the view still
  // shows the replaced text, so the bar finds 0 matches and disables every
  // button — and nothing re-renders it once the view catches up.
  it("Markdown: replace all 猫→犬, undo → 3 matches; redo → 0, even while the source view lags a render", () => {
    reset([chunk("a", "x")]);
    st().setMode("markdown");
    st().setMarkdownSource("猫 猫\n猫");
    mountFakeSourceView();
    st().openFind("replace", "猫");
    st().setFind({ replacement: "犬" });
    viewText = "猫 猫\n猫";
    expect(matchCount()).toBe(3);

    // Replace All (the store result the CodeMirror update listener commits).
    expect(st().replaceAllInMarkdown("猫", "犬", opts)).toBe(3);
    viewText = "犬 犬\n犬";
    expect(documentToMarkdown(st().doc)).toBe("犬 犬\n犬");
    expect(matchCount()).toBe(0);

    // ⌘Z from the find bar (replacePending) = store undo. The view has not
    // synced yet when FindBar renders.
    st().undo();
    expect(documentToMarkdown(st().doc)).toBe("猫 猫\n猫");
    expect(viewText).toBe("犬 犬\n犬");
    const undone = locate(st());
    expect(undone.kind).toBe("markdown");
    if (undone.kind !== "markdown") return;
    expect(undone.text).toBe("猫 猫\n猫");
    expect(undone.matches).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 5 },
    ]);

    // The view catches up; then ⇧⌘Z redoes the replace.
    viewText = "猫 猫\n猫";
    st().redo();
    expect(documentToMarkdown(st().doc)).toBe("犬 犬\n犬");
    expect(matchCount()).toBe(0);
  });

  it("Markdown CRLF source: matches are in LF (CodeMirror) offsets after undo", () => {
    reset([chunk("a", "x")]);
    st().setMode("markdown");
    st().setMarkdownSource("猫 猫\r\n猫");
    mountFakeSourceView();
    st().openFind("replace", "猫");
    expect(st().replaceAllInMarkdown("猫", "犬", opts)).toBe(3);
    viewText = "犬 犬\n犬";
    st().undo();
    const loc = locate(st());
    if (loc.kind !== "markdown") throw new Error(loc.kind);
    expect(loc.text).toBe("猫 猫\n猫");
    expect(loc.matches.map((m) => m.from)).toEqual([0, 2, 4]);
  });

  // Regression guard (Editor mode already searched the store's chunks; this
  // pins it): fails if the chunk path stops re-locating from the store.
  it("Editor mode: replace all 猫→犬, undo → 3 matches; redo → 0", () => {
    reset([chunk("a", "猫 猫"), chunk("b", "猫")]);
    st().openFind("replace", "猫");
    expect(matchCount()).toBe(3);
    expect(st().replaceAllInChunks("猫", "犬", opts)).toBe(3);
    expect(matchCount()).toBe(0);
    st().undo();
    expect(st().doc.chunks.map((c) => c.content)).toEqual(["猫 猫", "猫"]);
    expect(matchCount()).toBe(3);
    st().redo();
    expect(matchCount()).toBe(0);
  });
});

describe("BUG-004 (QA 20261003) — Go to Line accepts only 1..N and says why otherwise", () => {
  const render = (value: string, total: number, lang: UiLang) =>
    renderToStaticMarkup(
      createElement(GoToLineField, {
        value,
        total,
        lang,
        t: (key: string) => translate(key, lang),
        onValue: () => {},
        onClose: () => {},
      })
    );

  /** The line field, the Go button and the element the field is described by. */
  const parts = (html: string) => {
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    const input = inputs[0] ?? "";
    const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    const button = buttons[0] ?? "";
    const describedBy = /aria-describedby="([^"]+)"/.exec(input)?.[1];
    expect(describedBy, "the field must be described by the hint / error").toBeTruthy();
    const at = html.indexOf(`id="${describedBy}"`);
    expect(at, "aria-describedby must point at an element in the row").toBeGreaterThan(-1);
    const description = /^[^>]*>([^<]*)</.exec(html.slice(at))?.[1] ?? null;
    return {
      invalid: /aria-invalid="([^"]+)"/.exec(input)?.[1],
      goDisabled: /\sdisabled=""/.test(button),
      goLabel: />([^<]*)<\/button>$/.exec(button)?.[1],
      description,
      descriptionTag: html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1),
    };
  };

  // Fails if the Go button is enabled for an out-of-range / non-integer value
  // (the report: 0, 15 of 14, -1 and 1.5 all enabled it), if the field is
  // not marked invalid, or if the error is not what it is described by.
  it("ja: 0 / N+1 / -1 / 1.5 / 1e1 → Go disabled, aria-invalid, inline Japanese error", () => {
    for (const bad of ["0", "15", "１５", "-1", "1.5", "1e1"]) {
      const p = parts(render(bad, 14, "ja"));
      expect(p.goLabel, bad).toBe("移動");
      expect(p.goDisabled, bad).toBe(true);
      expect(p.invalid, bad).toBe("true");
      expect(p.description, bad).toBe("1–14 の整数を入力してください");
      expect(p.descriptionTag, bad).toContain("text-danger");
    }
  });

  it("en: the same error in English", () => {
    const p = parts(render("0", 14, "en"));
    expect(p.goLabel).toBe("Go");
    expect(p.goDisabled).toBe(true);
    expect(p.invalid).toBe("true");
    expect(p.description).toBe("Enter a whole number from 1 to 14.");
  });

  // Fails if full-width (IME) digits or padded input stop being accepted.
  it("valid input (ASCII, full-width IME digits, padded) → Go enabled, no error, range hint", () => {
    for (const good of ["1", "14", "１２", " 7 "]) {
      const p = parts(render(good, 14, "ja"));
      expect(p.goDisabled, good).toBe(false);
      expect(p.invalid, good).toBe("false");
      expect(p.description, good).toBe("1–14 行");
      expect(p.descriptionTag, good).not.toContain("text-danger");
    }
  });

  it("an empty field: Go disabled, but no error yet (nothing typed wrong)", () => {
    const p = parts(render("", 14, "ja"));
    expect(p.goDisabled).toBe(true);
    expect(p.invalid).toBe("false");
    expect(p.description).toBe("1–14 行");
  });
});

// ----- Review follow-ups (QA 20261003): C11, C12, C13 ------------------------

/** A mounted CodeMirror source for replaceEverything / replaceCurrent: its
 *  text and selection, and a `replace` that does what the real bridge +
 *  update listener do — CodeMirror applies the changes (an identity change is
 *  still a doc change there) and the listener writes the text back as its own
 *  store step; setMarkdownSource ignores identical text. */
interface FakeSource {
  text: string;
  sel: { from: number; to: number };
  replaced: TextChange[][];
  selected: Array<[number, number]>;
}
function mountSource(text: string, sel = { from: 0, to: 0 }): FakeSource {
  const src: FakeSource = { text, sel, replaced: [], selected: [] };
  vi.spyOn(markdownSourceBridge, "view").mockImplementation(
    () =>
      ({
        state: EditorState.create({ doc: src.text, selection: { anchor: src.sel.from, head: src.sel.to } }),
      }) as unknown as EditorView
  );
  vi.spyOn(markdownSourceBridge, "replace").mockImplementation((changes) => {
    src.replaced.push([...changes]);
    if (changes.length === 0) return true;
    src.text = applyChanges(src.text, changes);
    st().setMarkdownSource(src.text, { newUndoStep: true });
    return true;
  });
  vi.spyOn(markdownSourceBridge, "select").mockImplementation((from, to) => {
    src.selected.push([from, to]);
    src.sel = { from, to };
    return true;
  });
  return src;
}

/** The store's text right now, LF (what the bar searches in Markdown mode). */
const storeText = () => documentToMarkdown(st().doc);

/** ⌘Z with focus in the find bar's field, routed as useShortcuts does. */
const cmdZInFindBar = () =>
  resolveShortcut(
    { key: "z", metaKey: true },
    { topModal: null, targetKind: "find-bar", mac: true, findReplacePending: st().find.replacePending }
  );

function markdownDoc(text: string): void {
  reset([chunk("a", "x")]);
  st().setMode("markdown");
  st().setMarkdownSource(text, { newUndoStep: true });
}

describe("C12 (review follow-up, QA 20261003) — a replace that changes nothing is not a replace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Fails if identity matches are dispatched/counted again, or if
  // replacePending is set from the match count instead of a real store
  // change: the bar said "Replaced 2." and ⌘Z in it undid the earlier,
  // unrelated "追記" edit.
  it("Markdown (CodeMirror path): an all-identity Replace All reports 0, keeps the doc, and ⌘Z in the bar stays a field undo", () => {
    markdownDoc("GitHub で管理\n");
    st().setMarkdownSource("GitHub で管理、GitHub へ push\n", { newUndoStep: true }); // the earlier edit
    const src = mountSource(storeText());
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub" });
    expect(matchCount()).toBe(2);
    const doc = st().doc;
    const past = st().past.length;

    const report = replaceEverything();
    expect(report.count).toBe(0);
    expect(st().doc).toBe(doc);
    expect(st().past.length).toBe(past);
    expect(src.replaced.flat()).toEqual([]); // nothing dispatched
    expect(st().find.replacePending).toBe(false);
    expect(cmdZInFindBar()).toBe("field-undo");
    // The status says nothing changed — not "Replaced 2.", not "No matches".
    const fresh = freshReplaceReport(report, storeText(), { caseSensitive: false, wholeWord: false });
    const status = (lang: UiLang) =>
      findStatus({ report: fresh, query: "github", total: 2, current: -1 }, (k) => translate(k, lang), lang);
    expect(status("en")).toBe("Nothing to change.");
    expect(status("ja")).toBe("変更箇所はありません");
  });

  // The no-view fallback (store.replaceAllInMarkdown, which counts through
  // replaceAll): fails if identity matches are counted there again (it
  // reported 2 with no undo step), or if the bar arms ⌘Z from a count.
  it("Markdown with no source view (Preview): the store fallback counts 0 and the bar stays unarmed", () => {
    markdownDoc("GitHub と GitHub\n");
    vi.spyOn(markdownSourceBridge, "view").mockReturnValue(null);
    const doc = st().doc;
    expect(st().replaceAllInMarkdown("github", "GitHub", { caseSensitive: false, wholeWord: false })).toBe(0);
    expect(st().doc).toBe(doc);
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub" });
    expect(replaceEverything().count).toBe(0);
    expect(st().doc).toBe(doc);
    expect(st().find.replacePending).toBe(false);
  });

  // Fails if only the changed matches are not what gets counted, or if a
  // real replace stops arming ⌘Z-in-the-bar → document undo.
  it("Markdown: a mixed replace changes and counts only the differing match; ⌘Z then undoes the document", () => {
    markdownDoc("github と GitHub\n");
    const src = mountSource(storeText());
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub" });
    const report = replaceEverything();
    expect(report.count).toBe(1);
    expect(src.replaced).toEqual([[{ from: 0, to: 6, insert: "GitHub" }]]);
    expect(storeText()).toBe("GitHub と GitHub\n");
    expect(st().find.replacePending).toBe(true);
    expect(cmdZInFindBar()).toBe("undo");
    // A later all-identity Replace All does not cancel that: ⌘Z still undoes
    // the real replace, which is still the latest store step.
    expect(replaceEverything().count).toBe(0);
    expect(st().find.replacePending).toBe(true);
    const fresh = freshReplaceReport(report, storeText(), { caseSensitive: false, wholeWord: false });
    expect(findStatus({ report: fresh, query: "github", total: 2, current: -1 }, (k) => translate(k, "ja"), "ja")).toBe(
      "1 件を置換しました"
    );
  });

  it("Editor mode: an all-identity Replace All adds no undo step and leaves replacePending off", () => {
    reset([chunk("a", "GitHub here"), chunk("b", "and GitHub")]);
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub" });
    const doc = st().doc;
    const past = st().past.length;
    expect(replaceEverything().count).toBe(0);
    expect(st().doc).toBe(doc);
    expect(st().past.length).toBe(past);
    expect(st().find.replacePending).toBe(false);
  });

  // Fails if Replace rewrites a match that already reads the replacement
  // (an empty store step in Editor mode; in Markdown, replacePending with no
  // step) instead of moving on to the next match.
  it("Replace on a match that already reads the replacement moves on without an edit (Markdown)", () => {
    markdownDoc("GitHub と github\n");
    const src = mountSource(storeText(), { from: 0, to: 6 });
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub" });
    const doc = st().doc;
    replaceCurrent();
    expect(st().doc).toBe(doc);
    expect(src.replaced).toEqual([]);
    expect(st().find.replacePending).toBe(false);
    expect(src.selected[src.selected.length - 1]).toEqual([9, 15]); // the next match
    replaceCurrent(); // now on "github": a real replace
    expect(storeText()).toBe("GitHub と GitHub\n");
    expect(st().find.replacePending).toBe(true);
  });

  it("Replace on a match that already reads the replacement moves on without an edit (Editor)", () => {
    reset([chunk("a", "GitHub と github")]);
    st().openFind("replace", "github");
    st().setFind({ replacement: "GitHub", current: 0, hit: { chunkId: "a", from: 0, to: 6 } });
    const doc = st().doc;
    const past = st().past.length;
    replaceCurrent();
    expect(st().doc).toBe(doc);
    expect(st().past.length).toBe(past);
    expect(st().find.replacePending).toBe(false);
    expect(st().find.hit).toEqual({ chunkId: "a", from: 9, to: 15 });
    replaceCurrent();
    expect(st().doc.chunks[0].content).toBe("GitHub と GitHub");
    expect(st().past.length).toBe(past + 1);
    expect(st().find.replacePending).toBe(true);
  });
});

describe("C11 (review follow-up, QA 20261003) — the source view is written only while it shows the store's text", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Defense in depth for C11: fails if a replace hands store offsets to a
  // source view that still shows older text (its update listener would write
  // that older text back over what the Preview just committed).
  it("Replace All with a lagging source view goes through the store", () => {
    markdownDoc("猫 猫\n");
    const src = mountSource("猫 猫\n");
    st().setMarkdownSource("前置き 猫 猫\n", { newUndoStep: true }); // a Preview commit the view has not shown yet
    st().openFind("replace", "猫");
    st().setFind({ replacement: "犬" });
    expect(replaceEverything().count).toBe(2);
    expect(src.replaced).toEqual([]);
    expect(storeText()).toBe("前置き 犬 犬\n");
    expect(st().find.replacePending).toBe(true);
  });

  it("Replace with a lagging source view does not trust its selection (it only steps)", () => {
    markdownDoc("a猫\n");
    const src = mountSource("a猫\n", { from: 1, to: 2 }); // on the view's 猫 …
    st().setMarkdownSource("猫猫 abc\n", { newUndoStep: true }); // … which is not the store's [1, 2)
    st().openFind("replace", "猫");
    st().setFind({ replacement: "犬" });
    const doc = st().doc;
    replaceCurrent();
    expect(src.replaced).toEqual([]);
    expect(st().doc).toBe(doc);
  });
});

describe("C11 (review follow-up, QA 20261003) — a find-bar press keeps focus only when it is already in the bar", () => {
  const el = (matches: string[], isContentEditable = false) => ({
    isContentEditable,
    closest: (sel: string) => (matches.includes(sel) ? {} : null),
  });

  // Fails if the mousedown handler claims focus from outside the bar again:
  // a Preview block with typed text then never blurs (never commits), and
  // the replace remounts it — the text is lost.
  it("true inside [data-find-bar] (field or button), false everywhere else", () => {
    expect(keepsFocusOnPress(el(["[data-find-bar]"]))).toBe(true);
    expect(keepsFocusOnPress(el(["[data-find-bar]", "button"]))).toBe(true);
    expect(keepsFocusOnPress(el(["[data-doc-history]"], true))).toBe(false); // Preview block / draft
    expect(keepsFocusOnPress(el([".cm-editor"], true))).toBe(false);
    expect(keepsFocusOnPress(el([]))).toBe(false); // body
    expect(keepsFocusOnPress(null)).toBe(false);
    expect(keepsFocusOnPress({})).toBe(false);
  });
});

describe("C13 (review follow-up, QA 20261003) — the status follows the live matches after an option toggle", () => {
  // Fails if findStatus prefers a stale report, or freshReplaceReport ignores
  // the options: "a A" → Replace All a→A with Match case → "A A"; turning
  // Match case off finds 2 matches and must say so.
  it("Match case off after Replace All shows the 2 live matches", () => {
    const report: ReplaceReport = { count: 1, text: "A A", caseSensitive: true, wholeWord: false };
    const show = (caseSensitive: boolean, total: number, lang: UiLang) =>
      findStatus(
        {
          report: freshReplaceReport(report, "A A", { caseSensitive, wholeWord: false }),
          query: "a",
          total,
          current: -1,
        },
        (k) => translate(k, lang),
        lang
      );
    expect(show(true, 0, "en")).toBe("Replaced 1.");
    expect(show(false, 2, "en")).toBe("2 matches");
    expect(show(false, 2, "ja")).toBe("2 件");
  });

  it("without a report: '' / No matches / k / N / N matches", () => {
    const t = (k: string) => translate(k, "ja");
    expect(findStatus({ report: null, query: "", total: 0, current: -1 }, t, "ja")).toBe("");
    expect(findStatus({ report: null, query: "猫", total: 0, current: -1 }, t, "ja")).toBe("一致なし");
    expect(findStatus({ report: null, query: "猫", total: 3, current: 1 }, t, "ja")).toBe("2 / 3");
    expect(findStatus({ report: null, query: "猫", total: 3, current: -1 }, t, "ja")).toBe("3 件");
  });
});
