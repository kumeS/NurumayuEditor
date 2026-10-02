import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./buildInfo";

// Release discipline (release-notes/README.md): every update bumps the
// version in all three manifests and ships release notes for that version
// with "what changed", Known Issues and Future Release. These tests fail when
// a version is bumped in one place only, or when a version has no notes.

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
  });

  it("the release notes say what changed and list Known Issues and Future Release", () => {
    const headings = h2(raw[notesPath] ?? "");
    for (const required of ["アップデート内容", "Known Issues", "Future Release"]) {
      expect(headings.some((h) => h.includes(required)), `missing "## … ${required}" heading`).toBe(true);
    }
    // The title names the version the file is for.
    expect((raw[notesPath] ?? "").split("\n")[0]).toContain(`v${APP_VERSION}`);
  });

  it("CHANGELOG.md has a heading for the current version", () => {
    expect(h2(raw["../CHANGELOG.md"]).some((h) => h.startsWith(`v${APP_VERSION} `))).toBe(true);
  });
});
