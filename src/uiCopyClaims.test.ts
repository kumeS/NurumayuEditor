// Guards for user-visible copy added in the Japanese-UI pass (w5-copy): each
// claim the UI makes is checked against the behaviour it describes, and each
// table of labels that is translated at its render site (t(x.label)) is
// checked there, so the dictionary half alone can't pass for the whole.

import { describe, expect, it } from "vitest";
import { JA, translate } from "./i18n";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { useStore } from "./store";
import { groupSlides, slideTitle } from "./slides";
import type { Chunk, ChunkType, Document } from "./types";

const raw = import.meta.glob(
  [
    "./components/ChunkAiMenu.tsx",
    "./components/ChunkView.tsx",
    "./components/Editor.tsx",
    "./components/PromptModal.tsx",
    "./components/SettingsModal.tsx",
    "./components/SlideEditor.tsx",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;
const src = (name: string) => raw[`./components/${name}.tsx`];

/** Every `t("…")` key inside one attribute expression `name={…}` (balanced braces). */
function attrKeys(source: string, from: number, name: string): string[] {
  const start = source.indexOf(`${name}={`, from);
  expect(start, `${name}={…} not found`).toBeGreaterThan(-1);
  let depth = 0;
  let end = start + name.length + 1;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) break;
  }
  const expr = source.slice(start, end + 1);
  const direct = [...expr.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]);
  if (direct.length > 0) return direct;
  // `label={triggerLabel}`: follow the const it names.
  const ident = /=\{\s*(\w+)\s*\}/.exec(expr)?.[1];
  expect(ident, `${name} is neither t("…") nor a named const`).toBeDefined();
  const decl = source.slice(source.indexOf(`const ${ident} =`));
  return [...decl.slice(0, decl.indexOf(";")).matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]);
}

describe("the per-paragraph ✨ trigger is named by outcome (UX-AI-ACTIONS-LABEL, ui.md #13)", () => {
  const menu = src("ChunkAiMenu");
  const button = menu.lastIndexOf("<Tooltip", menu.indexOf("<SparklesIcon"));

  it("tooltip and accessible name are the same outcome strings, never 'AI actions'", () => {
    const tooltip = attrKeys(menu, button, "label");
    const aria = attrKeys(menu, button, "aria-label");
    expect(tooltip).toEqual(aria);
    expect(tooltip).toEqual(["Rewrite this heading with AI…", "Rewrite, translate or illustrate with AI…"]);
    for (const key of aria) {
      expect(key).not.toMatch(/^AI actions/);
      expect(translate(key, "ja")).toMatch(/書き換え/);
    }
    expect(translate("Rewrite, translate or illustrate with AI…", "ja")).toBe("AIで書き換え・翻訳・図解…");
    expect(translate("Rewrite this heading with AI…", "ja")).toBe("AIで見出しを書き換え…");
  });
});

describe("label tables are translated where they render", () => {
  it("proofread presets (ChunkAiMenu) render through PromptModal's t(p.label)", () => {
    expect(src("PromptModal")).toMatch(/\{t\(p\.label\)\}/);
    for (const m of src("ChunkAiMenu").matchAll(/\{ label: "([^"]+)", value:/g)) expect(JA[m[1]], m[1]).toBeDefined();
  });

  it("slide layouts (SlideEditor LAYOUT_META) render as t(l.label) / t(l.hint)", () => {
    const s = src("SlideEditor");
    expect(s).toMatch(/title=\{t\(l\.hint\)\}/);
    expect(s).toMatch(/\{t\(l\.label\)\}/);
    expect(s).toMatch(/\{t\(layoutLabel\(/);
    const table = s.slice(s.indexOf("const LAYOUT_META"), s.indexOf("];", s.indexOf("const LAYOUT_META")));
    const entries = [...table.matchAll(/label: "([^"]+)", hint: "([^"]+)"/g)];
    expect(entries).toHaveLength(5);
    for (const [, label, hint] of entries) {
      expect(JA[label], label).toBeDefined();
      expect(JA[hint], hint).toBeDefined();
    }
  });

  it("writing tones (SettingsModal) render as t(tone.label), and every preset has JA", () => {
    const s = src("SettingsModal");
    expect(s).toMatch(/\{t\(tone\.label\)\}/);
    const table = s.slice(s.indexOf("const WRITING_TONES"), s.indexOf("];", s.indexOf("const WRITING_TONES")));
    const labels = [...table.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const label of labels) expect(JA[label], label).toBeDefined();
  });
});

describe("the Editor title tooltip tells the truth (MISS-10, promise-sync-6)", () => {
  const KEY =
    "Editing the title writes it as the Markdown H1; it also titles any slide content before the first heading";
  const chunk = (id: string, type: ChunkType, content: string): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType: type, linkedChunks: [] },
  });

  it("is wired on the title input and translated", () => {
    const editor = src("Editor");
    const input = editor.slice(editor.indexOf("value={title}"), editor.indexOf("/>", editor.indexOf("value={title}")));
    expect(input).toContain(`title={t("${KEY}")}`);
    expect(JA[KEY]).toBe(
      "タイトルを編集するとMarkdownのH1として書き込まれます。スライドでは最初の見出しより前の内容のタイトルにもなります"
    );
  });

  it("the document title is written as the Markdown H1 (no Markdown baseline)", () => {
    const doc: Document = { id: "d", title: "報告書", mode: "editor", chunks: [chunk("a", "text", "本文")] };
    expect(documentToMarkdown(doc).split("\n")[0]).toBe("# 報告書");
  });

  it("an opened .md without an H1 gains one only when the title is EDITED (what the tooltip says)", () => {
    const blank: Document = { id: "d", title: "notes", mode: "markdown", chunks: [chunk("a", "text", "")] };
    useStore.getState().loadDocument(markdownToDocument(blank, "body\n"), "/notes.md");
    expect(useStore.getState().doc.title).toBe("notes");
    expect(documentToMarkdown(useStore.getState().doc)).toBe("body\n"); // shown title, no H1 on disk
    useStore.getState().setTitle("報告書");
    expect(documentToMarkdown(useStore.getState().doc)).toBe("# 報告書\n\nbody\n");
  });

  it("content before the first heading is titled by the document title; a heading slide is not", () => {
    const [lead, headed] = groupSlides([chunk("a", "text", "intro"), chunk("h", "heading", "Methods")]);
    expect(slideTitle(lead, "報告書")).toBe("報告書");
    expect(slideTitle(headed, "報告書")).toBe("Methods");
  });
});

describe("ChunkView's 'What changed' word diff uses the diff tokens (ui.md #9)", () => {
  it("marks insertions with additive-mark and deletions with removed-mark, like DiffPanel", () => {
    const view = src("ChunkView");
    const diff = view.slice(view.indexOf("wordDiff(prevVersion"), view.indexOf(")}\n              </p>"));
    expect(diff).toMatch(/<mark key=\{i\} className="rounded bg-additive-mark\/70 text-ink">/);
    expect(diff).toMatch(/className="rounded bg-removed-mark\/50 text-ink-faint line-through"/);
    expect(diff).not.toMatch(/emerald|\bred-\d/);
  });
});

describe("dictionary placeholders survive translation", () => {
  it("every JA value has the same {placeholders} as its key", () => {
    // Deliberate: the Japanese draft-length labels count characters, not words
    // (draftLength.ts passes both {words} and {chars}).
    const unitSwap = new Set([
      "Short (~{words} words)",
      "Medium (~{words} words)",
      "Long (~{words} words)",
      "Very long (~{words} words)",
    ]);
    const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    const mismatched = Object.entries(JA)
      .filter(([k, v]) => !unitSwap.has(k) && holders(k) !== holders(v))
      .map(([k, v]) => `${k} => ${v}`);
    expect(mismatched).toEqual([]);
    for (const k of unitSwap) expect(holders(JA[k])).toBe("{chars}");
  });
});
