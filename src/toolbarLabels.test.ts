import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { settingsButtonLabel } from "./toolbarLabels";

// UX-label-model: the toolbar settings button's tooltip AND accessible name.
const tJa = (k: string) => translate(k, "ja");
const tEn = (k: string) => translate(k, "en");

describe("settingsButtonLabel", () => {
  it("settings button label is Japanese in the Japanese UI", () => {
    expect(settingsButtonLabel("google/gemma-4-31b-it:free", true, tJa)).toBe(
      "モデル: google/gemma-4-31b-it:free"
    );
    expect(settingsButtonLabel("", true, tJa)).toBe("モデル: (既定)");
  });

  it("stays English in the English UI", () => {
    expect(settingsButtonLabel("x/y", true, tEn)).toBe("Model: x/y");
    expect(settingsButtonLabel("", true, tEn)).toBe("Model: (default)");
  });

  it("asks for a key when none is stored", () => {
    expect(settingsButtonLabel("x/y", false, tEn)).toBe("API key not set — click to configure");
    expect(settingsButtonLabel("x/y", false, tJa)).toBe(
      translate("API key not set — click to configure", "ja")
    );
    expect(settingsButtonLabel("x/y", false, tJa)).not.toBe("API key not set — click to configure");
  });
});

// Wiring guard: the Toolbar settings button must use the helper for BOTH its
// tooltip and its accessible name (it is otherwise icon-only — ui.md #1).
describe("Toolbar wiring", () => {
  const sources = import.meta.glob("./components/Toolbar.tsx", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;
  const toolbar = sources["./components/Toolbar.tsx"];

  it("the settings button takes title and aria-label from settingsButtonLabel", () => {
    const at = toolbar.indexOf("onClick={openSettings}");
    expect(at).toBeGreaterThan(-1);
    const button = toolbar.slice(toolbar.lastIndexOf("<button", at), toolbar.indexOf(">", at));
    expect(button).toMatch(/title=\{settingsLabel\}/);
    expect(button).toMatch(/aria-label=\{settingsLabel\}/);
    expect(toolbar).toMatch(/const settingsLabel = settingsButtonLabel\(/);
    expect(toolbar).not.toMatch(/`Model: /);
  });

  it("toolbar dropdowns close on Escape, IME-safe, and every one is wired", () => {
    const hook = toolbar.slice(toolbar.indexOf("function useDropdownDismiss"), toolbar.indexOf("export default function Toolbar"));
    const escape = hook.indexOf('e.key === "Escape"');
    expect(escape).toBeGreaterThan(-1);
    const onKey = hook.slice(hook.indexOf("const onKey"), escape);
    expect(onKey).toContain("isImeKeyEvent(e)");
    for (const menu of ["fileMenuOpen", "openMenuOpen", "saveMenuOpen"]) {
      expect(toolbar, menu).toMatch(new RegExp(`useDropdownDismiss\\(${menu},`));
      expect(toolbar, menu).toMatch(new RegExp(`expanded=\\{${menu}\\}`));
    }
  });

  it("the Save chevron is a named control that opens Save / Save As…", () => {
    const at = toolbar.indexOf("onClick={() => setSaveMenuOpen((v) => !v)}");
    expect(at).toBeGreaterThan(-1);
    const chevron = toolbar.slice(at, toolbar.indexOf("</button>", at));
    expect(chevron).toMatch(/title=\{t\("More save options"\)\}/);
    expect(chevron).toMatch(/aria-label=\{t\("More save options"\)\}/);
    const menu = toolbar.slice(toolbar.indexOf("{saveMenuOpen && ("), toolbar.indexOf("toggleFolderTree()"));
    expect(menu).toMatch(/onClick=\{onSaveAs\}[\s\S]*t\("Save As…"\)[\s\S]*⇧⌘S/);
    expect(toolbar).toMatch(/const onSaveAs = \(\) => \{[\s\S]{0,80}saveNativeAs\(\)/);
  });

  it("the collapsed files toggle says 'Show files', not the bare header word", () => {
    const at = toolbar.indexOf("onClick={() => toggleFolderTree()}");
    const btn = toolbar.slice(at, toolbar.indexOf("</ToolButton>", at));
    expect(btn).toMatch(/folderTreeOpen \? t\("Hide files"\) : t\("Show files"\)/);
  });

  it("the Import / Export tooltip names every export format the menu offers", () => {
    const m = /title=\{t\("(Import[^"]*)"\)\}/.exec(toolbar);
    expect(m).not.toBeNull();
    const title = m![1];
    for (const f of [".txt", ".md", ".rtf", ".pptx", ".pdf"]) expect(title).toContain(f);
  });
});
