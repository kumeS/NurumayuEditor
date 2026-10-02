import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settingsDefaults";

// BUG-013a: the retired free preset must not be seeded, and the TS fallback
// lists must stay equal to the Rust built-ins that `Settings::load` merges
// into every user's list (settings.rs default_models / default_image_models).

const RETIRED_FREE_PRESET = "meta-llama/llama-3.3-70b-instruct:free";

const rust = Object.values(
  import.meta.glob("../src-tauri/src/settings.rs", { eager: true, query: "?raw", import: "default" })
)[0] as string;

/** `pub const NAME: &str = "…";` → { NAME: "…" } */
function rustStringConsts(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/pub const (\w+): &str = "([^"]*)";/g)) out[m[1]] = m[2];
  return out;
}

/** Ids of `fn <name>() -> Vec<String> { vec![ … ] }`, in order, with const
 *  identifiers resolved. Line comments are stripped first. */
function rustDefaultList(source: string, fnName: string): string[] {
  const head = `fn ${fnName}() -> Vec<String> {`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${fnName} not found in settings.rs`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start + head.length, end).replace(/\/\/[^\n]*/g, "");
  const consts = rustStringConsts(source);
  return [...body.matchAll(/"([^"]+)"|\b([A-Z][A-Z0-9_]+)\b/g)].map((m) => {
    if (m[1] !== undefined) return m[1];
    const v = consts[m[2]];
    if (v === undefined) throw new Error(`unresolved const ${m[2]} in ${fnName}`);
    return v;
  });
}

describe("DEFAULT_SETTINGS (BUG-013a)", () => {
  it("does not seed the retired llama-3.3 free preset", () => {
    expect(DEFAULT_SETTINGS.models).not.toContain(RETIRED_FREE_PRESET);
  });

  it("TS default model lists mirror Rust default_models / default_image_models", () => {
    const models = rustDefaultList(rust, "default_models");
    const imageModels = rustDefaultList(rust, "default_image_models");
    expect(models.length).toBeGreaterThan(1); // the parser found the list
    expect(imageModels.length).toBeGreaterThan(1);
    expect(DEFAULT_SETTINGS.models).toEqual(models);
    expect(DEFAULT_SETTINGS.imageModels).toEqual(imageModels);
  });

  it("default endpoint and active models mirror the Rust constants", () => {
    const c = rustStringConsts(rust);
    expect(DEFAULT_SETTINGS.endpoint).toBe(c.DEFAULT_ENDPOINT);
    expect(DEFAULT_SETTINGS.model).toBe(c.DEFAULT_MODEL);
    expect(DEFAULT_SETTINGS.imageModel).toBe(c.DEFAULT_IMAGE_MODEL);
  });
});

describe("SettingsModal uses the shared defaults (wiring guard)", () => {
  const modal = Object.values(
    import.meta.glob("./components/SettingsModal.tsx", { eager: true, query: "?raw", import: "default" })
  )[0] as string;

  it("imports DEFAULT_SETTINGS and keeps no private copy of the model lists", () => {
    expect(modal).toMatch(/import \{[^}]*\bDEFAULT_SETTINGS\b[^}]*\} from "\.\.\/settingsDefaults"/);
    expect(modal).not.toMatch(/\bmodels: \[/);
    expect(modal).not.toMatch(/\bimageModels: \[/);
    expect(modal).not.toMatch(/const DEFAULTS\b/);
  });
});
