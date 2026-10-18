import { describe, expect, it } from "vitest";
import { HELP_I18N } from "./components/HelpModal";
import { JA } from "./i18n";

// Help names on-screen controls. Those names must be the labels the user
// actually sees: the Japanese bundle must say what the Japanese chrome says
// (UX-HELP-JA-ENGLISH), and no bundle may promise a print dialog for PDF —
// PDF export goes through a native save dialog (BUG-003).

const helpSource = (
  import.meta.glob("./components/HelpModal.tsx", { eager: true, query: "?raw", import: "default" }) as Record<
    string,
    string
  >
)["./components/HelpModal.tsx"];

/** Every string VALUE in one language's bundle (not the field names, which
 *  are English identifiers like `openSettingsBtn`), joined — scoped to that
 *  bundle only. */
function bundleText(lang: keyof typeof HELP_I18N): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(HELP_I18N[lang]);
  return out.join("\n");
}

describe("Japanese Help names controls exactly as the Japanese UI does", () => {
  const ja = bundleText("日本語");

  // Keys chosen so no English key is a substring of unrelated help text
  // (e.g. "Save" would also match OpenRouter's "Create Key" path; it's not here).
  const controls = [
    "Draft by AI",
    "Analyze",
    "Settings",
    "Default language",
    "Writing tone",
    "OpenRouter API key",
    "Translate…",
    "Proofread…",
    "Expand",
    "Add detail",
    "Concentrate",
    "Focus",
    "Custom instruction…",
    "Limit ghost-text completion to a local model",
    "Read this paragraph aloud",
    "Import / Export",
    "Find and Replace…",
    "Go to Line…",
    "Replace All",
    "Save As…",
    "Close tab",
    "Don't Save",
  ];

  it.each(controls)("uses the Japanese label for %s, never the English one", (key) => {
    expect(JA[key], `no JA entry for ${key}`).toBeTruthy();
    expect(ja).not.toContain(key);
    expect(ja).toContain(JA[key]);
  });

  it("every label the bundle interpolates has a JA entry (ja() would fall back to English)", () => {
    const keys = [...helpSource.matchAll(/\bja\("((?:[^"\\]|\\.)+)"\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    const missing = keys.filter((k) => !JA[k]);
    expect(missing).toEqual([]);
  });

  it("step 2 names the ✨ menu by the trigger's own tooltip / accessible name (not the retired 'AI actions')", () => {
    // ChunkAiMenu's paragraph trigger label (pinned in uiCopyClaims.test.ts).
    const step2 = HELP_I18N["日本語"].steps.find((s) => s.title.startsWith("2. "))?.body ?? "";
    expect(step2).toContain(`✨（${JA["Rewrite, translate or illustrate with AI…"]}）`);
    expect(step2).not.toContain("AI操作");
  });

  it("the Open Settings button reads 設定を開く", () => {
    expect(HELP_I18N["日本語"].openSettingsBtn).toBe("設定を開く");
  });

  it("the ghost-text paragraph names the Settings switch by its Japanese label", () => {
    const body = HELP_I18N["日本語"].ghostText?.body ?? "";
    expect(body).toContain(`「${JA["Limit ghost-text completion to a local model"]}」`);
  });

  it("documents Find/Replace, Save As and closing tabs in the editing section", () => {
    const body = HELP_I18N["日本語"].editing?.body ?? "";
    for (const chord of ["⌘F", "⌥⌘F", "⌘G", "⇧⌘G", "⌘L", "⇧⌘S"]) expect(body).toContain(chord);
    // The 3-choice unsaved dialog, in the dialog's own Japanese labels.
    for (const k of ["Save", "Don't Save", "Cancel"]) expect(body).toContain(`「${JA[k]}」`);
  });
});

describe("English Help covers the same behaviours", () => {
  it("documents Find/Replace, Save As and the 3-choice unsaved dialog", () => {
    const body = HELP_I18N.English.editing?.body ?? "";
    for (const chord of ["⌘F", "⌥⌘F", "⌘G", "⇧⌘G", "⌘L", "⇧⌘S"]) expect(body).toContain(chord);
    for (const label of ["“Save As…”", "Save / Don't Save / Cancel", "untitled tab"]) expect(body).toContain(label);
  });

  it("says ghost text appears after typing, not on focus", () => {
    const body = HELP_I18N.English.ghostText?.body ?? "";
    expect(body).toMatch(/After you type/);
    expect(body).toMatch(/never requests one/);
  });
});

describe("no Help bundle promises a print dialog for PDF export", () => {
  const printDialog =
    /print dialog|Save as PDF|印刷ダイアログ|PDFとして保存|打印对话框|diálogo de impresión|boîte de dialogue d['’]impression|Enregistrer au format PDF/i;

  it.each(Object.keys(HELP_I18N) as (keyof typeof HELP_I18N)[])("%s", (lang) => {
    const saveStep = HELP_I18N[lang].steps[5].body;
    expect(saveStep).toMatch(/pdf/i);
    expect(bundleText(lang)).not.toMatch(printDialog);
  });
});

describe("promise-sync-5 — Help step 3 / step 6 match where diagrams live and how PDF prints them", () => {
  const langs = Object.keys(HELP_I18N) as (keyof typeof HELP_I18N)[];
  const step = (lang: keyof typeof HELP_I18N, n: number) =>
    HELP_I18N[lang].steps.find((s) => s.title.startsWith(`${n}. `))?.body ?? "";

  it.each(langs)("%s: step 3 sends diagrams to the ✨ menu's Generate diagram…", (lang) => {
    const body = step(lang, 3);
    expect(body).toContain("✨");
    expect(body).toContain(lang === "日本語" ? "「図を生成…」" : "Generate diagram…");
  });

  it("English step 3 no longer puts diagram conversion in the right gutter", () => {
    expect(step("English", 3)).not.toMatch(/right gutter, generate an image, or convert/);
  });

  it.each(langs)("%s: step 6 says diagrams print as Mermaid source (pdf.rs), not placeholders", (lang) => {
    const body = step(lang, 6);
    expect(body).toContain("Mermaid");
    expect(body).not.toMatch(/images and diagrams become text placeholders|画像と図はテキストの代替表示/);
  });

  it("English step 6 states the PDF diagram behaviour exactly", () => {
    expect(step("English", 6)).toMatch(/images become text placeholders and diagrams print as their Mermaid source/);
  });
});

// ----- BUG-008 (QA 20261003): Help §6 lists every export format the menus offer
// Help §6 ("Save & export") listed .txt / .md / .rtf / .pdf while both export
// menus also offered .pptx. The format list is derived from the code that
// BUILDS the menus — the native File → Export submenu (menu.rs `export_<ext>`
// item ids) and the toolbar's Import / Export dropdown (Toolbar.tsx) — so a
// format added to a menu without a Help mention fails here, in every language.

const menuSources = import.meta.glob(["../src-tauri/src/menu.rs", "./components/Toolbar.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Export formats the native menu builds: `export_<ext>` item ids in
 *  production code only (menu.rs's #[cfg(test)] module excluded). */
const nativeMenuExportExts = (): string[] => {
  const prod = menuSources["../src-tauri/src/menu.rs"].split("#[cfg(test)]")[0];
  return [...prod.matchAll(/with_id\("export_([a-z0-9]+)"/g)].map((m) => m[1]);
};

/** Export formats the toolbar's Import / Export dropdown renders — scoped to
 *  the dropdown body after its "Export as" header: the `.{fmt}` loop's array
 *  literal plus the literal `.ext` buttons (.pptx, .pdf). */
const toolbarExportExts = (): string[] => {
  const src = menuSources["./components/Toolbar.tsx"];
  const start = src.indexOf('t("Export as")');
  if (start < 0) return [];
  const end = src.slice(start).search(/<\/div>\s*\)\}/);
  const dropdown = src.slice(start, end < 0 ? undefined : start + end);
  const loop = dropdown.match(/\(\[([^\]]*)\]\s*as ExportFormat\[\]\)/)?.[1] ?? "";
  const looped = [...loop.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  const literal = [...dropdown.matchAll(/\/>\s*\.([a-z0-9]+)\s*</g)].map((m) => m[1]);
  return [...looped, ...literal];
};

/** `.ext` file-extension tokens in `text`: a dot not glued to a preceding
 *  word/dot (so "openrouter.ai" is not one), not followed by more letters (so
 *  ".ppt" never passes on ".pptx"). Works beside CJK text and punctuation. */
const extTokens = (text: string): string[] =>
  [...text.matchAll(/(?<![A-Za-z0-9_.])\.([a-z0-9]{2,5})(?![A-Za-z0-9])/g)].map((m) => m[1]);

/** The native .aix format is SAVED, not exported — the one other extension §6 may name. */
const NATIVE_SAVE_EXT = "aix";

const sorted = (xs: string[]) => [...new Set(xs)].sort();

/** The enumerated format list in a §6 body (".txt / .md / … / .pdf"): the
 *  first run of two or more `.ext` tokens joined by "/" — the list QA compared
 *  against the menu. A mention elsewhere in §6 (e.g. "PowerPoint (.pptx)
 *  export …") must not stand in for the list. */
const formatList = (body: string): string[] =>
  extTokens(body.match(/\.[a-z0-9]+(?:\s*\/\s*\.[a-z0-9]+)+/)?.[0] ?? "");

/** Help §6 body for one language — the section under test, never the whole bundle. */
const saveExportSection = (lang: keyof typeof HELP_I18N): string =>
  HELP_I18N[lang].steps.find((s) => s.title.startsWith("6. "))?.body ?? "";

describe("BUG-008 — Help §6 names every export format the menus offer", () => {
  const langs = Object.keys(HELP_I18N) as (keyof typeof HELP_I18N)[];
  const menuExts = () => sorted([...nativeMenuExportExts(), ...toolbarExportExts()]);

  it("the scans actually find the export formats (a broken scan must not pass vacuously)", () => {
    expect(nativeMenuExportExts().length).toBeGreaterThanOrEqual(5);
    expect(toolbarExportExts().length).toBeGreaterThanOrEqual(5);
    expect(nativeMenuExportExts()).toContain("pptx");
    expect(toolbarExportExts()).toContain("pptx");
    // The token extractor itself, on Latin and CJK neighbours.
    expect(extTokens("「読み込み / 書き出し」から .txt と（.pptx）、.pdfに。openrouter.ai")).toEqual([
      "txt",
      "pptx",
      "pdf",
    ]);
    expect(extTokens("export to .ppt or .pptx.")).toEqual(["ppt", "pptx"]);
    expect(formatList("Save .aix, or export to .txt / .md / .pdf. PowerPoint (.pptx) export …")).toEqual([
      "txt",
      "md",
      "pdf",
    ]);
    expect(formatList("「読み込み / 書き出し」メニューから .txt / .pptx に書き出せます")).toEqual(["txt", "pptx"]);
  });

  it("the toolbar dropdown and the native Export submenu offer the same formats", () => {
    expect(sorted(toolbarExportExts())).toEqual(sorted(nativeMenuExportExts()));
  });

  it.each(langs)("%s: §6's format list is exactly the menus' export formats (incl. .pptx)", (lang) => {
    const body = saveExportSection(lang);
    expect(body, `${lang} has no step "6. …"`).not.toBe("");
    const listed = formatList(body);
    const missing = menuExts().filter((ext) => !listed.includes(ext));
    expect(missing, `${lang} §6 list omits .${missing.join(", .")}`).toEqual([]);
    expect(sorted(listed)).toEqual(menuExts());
  });

  it.each(langs)("%s: §6 names no export format the menus lack", (lang) => {
    const allowed = [...menuExts(), NATIVE_SAVE_EXT];
    const extra = extTokens(saveExportSection(lang)).filter((ext) => !allowed.includes(ext));
    expect(extra).toEqual([]);
  });
});

describe("BUG-008 — §6's PPTX sentence names the Slides view and speaker notes as the UI does", () => {
  // Behaviour behind the sentence is guarded in Rust: deck.rs
  // `headings_delimit_slides` (headings → slides) and pptx.rs
  // `slide_with_notes_gets_a_notes_slide_part_containing_its_text` (notes page).
  it("English", () => {
    const body = saveExportSection("English");
    expect(body).toMatch(/PowerPoint \(\.pptx\) export builds slides from the document’s headings, as in Slides mode/);
    expect(body).toMatch(/speaker notes on its notes page/);
  });

  it("日本語 uses the Japanese chrome's own labels for the view and the notes", () => {
    const body = saveExportSection("日本語");
    expect(body).toContain(`「${JA["Slides"]}」表示`);
    expect(body).toContain(JA["Speaker notes"]);
    expect(body).not.toMatch(/Slides|Speaker notes/);
  });
});
