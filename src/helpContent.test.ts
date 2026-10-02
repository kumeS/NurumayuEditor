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
