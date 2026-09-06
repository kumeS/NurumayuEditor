import { describe, expect, it } from "vitest";
import { JA, translate, uiLangFor } from "./i18n";

describe("uiLangFor — the Settings 'Default language' drives the UI language", () => {
  it("maps 日本語 to the Japanese UI", () => {
    expect(uiLangFor("日本語")).toBe("ja");
  });

  it("maps English (and every other output language) to the English UI", () => {
    expect(uiLangFor("English")).toBe("en");
    expect(uiLangFor("Français")).toBe("en");
    expect(uiLangFor("中文")).toBe("en");
  });

  it("falls back to English before settings have loaded", () => {
    expect(uiLangFor(undefined)).toBe("en");
    expect(uiLangFor("")).toBe("en");
  });
});

describe("translate", () => {
  it("returns the key verbatim in English — the keys ARE the English copy", () => {
    expect(translate("Save", "en")).toBe("Save");
    expect(translate("Open Folder…", "en")).toBe("Open Folder…");
  });

  it("returns the Japanese copy in Japanese", () => {
    expect(translate("Save", "ja")).toBe("保存");
    expect(translate("Open Folder…", "ja")).toBe("フォルダを開く…");
  });

  it("falls back to the English key for a string that has no Japanese entry yet", () => {
    expect(translate("A string nobody has translated", "ja")).toBe(
      "A string nobody has translated"
    );
  });
});

describe("the Japanese dictionary itself", () => {
  it("has no blank entries (a blank would render as an invisible label)", () => {
    const blank = Object.entries(JA).filter(([, value]) => !value.trim());
    expect(blank).toEqual([]);
  });

  it("never maps a key to the identical English string (that entry would be dead weight)", () => {
    // Allow deliberate identity entries only for strings that are the same in
    // both languages (product names, symbols); flag accidental copy-paste.
    const identity = Object.entries(JA).filter(([key, value]) => key === value);
    expect(identity).toEqual([]);
  });

  it("actually contains Japanese characters for a sample of core chrome", () => {
    const cjk = /[぀-ヿ一-龯]/;
    for (const key of ["Save", "Open", "Settings", "Help", "Undo", "Redo"]) {
      expect(JA[key], `missing translation for "${key}"`).toBeDefined();
      expect(cjk.test(JA[key]), `"${key}" → "${JA[key]}" is not Japanese`).toBe(true);
    }
  });
});

// The promise this file guards: "switch Default language to 日本語 and the whole
// interface is Japanese". A new `t("…")` call with no dictionary entry would
// silently render English inside an otherwise-Japanese UI, so scan the source.
describe("dictionary coverage of the real UI", () => {
  it("has a Japanese entry for every t()/tNow() key used in the app", () => {
    // Vite's glob (not node:fs) so this stays dependency-free and runs the same
    // way the app is built.
    const sources = import.meta.glob("./**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    const used = new Set<string>();
    for (const [path, source] of Object.entries(sources)) {
      if (/\.test\.tsx?$/.test(path) || path.endsWith("/i18n.ts")) continue;
      for (const m of source.matchAll(/\bt(?:Now)?\("((?:[^"\\]|\\.)+)"\)/g)) used.add(m[1]);
    }

    // "AI" is deliberately identical in both languages (see the dictionary).
    const allowedUntranslated = new Set(["AI"]);
    const missing = [...used].filter((k) => !(k in JA) && !allowedUntranslated.has(k)).sort();
    expect(missing, `untranslated UI strings: ${missing.join(" | ")}`).toEqual([]);
    expect(used.size).toBeGreaterThan(100); // the scan actually found the call sites
  });
});

// The complement of the coverage test above: a bare English literal in JSX is
// invisible to the dictionary (nothing to look up), so it silently stays
// English in a Japanese UI. Both real bugs found during the Japanese pass were
// this shape — a placeholder and an inline `>Label<`.
describe("no untranslated literals left in the UI", () => {
  it("wraps every user-visible JSX label in t()", () => {
    const sources = import.meta.glob("./components/**/*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    // Strings that are deliberately identical in both languages, or not UI copy.
    const allowed = new Set(["MD", "Promise"]);

    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      // HelpModal ships its own per-language content bundles (HELP_I18N) and
      // SettingsModal renders explicit ja/en JSX branches, so their English
      // halves are expected literals rather than missed translations.
      if (/HelpModal|SettingsModal/.test(path)) continue;
      const attrs = source.matchAll(
        /(?:title|aria-label|placeholder|alt)="([A-Z][A-Za-z0-9 ,.:;()/&%…·—–'?!-]{2,90})"/g
      );
      const texts = source.matchAll(
        />\s*([A-Z][A-Za-z][A-Za-z0-9 ,.:;()/&%…·—–'?!]{3,70})\s*</g
      );
      for (const m of [...attrs, ...texts]) {
        const text = m[1].trim();
        if (!allowed.has(text)) offenders.push(`${path}: ${text}`);
      }
    }
    expect(offenders, `untranslated literals: ${offenders.join(" | ")}`).toEqual([]);
  });
});
