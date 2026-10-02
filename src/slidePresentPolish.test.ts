import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

// UI-polish guards (wave 5, p-slides) for the Slides editor and Presentation
// mode. No DOM in this suite: each assertion is scoped to the JSX element it
// guards, extracted from the raw component source.

const raw = import.meta.glob(["./components/SlideEditor.tsx", "./components/PresentationMode.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const slideEditor = raw["./components/SlideEditor.tsx"];
const present = raw["./components/PresentationMode.tsx"];

/** The opening tag (`<tag … >`) that contains `marker`. */
function openingTag(source: string, marker: string, tag: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf(`<${tag}`, at);
  const end = source.indexOf(">", at);
  return source.slice(start, end + 1);
}

describe("Slides editor — copy, names and keyboard reach", () => {
  it("the Detached pill is translated (no bare English in a Japanese UI)", () => {
    const at = slideEditor.indexOf('title={t("This slide shows its own summary');
    expect(at).toBeGreaterThan(-1);
    const pill = slideEditor.slice(at, slideEditor.indexOf("</span>", at));
    expect(pill).toMatch(/\{t\("Detached"\)\}/);
    expect(pill).not.toMatch(/>\s*✂ Detached\s*</);
    expect(translate("Detached", "ja")).toMatch(/[぀-ヿ一-龯]/);
  });

  it("the Present button does not promise full screen (it fills the window)", () => {
    const btn = openingTag(slideEditor, "onClick={startPresent}", "button");
    expect(btn).toMatch(/title=\{t\("Present in this window \(Esc to exit\)"\)\}/);
    expect(btn).not.toMatch(/full screen/i);
    expect(translate("Present in this window (Esc to exit)", "ja")).toBe("このウィンドウで発表 (Escで終了)");
  });

  it("the deck title and detached bullet fields have accessible names, not just placeholders", () => {
    const deck = openingTag(slideEditor, 'placeholder={t("Untitled Deck")}', "input");
    expect(deck).toMatch(/aria-label=\{t\("Deck title"\)\}/);
    const bullets = openingTag(slideEditor, 'placeholder={t("One bullet per line…")}', "textarea");
    expect(bullets).toMatch(/aria-label=\{t\("Slide bullets \(one per line\)"\)\}/);
    const titleInput = openingTag(slideEditor, 'placeholder={t("Slide title")}', "input");
    expect(titleInput).toMatch(/aria-label=\{t\("Slide title"\)\}/);
    expect(translate("Deck title", "ja")).not.toBe("Deck title");
    expect(translate("Slide bullets (one per line)", "ja")).not.toBe("Slide bullets (one per line)");
  });

  it("hover-revealed rail actions and 'Split slide here' also appear on keyboard focus", () => {
    const at = slideEditor.indexOf('title={t("Move up")}');
    expect(at).toBeGreaterThan(-1);
    const rail = slideEditor.slice(slideEditor.lastIndexOf("<div", at), at);
    expect(rail).toMatch(/opacity-0 group-hover\/thumb:opacity-100 focus-within:opacity-100/);
    const split = openingTag(slideEditor, 'title={t("Start a new slide here', "button");
    expect(split).toMatch(/group-hover\/row:opacity-100/);
    expect(split).toMatch(/focus-visible:opacity-100/);
  });

  it("Delete slide is set apart from the safe rail actions by a divider", () => {
    const dup = slideEditor.indexOf('t("Duplicate slide")');
    const del = slideEditor.indexOf('title={t("Delete slide")}');
    expect(dup).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(dup);
    const between = slideEditor.slice(dup, del);
    expect(between).toMatch(/<span aria-hidden="true" className="[^"]*\bborder-l\b[^"]*border-chrome-line[^"]*" \/>/);
  });
});

describe("Presentation mode — overflow and state", () => {
  it("the slide is sized by the stage's height as well as its width (no pushed-off controls)", () => {
    const stage = openingTag(present, "<SlideStage", "div");
    const area = present.slice(present.lastIndexOf("<div", present.lastIndexOf("<div", present.indexOf("<SlideStage")) - 1), present.indexOf("<SlideStage"));
    expect(area).toMatch(/className="[^"]*\bmin-h-0\b[^"]*\[container-type:size\][^"]*"/);
    expect(stage).toMatch(/w-\[min\(100%,1280px,calc\(100cqh\*16\/9\)\)\]/);
  });

  it("speaker notes keep their line breaks and scroll instead of growing without bound", () => {
    const at = present.indexOf('{t("Speaker notes")}');
    expect(at).toBeGreaterThan(-1);
    const box = present.slice(present.lastIndexOf("<div", present.lastIndexOf("<div", at) - 1), at);
    expect(box).toMatch(/whitespace-pre-wrap/);
    expect(box).toMatch(/max-h-\[30vh\] overflow-y-auto/);
  });

  it("the Notes toggle exposes its on/off state to assistive tech", () => {
    const btn = openingTag(present, 'title={t("Toggle speaker notes (N)")}', "button");
    expect(btn).toMatch(/aria-pressed=\{notesOpen\}/);
  });
});
