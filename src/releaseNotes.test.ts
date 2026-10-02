import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./buildInfo";

// Release discipline (release-notes/README.md): every update bumps the
// version in all three manifests and ships release notes for that version, in
// Japanese (v<version>.md) and English (v<version>.en.md), each with "what
// changed", Known Issues and Future Release. These tests fail when a version
// is bumped in one place only, when a version has no notes in either
// language, or when the two languages list different KI-/FR- entries.

const raw = import.meta.glob(
  [
    "../src-tauri/tauri.conf.json",
    "../src-tauri/Cargo.toml",
    "../CHANGELOG.md",
    "../release-notes/v*.md",
  ],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const notesPath = `../release-notes/v${APP_VERSION}.md`;
const notesPathEn = `../release-notes/v${APP_VERSION}.en.md`;

/** The KI-nn / FR-nn ids a release note defines (first cell of a table row). */
function entryIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\| ((?:KI|FR)-\d{2}) \|/gm)].map((m) => m[1]).sort();
}

/** Level-2 headings ("## …") of a Markdown text, without the "## " prefix. */
function h2(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

describe("release discipline", () => {
  it("package.json, tauri.conf.json and Cargo.toml carry the same version", () => {
    const conf = JSON.parse(raw["../src-tauri/tauri.conf.json"]) as { version: string };
    // The [package] version is the first `version = "…"` line of Cargo.toml.
    const cargo = /^version = "([^"]+)"$/m.exec(raw["../src-tauri/Cargo.toml"])?.[1];
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(conf.version).toBe(APP_VERSION);
    expect(cargo).toBe(APP_VERSION);
  });

  it("the current version has release notes", () => {
    expect(Object.keys(raw)).toContain(notesPath);
    expect(Object.keys(raw)).toContain(notesPathEn);
  });

  it("the release notes say what changed and list Known Issues and Future Release", () => {
    const required: Array<[string, string[]]> = [
      [notesPath, ["アップデート内容", "Known Issues", "Future Release"]],
      [notesPathEn, ["What's updated", "Known Issues", "Future Release"]],
    ];
    for (const [path, names] of required) {
      const headings = h2(raw[path] ?? "");
      for (const name of names) {
        expect(headings.some((h) => h.includes(name)), `${path}: missing "## … ${name}" heading`).toBe(true);
      }
      // The title names the version the file is for.
      expect((raw[path] ?? "").split("\n")[0]).toContain(`v${APP_VERSION}`);
    }
    // Both languages list the same Known Issues and Future Release entries.
    const ids = entryIds(raw[notesPath] ?? "");
    expect(ids.length).toBeGreaterThan(0);
    expect(entryIds(raw[notesPathEn] ?? "")).toEqual(ids);
  });

  it("CHANGELOG.md has a heading for the current version", () => {
    expect(h2(raw["../CHANGELOG.md"]).some((h) => h.startsWith(`v${APP_VERSION} `))).toBe(true);
  });
});
