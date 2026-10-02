import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSettings = vi.fn();
vi.mock("./api", () => ({ api: { saveSettings: (...a: unknown[]) => saveSettings(...a) } }));

import { JA } from "./i18n";
import {
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  previewBackgroundOf,
  setPreviewBackground,
} from "./previewBackground";
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

describe("previewBackgroundOf", () => {
  it("defaults to white when unset or before settings load", () => {
    expect(previewBackgroundOf(null)).toBe("white");
    expect(previewBackgroundOf(base)).toBe("white");
  });

  it("returns the stored tone, and falls back for an unknown one", () => {
    expect(previewBackgroundOf({ ...base, previewBackground: "paper" })).toBe("paper");
    expect(previewBackgroundOf({ ...base, previewBackground: "neon" as never })).toBe("white");
  });
});

describe("tone labels", () => {
  it("has a Japanese label for every tone (labels reach t() via a variable the i18n scanner can't see)", () => {
    for (const tone of PREVIEW_BACKGROUNDS) {
      expect(JA[PREVIEW_BACKGROUND_LABELS[tone]], `no JA label for ${tone}`).toBeDefined();
    }
  });
});

describe("setPreviewBackground", () => {
  beforeEach(() => {
    saveSettings.mockReset();
    saveSettings.mockResolvedValue(undefined);
    useStore.setState({ settings: { ...base }, toasts: [] });
  });

  it("applies immediately and persists, keeping every other setting", async () => {
    await setPreviewBackground("gray");
    expect(useStore.getState().settings?.previewBackground).toBe("gray");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const saved = saveSettings.mock.calls[0][0] as Settings;
    expect(saved.previewBackground).toBe("gray");
    expect(saved.defaultTargetLanguage).toBe("日本語");
  });

  it("keeps the new tone on screen but reports it when saving fails", async () => {
    saveSettings.mockRejectedValue("disk full");
    await setPreviewBackground("mint");
    expect(useStore.getState().settings?.previewBackground).toBe("mint");
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: "error" });
    expect(toasts[toasts.length - 1].message).toContain("disk full");
  });

  it("does nothing before settings have loaded (nothing to merge into)", async () => {
    useStore.setState({ settings: null });
    await setPreviewBackground("blue");
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

// Three places spell the same list: this module, Rust's PREVIEW_BACKGROUNDS
// (which resets anything else on load) and the CSS tokens that paint it. A tone
// missing from any one of them is silently dropped or rendered unstyled.
describe("preview background contract (TS ⇄ Rust ⇄ CSS)", () => {
  it("lists the same tones in all three places", () => {
    const rust = Object.values(
      import.meta.glob("../src-tauri/src/settings.rs", { eager: true, query: "?raw", import: "default" })
    )[0] as string;
    const rustList = rust.match(/PREVIEW_BACKGROUNDS: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? "";
    const rustTones = [...rustList.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(rustTones).toEqual([...PREVIEW_BACKGROUNDS]);

    const css = Object.values(
      import.meta.glob("./index.css", { eager: true, query: "?raw", import: "default" })
    )[0] as string;
    for (const tone of PREVIEW_BACKGROUNDS) {
      expect(css, `missing --preview-bg-${tone} token`).toMatch(new RegExp(`--preview-bg-${tone}:`));
      expect(css, `missing [data-preview-bg="${tone}"] rule`).toContain(`[data-preview-bg="${tone}"]`);
    }
  });
});
