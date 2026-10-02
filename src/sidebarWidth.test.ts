import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSettings = vi.fn();
vi.mock("./api", () => ({ api: { saveSettings: (...a: unknown[]) => saveSettings(...a) } }));

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  saveSidebarWidth,
  sidebarWidthOf,
} from "./sidebarWidth";
import { useStore } from "./store";
import type { Settings } from "./types";

const base: Settings = {
  endpoint: "e",
  model: "m",
  models: ["m"],
  imageModel: "i",
  imageModels: ["i"],
  defaultTargetLanguage: "日本語",
  writingTone: "",
  temperature: 0.3,
};

describe("clampSidebarWidth", () => {
  it("keeps the width inside its bounds (and rounds drag fractions)", () => {
    expect(clampSidebarWidth(20)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("always leaves room for the document in a narrow window", () => {
    expect(clampSidebarWidth(500, 700)).toBe(340); // 700 − 360 reserved
    expect(clampSidebarWidth(500, 400)).toBe(SIDEBAR_WIDTH_MIN); // never below the minimum
  });
});

describe("sidebarWidthOf", () => {
  it("defaults when unset or before settings load, and clamps a stored value", () => {
    expect(sidebarWidthOf(null)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(sidebarWidthOf(base)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(sidebarWidthOf({ ...base, sidebarWidth: 320 })).toBe(320);
    expect(sidebarWidthOf({ ...base, sidebarWidth: 9999 })).toBe(SIDEBAR_WIDTH_MAX);
  });
});

describe("saveSidebarWidth", () => {
  beforeEach(() => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue(undefined);
    useStore.setState({ settings: { ...base }, toasts: [] });
  });

  it("applies and persists the finished width, keeping every other setting", async () => {
    await saveSidebarWidth(333);
    expect(useStore.getState().settings?.sidebarWidth).toBe(333);
    const saved = saveSettings.mock.calls[0][0] as Settings;
    expect(saved.sidebarWidth).toBe(333);
    expect(saved.defaultTargetLanguage).toBe("日本語");
  });

  it("doesn't write settings when the width didn't change (e.g. a click on the handle)", async () => {
    useStore.setState({ settings: { ...base, sidebarWidth: 300 } });
    await saveSidebarWidth(300);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("keeps the width for the session and reports a failed save", async () => {
    saveSettings.mockRejectedValue("disk full");
    await saveSidebarWidth(400);
    expect(useStore.getState().settings?.sidebarWidth).toBe(400);
    const toasts = useStore.getState().toasts;
    const toast = toasts[toasts.length - 1];
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toContain("disk full");
  });
});

describe("sidebar width contract (TS ⇄ Rust)", () => {
  it("uses the same bounds Rust clamps to on load", () => {
    const rust = Object.values(
      import.meta.glob("../src-tauri/src/settings.rs", { eager: true, query: "?raw", import: "default" })
    )[0] as string;
    expect(Number(rust.match(/SIDEBAR_WIDTH_MIN: u32 = (\d+);/)?.[1])).toBe(SIDEBAR_WIDTH_MIN);
    expect(Number(rust.match(/SIDEBAR_WIDTH_MAX: u32 = (\d+);/)?.[1])).toBe(SIDEBAR_WIDTH_MAX);
  });
});
