import { describe, expect, it } from "vitest";

// Contract: native menu (src-tauri/src/menu.rs) ↔ App.tsx dispatch ↔ command
// palette (ui.md #3 — every command has a palette entry). Source defect: Save
// As existed in the menu and App but never reached the palette (BUG-009c).

const raw = import.meta.glob(
  ["../src-tauri/src/menu.rs", "./App.tsx", "./components/CommandPalette.tsx"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

const menuRs = raw["../src-tauri/src/menu.rs"];
const app = raw["./App.tsx"];
const palette = raw["./components/CommandPalette.tsx"];

/** Menu item ids built in production code (the #[cfg(test)] module excluded). */
const menuIds = (): string[] => {
  const prod = menuRs.split("#[cfg(test)]")[0];
  return [...prod.matchAll(/with_id\("([a-z_]+)"/g)].map((m) => m[1]);
};

/** `case "…":` labels inside the App's native-menu listener only. */
const appMenuCases = (): string[] => {
  const start = app.indexOf('listen<string>("menu"');
  const end = app.indexOf("return () =>", start);
  const listener = app.slice(start, end);
  return [...listener.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
};

/** Palette command ids inside the commands array only. */
const paletteIds = (): string[] => {
  const start = palette.indexOf("const commands = useMemo");
  const end = palette.indexOf("const filtered", start);
  return [...palette.slice(start, end).matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
};

// Native menu id → palette command id. Adding a menu item forces a decision
// here (the find items and File → Close Tab landed with BUG-010).
const MENU_TO_PALETTE: Record<string, string> = {
  new_tab: "new-tab",
  open: "open",
  open_folder: "open-folder",
  save: "save",
  save_as: "save-as",
  import: "import",
  export_txt: "export-txt",
  export_md: "export-md",
  export_rtf: "export-rtf",
  export_pptx: "export-pptx",
  export_pdf: "export-pdf",
  undo: "undo",
  redo: "redo",
  settings: "settings",
  analyze: "analyze",
  draft: "draft",
  help: "help",
  close_tab: "close-tab",
  find: "find",
  find_replace: "find-replace",
  find_next: "find-next",
  find_previous: "find-previous",
  go_to_line: "go-to-line",
};
const EXEMPT = ["quit"]; // Cmd+Q is the app-level accelerator, not a palette verb.

describe("native menu contract", () => {
  it("the scans actually find the ids", () => {
    expect(menuIds().length).toBeGreaterThan(15);
    expect(appMenuCases().length).toBeGreaterThan(15);
    expect(paletteIds().length).toBeGreaterThan(20);
  });

  it("every native menu item is dispatched by App.tsx", () => {
    const cases = appMenuCases();
    expect(menuIds().filter((id) => !cases.includes(id))).toEqual([]);
  });

  it("every native menu command has a palette entry", () => {
    const unmapped = menuIds().filter((id) => !(id in MENU_TO_PALETTE) && !EXEMPT.includes(id));
    expect(unmapped).toEqual([]);
    const ids = paletteIds();
    const missing = menuIds()
      .filter((id) => id in MENU_TO_PALETTE)
      .filter((id) => !ids.includes(MENU_TO_PALETTE[id]))
      .map((id) => `${id} → ${MENU_TO_PALETTE[id]}`);
    expect(missing).toEqual([]);
  });
});

// The palette and the native menu name the same find commands; in Japanese
// they must read the same too (menu.rs JA table ↔ src/i18n.ts JA dictionary).
describe("find labels agree between the native menu and the palette (BUG-010)", () => {
  const menuJa = (): Record<string, string> => {
    const table = menuRs.slice(menuRs.indexOf("const JA"), menuRs.indexOf("];", menuRs.indexOf("const JA")));
    return Object.fromEntries([...table.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
  };

  it.each(["Find…", "Find and Replace…", "Find Next", "Find Previous", "Go to Line…"])("%s", async (label) => {
    const { translate } = await import("./i18n");
    expect(menuJa()[label], `menu.rs JA entry for ${label}`).toBeTruthy();
    expect(translate(label, "ja")).toBe(menuJa()[label]);
    expect(palette).toContain(`label: t("${label}")`);
  });
});
