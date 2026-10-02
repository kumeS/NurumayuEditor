import { describe, expect, it } from "vitest";
import { JA } from "./i18n";

// p-dialogs polish guards (ui.md rules 1, 6, 9; docs/ai/04 token policy) for
// the shared Modal layer and the dialogs that render through it. No DOM here:
// these read the component sources raw and assert the wiring.

const SOURCES = import.meta.glob(
  [
    "./components/Modal.tsx",
    "./components/DraftModal.tsx",
    "./components/PromptModal.tsx",
    "./components/CommandPalette.tsx",
    "../tailwind.config.js",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(path: string): string {
  const s = SOURCES[path];
  expect(s, `${path} not found`).toBeTruthy();
  return s;
}
const component = (name: string) => src(`./components/${name}.tsx`);

/** Every opening JSX tag `<tag …>`, read up to the `>` that closes it at
 *  brace depth 0 (so `=>` inside `{…}` attribute values does not end it). */
function openingTags(source: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b`, "g");
  for (const m of source.matchAll(re)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(source.slice(m.index!, i + 1));
  }
  return out;
}

const RAW_SCALE = /\b(?:gray|slate|zinc|neutral|red|amber|emerald|green|blue|yellow)-\d+/g;
const DIALOGS = ["Modal", "DraftModal", "PromptModal", "CommandPalette"];

describe("dialogs use semantic colour tokens (ui.md rule 9)", () => {
  it("the tag reader does not stop at an arrow function inside an attribute", () => {
    const tags = openingTags('<input value={v} onChange={(e) => set(e)} id={x} />', "input");
    expect(tags).toEqual(['<input value={v} onChange={(e) => set(e)} id={x} />']);
  });

  it.each(DIALOGS)("%s.tsx uses no raw gray/red/amber/… scale class", (name) => {
    expect(component(name).match(RAW_SCALE) ?? [], name).toEqual([]);
  });

  it("tailwind.config.js defines warn.line (the warning box border)", () => {
    const warn = src("../tailwind.config.js").match(/\bwarn: \{([^}]*)\}/);
    expect(warn).not.toBeNull();
    expect(warn![1]).toMatch(/\bline: "#[0-9a-f]{6}"/);
  });

  it("the Draft reference-limit notice uses the warn tokens", () => {
    const d = component("DraftModal");
    const at = d.indexOf('t("Only about the first 12,000 characters will be used by the AI.")');
    expect(at).toBeGreaterThan(-1);
    const box = d.slice(d.lastIndexOf("<p", at), at);
    expect(box).toContain("border-warn-line");
    expect(box).toContain("bg-warn-wash");
    expect(box).toContain("text-warn-strong");
  });

  it("the Draft inline error uses the danger tokens", () => {
    const d = component("DraftModal");
    const alert = openingTags(d, "div").find((tag) => tag.includes('role="alert"'));
    expect(alert).toBeDefined();
    expect(alert).toContain("border-danger-line");
    expect(alert).toContain("bg-danger-wash");
    expect(alert).toContain("text-danger");
  });
});

describe("form fields have accessible names (ui.md rule 1)", () => {
  it.each(["DraftModal", "PromptModal"])("every <label> in %s points at a field id", (name) => {
    const s = component(name);
    const labels = openingTags(s, "label");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const target = label.match(/htmlFor=\{(\w+)\}/);
      expect(target, label).not.toBeNull();
      const fields = [...openingTags(s, "textarea"), ...openingTags(s, "select"), ...openingTags(s, "input")];
      expect(
        fields.some((f) => f.includes(`id={${target![1]}}`)),
        `no field has id={${target![1]}}`
      ).toBe(true);
    }
  });

  it.each(["DraftModal", "PromptModal", "CommandPalette"])(
    "every textarea/select/input in %s has an id (labelled) or an aria-label",
    (name) => {
      const s = component(name);
      const fields = [...openingTags(s, "textarea"), ...openingTags(s, "select"), ...openingTags(s, "input")];
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) expect(f, f).toMatch(/\b(?:id|aria-label)=\{/);
    }
  );

  it("an unlabelled prompt field is named after the dialog title", () => {
    const p = component("PromptModal");
    for (const f of [...openingTags(p, "textarea"), ...openingTags(p, "input")]) {
      expect(f).toMatch(/aria-label=\{opts\.label \? undefined : opts\.title\}/);
    }
  });

  it("the palette search field has a translated accessible name", () => {
    const [input] = openingTags(component("CommandPalette"), "input");
    expect(input).toMatch(/aria-label=\{t\("Search commands"\)\}/);
    expect(JA["Search commands"]).toBeTruthy();
  });

  it("the Draft URL field has a translated accessible name", () => {
    const url = openingTags(component("DraftModal"), "input").find((f) => f.includes("value={url}"));
    expect(url).toMatch(/aria-label=\{t\("Reference URL"\)\}/);
    expect(JA["Reference URL"]).toBeTruthy();
  });
});

describe("icon-only buttons have a tooltip and an accessible name (ui.md rule 1)", () => {
  it("PromptModal's close button", () => {
    const close = openingTags(component("PromptModal"), "button").find((b) => b.includes('aria-label={t("Close")}'));
    expect(close).toBeDefined();
    expect(close).toMatch(/title=\{t\("Close"\)\}/);
  });

  it("DraftModal's remove-source button, which is also locked while generating", () => {
    const remove = openingTags(component("DraftModal"), "button").find((b) => b.includes('"Remove {name}"'));
    expect(remove).toBeDefined();
    expect(remove).toMatch(/title=\{translateWith\("Remove \{name\}"/);
    expect(remove).toMatch(/disabled=\{generating\}/);
  });
});

describe("copy and noise", () => {
  it("PromptModal's default submit label is translated (no bare \"OK\")", () => {
    const p = component("PromptModal");
    const fallback = p.match(/opts\.submitLabel \?\? ([^}\n]+)\}/);
    expect(fallback).not.toBeNull();
    expect(fallback![1].trim()).toMatch(/^t\("[^"]+"\)$/);
  });

  it("adding a Draft reference is quiet: the new chip is the state change, no success toast (ui.md rule 6)", () => {
    const d = component("DraftModal");
    expect(d).not.toMatch(/notify\([^;]*"success"\)/);
    // The chip row the user sees instead.
    expect(d).toMatch(/setSources\(\(prev\) => \[\.\.\.prev, \{ label: source, text: piece \}\]\)/);
  });
});
