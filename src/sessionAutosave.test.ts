import { describe, expect, it } from "vitest";
import { autosaveStep } from "./sessionAutosave";

// state-async-6: the crash-recovery session must not outlive the dirt it
// recorded — undoing every tab back to clean clears it.

const raw = import.meta.glob(["./App.tsx"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

describe("autosaveStep", () => {
  it("writes while any tab is dirty", () => {
    expect(autosaveStep({ anyDirty: true, written: false })).toEqual({ action: "save", written: true });
    expect(autosaveStep({ anyDirty: true, written: true })).toEqual({ action: "save", written: true });
  });

  it("clears a session it wrote once nothing is dirty any more (undo back to clean)", () => {
    expect(autosaveStep({ anyDirty: false, written: true })).toEqual({ action: "clear", written: false });
  });

  it("does nothing when clean and no session was written (no clear on every idle store change)", () => {
    expect(autosaveStep({ anyDirty: false, written: false })).toEqual({ action: null, written: false });
  });
});

describe("App's autosave subscriber uses autosaveStep and clears through the session queue", () => {
  it("calls autosaveStep and api.clearSession on the clear action", () => {
    const app = raw["./App.tsx"];
    const at = app.indexOf("autosaveStep(");
    expect(at).toBeGreaterThan(-1);
    const block = app.slice(at, at + 400);
    expect(block).toMatch(/api\.saveSession\(collectSession\(\)\)/);
    expect(block).toMatch(/api\.clearSession\(\)/);
  });
});
