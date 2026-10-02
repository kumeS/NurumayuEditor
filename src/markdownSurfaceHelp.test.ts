import { describe, expect, it } from "vitest";
import { JA, translate } from "./i18n";
import { MARKDOWN_SURFACES, PREVIEW_SCOPE_NOTE, helperFor } from "./markdownSurfaceHelp";
import { useStore } from "./store";

const raw = import.meta.glob(["./components/MarkdownEditor.tsx", "./components/PreviewBackgroundPicker.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const editor = raw["./components/MarkdownEditor.tsx"];
const picker = raw["./components/PreviewBackgroundPicker.tsx"];

describe("helperFor — the Markdown helper line names the current surface (MISS-08)", () => {
  it("gives each surface its own sentence", () => {
    expect(helperFor("edit")).toBe("Editing Markdown source.");
    expect(helperFor("split")).toBe("Left: source · Right: preview (click text to edit).");
    expect(helperFor("preview")).toBe("Click text to edit it directly; switch to Edit for the full Markdown source.");
    expect(new Set(MARKDOWN_SURFACES.map(helperFor)).size).toBe(3);
  });

  it("every helper sentence has Japanese copy", () => {
    expect(translate(helperFor("edit"), "ja")).toBe("Markdownソースを編集中です。");
    expect(translate(helperFor("split"), "ja")).toBe("左: ソース · 右: プレビュー(テキストをクリックして編集)。");
    expect(translate(helperFor("preview"), "ja")).toBe(
      "テキストをクリックすると直接編集できます。Markdownソース全体は「編集」で編集します。"
    );
  });

  it("MarkdownEditor renders helperFor(surface), not one fixed sentence", () => {
    expect(editor).toMatch(/\{t\(helperFor\(surface\)\)\}/);
    expect(editor).not.toContain("Edit source or click rendered text to edit it directly.");
  });
});

describe("preview zoom / background say they are app-wide (MISS-07)", () => {
  it("the scope note is translated", () => {
    expect(PREVIEW_SCOPE_NOTE).toBe("Applies to all Markdown documents");
    expect(JA[PREVIEW_SCOPE_NOTE]).toBe("すべてのMarkdown文書に適用");
  });

  it("zoom out / reset / zoom in and the background picker all carry the note", () => {
    const zoomGroup = editor.slice(editor.indexOf('aria-label={t("Preview zoom")}'), editor.indexOf("<PreviewBackgroundPicker"));
    const titles = [...zoomGroup.matchAll(/title=\{`([^`]*)`\}/g)].map((m) => m[1]);
    expect(titles).toHaveLength(3);
    for (const title of titles) expect(title).toContain("${t(PREVIEW_SCOPE_NOTE)}");
    const trigger = picker.slice(picker.indexOf("<button"), picker.indexOf(">", picker.indexOf("title=")));
    expect(trigger).toMatch(/title=\{`[^`]*\$\{t\(PREVIEW_SCOPE_NOTE\)\}[^`]*`\}/);
  });

  it("the claim holds: zoom is app-level (survives a tab switch); the background is a setting, not per document", () => {
    const s = () => useStore.getState();
    const first = s().activeTabId;
    s().setMarkdownZoom(1.4);
    s().newTab("markdown");
    expect(s().activeTabId).not.toBe(first);
    expect(s().markdownZoom).toBe(1.4);
    if (first) s().switchTab(first);
    expect(s().markdownZoom).toBe(1.4);
    s().setMarkdownZoom(1);
    // The picker reads/writes settings.previewBackground (previewBackground.test.ts
    // covers the persistence); MarkdownEditor derives the tone from settings only.
    expect(editor).toMatch(/previewBackgroundOf\(state\.settings\)/);
  });
});
