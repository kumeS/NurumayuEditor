import { describe, expect, it } from "vitest";
import { shouldRequestGhost } from "./ghostText";

// README promises that touch privacy are guarded here (testing rule 1),
// each assertion scoped to the one README row it checks (testing rule 2).

const readme = Object.values(
  import.meta.glob("../README.md", { eager: true, query: "?raw", import: "default" })
)[0] as string;

/** The single feature-table row whose first cell starts with `label`. */
function row(label: string): string {
  const rows = readme.split("\n").filter((l) => l.startsWith(`| ${label}`));
  expect(rows, label).toHaveLength(1);
  return rows[0];
}

describe("promise-sync-2 — the README's Ghost text row matches the code", () => {
  it("does not call ghost text opt-in, says what is sent, and names the local-only setting", () => {
    const r = row("**Ghost text**");
    expect(r).not.toMatch(/opt-in/i);
    expect(r).toMatch(/sent to the configured endpoint/);
    expect(r).toMatch(/Limit ghost-text completion to a local model/);
  });

  it("the code has no enable flag: every precondition true → a request (README says 'on whenever AI is configured')", () => {
    expect(
      shouldRequestGhost({
        chunkType: "text",
        isFocused: true,
        content: "本文",
        caretAtEnd: true,
        editedSinceFocus: true,
        aiReady: true,
      })
    ).toBe(true);
    expect(row("**Ghost text**")).toMatch(/on whenever AI is configured/);
  });
});
