// Raw-source guards for the Settings dialog polish pass (ui-polish, wave 5).
// vitest runs without a DOM, so these assert the wiring in the component
// source, each scoped to the element under test (testing.md rule 2).

import { describe, expect, it } from "vitest";
import { JA } from "./i18n";

const SOURCES = import.meta.glob(
  ["./components/SettingsModal.tsx", "./components/OpenRouterModelCatalog.tsx"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(name: "SettingsModal" | "OpenRouterModelCatalog"): string {
  const s = SOURCES[`./components/${name}.tsx`];
  expect(s, `${name}.tsx not found`).toBeTruthy();
  return s;
}

/** The whole `<tag …>…</tag>` element that contains `marker`. */
function elementAround(source: string, marker: string, tag: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf(`<${tag}`, at);
  const end = source.indexOf(`</${tag}>`, at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return source.slice(start, end);
}

const RAW_SCALE = /\b(?:gray|slate|zinc|neutral|red|amber|emerald|green|blue|yellow)-\d+/g;
const CJK = /[぀-ヿ一-龯]/;

describe("SettingsModal: semantic colour tokens (ui.md rule 9)", () => {
  it("uses no raw gray/red/amber/… scale class", () => {
    expect(src("SettingsModal").match(RAW_SCALE) ?? []).toEqual([]);
  });

  it("the unavailable (404) marker uses the danger token, the catalog marker warn-strong", () => {
    const s = src("SettingsModal");
    expect(elementAround(s, '{t("Unavailable (404)")}', "span")).toContain("text-danger");
    expect(elementAround(s, '{t("Not found in the current OpenRouter catalog")}', "span")).toContain(
      "text-warn-strong"
    );
  });
});

describe("SettingsModal: every control has an accessible name (ui.md rule 1)", () => {
  it("each <label> either wraps its input or points at one with htmlFor", () => {
    const s = src("SettingsModal");
    const labels = [...s.matchAll(/<label\b[\s\S]*?<\/label>/g)].map((m) => m[0]);
    expect(labels.length).toBeGreaterThan(8);
    const unlinked = labels.filter((l) => !/htmlFor=/.test(l) && !/<input\b/.test(l));
    expect(unlinked).toEqual([]);
  });

  it("every htmlFor target exists exactly once as an id", () => {
    const s = src("SettingsModal");
    const targets = [...s.matchAll(/htmlFor=\{([^}]+)\}/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(8);
    for (const target of targets) {
      const ids = s.split(`id={${target}}`).length - 1;
      expect(ids, target).toBe(1);
    }
  });

  it("the model lists are named groups and the add inputs carry an aria-label", () => {
    const s = src("SettingsModal");
    expect(s).toMatch(/role="group"\s+aria-labelledby=\{labelId\}/);
    const addInput = s.slice(s.indexOf("value={addValue}"), s.indexOf("/>", s.indexOf("value={addValue}")));
    expect(addInput).toContain("aria-label={placeholder}");
  });

  it("model rows expose the active model as aria-pressed (not only the ✓ glyph)", () => {
    const row = elementAround(src("SettingsModal"), "onClick={() => update(activeKey, m)}", "button");
    expect(row).toContain("aria-pressed={isActive}");
  });

  it("the header close button has a tooltip as well as an accessible name", () => {
    const close = elementAround(src("SettingsModal"), 'aria-label={t("Close")}', "button");
    expect(close).toContain('title={t("Close")}');
  });
});

describe("SettingsModal: busy scope matches dismissible={!saving}", () => {
  it("Cancel and the header close button are disabled while saving", () => {
    const s = src("SettingsModal");
    expect(elementAround(s, '{t("Cancel")}', "button")).toContain("disabled={saving}");
    expect(elementAround(s, 'aria-label={t("Close")}', "button")).toContain("disabled={saving}");
  });
});

describe("SettingsModal: Remove key is a confirmed destructive action (ui.md rules 5, 6)", () => {
  const clearKey = () => {
    const s = src("SettingsModal");
    const start = s.indexOf("const clearKey = async");
    expect(start).toBeGreaterThan(-1);
    return s.slice(start, s.indexOf("\n  };", start));
  };

  it("asks with a native dialog before deleting the keychain entry", () => {
    const body = clearKey();
    const askAt = body.indexOf("await ask(");
    const deleteAt = body.indexOf("api.deleteApiKey(");
    expect(askAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(askAt);
    expect(body.slice(askAt, deleteAt)).toMatch(/if \(!\w+\) return;/);
    expect(src("SettingsModal")).toMatch(/import \{ ask \} from "@tauri-apps\/plugin-dialog";/);
  });

  it("the dialog's buttons say what they do (never OK) and the copy has JA", () => {
    const body = clearKey();
    expect(body).toContain('okLabel: tNow("Remove key")');
    expect(body).toContain('cancelLabel: tNow("Cancel")');
    const msg = body.match(/await ask\(\s*tNow\(\s*"([^"]+)"\s*\)/);
    expect(msg).not.toBeNull();
    expect(JA[msg![1]]).toMatch(CJK);
  });

  it("success is quiet: the inline key state flips, no success toast", () => {
    expect(clearKey()).toContain("setHasApiKey(false)");
    expect(clearKey()).not.toContain('"success"');
  });
});

describe("SettingsModal: editor-font help copy", () => {
  it("the English half has no stray Japanese; the Japanese half names the options as the picker does", () => {
    const s = src("SettingsModal");
    const en = s.match(/"(Applies to body paragraphs in the editor[^"]*)"/);
    const ja = s.match(/"(エディタ本文の段落に適用[^"]*)"/);
    expect(en).not.toBeNull();
    expect(ja).not.toBeNull();
    expect(en![1]).not.toMatch(CJK);
    expect(ja![1]).not.toMatch(/\b(?:Sans|Mono|Serif)\b/);
    expect(ja![1]).toContain(JA["Sans"]);
    expect(ja![1]).toContain(JA["Mono"]);
  });
});

describe("OpenRouterModelCatalog: modality badges stay visible on the selected row", () => {
  it("badges use a neutral token, not the accent tint the active row uses", () => {
    const c = src("OpenRouterModelCatalog");
    expect(c).toContain('isActive ? "bg-accent/10"');
    for (const label of ['{t("Text output")}', '{t("Image output")}']) {
      const badge = elementAround(c, label, "span");
      expect(badge, label).not.toContain("accent");
      expect(badge, label).toMatch(/\bbg-chrome-\w+/);
    }
  });
});

describe("ux-a11y-i18n-5 — 'Browse OpenRouter models…' lands on the open catalog", () => {
  const palette = Object.values(
    import.meta.glob("./components/CommandPalette.tsx", { eager: true, query: "?raw", import: "default" })
  )[0] as string;

  it("the palette entry opens Settings focused on the model catalog", () => {
    const at = palette.indexOf('id: "browse-openrouter-models"');
    expect(at).toBeGreaterThan(-1);
    const entry = palette.slice(at, palette.indexOf("},", at));
    expect(entry).toMatch(/run: wrap\(\(\) => s\.openSettings\("model-catalog"\)\)/);
  });

  it("Settings passes autoOpen to the TEXT model catalog only, from settingsFocus", () => {
    const s = src("SettingsModal");
    expect(s).toMatch(/autoOpen=\{settingsFocus === "model-catalog" && kind === "text"\}/);
  });

  it("the catalog starts expanded and focuses its Fetch button when autoOpen", () => {
    const c = src("OpenRouterModelCatalog");
    expect(c).toMatch(/useState\(autoOpen\)/);
    expect(c).toMatch(/if \(el && autoOpen\) \{\s*el\.scrollIntoView\(\{ block: "center" \}\);\s*el\.focus\(\);/);
    expect(c).toMatch(/ref=\{fetchButton\}/);
  });
});
