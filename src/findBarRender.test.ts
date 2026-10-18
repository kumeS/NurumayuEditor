import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { GoToLineField, locate } from "./components/FindBar";
import { translate, type UiLang } from "./i18n";
import { markdownSourceBridge } from "./components/MarkdownEditor";
import { documentToMarkdown } from "./markdown";
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
