import { describe, expect, it } from "vitest";
import { HELP_I18N } from "./components/HelpModal";

// Source-contract guards for ChunkView (BUG-001a ghost text, BUG-002 undo
// boundaries). There is no DOM in this suite, so the pure decisions are tested
// in ghostText.test.ts / undoBoundary.test.ts / store.test.ts; these prove the
// component actually CALLS them (testing rule 2: a pure helper that nobody
// calls would otherwise pass on its own). Each assertion is scoped to the
// slice of source it guards.

const raw = import.meta.glob(["./components/ChunkView.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const chunkView = raw["./components/ChunkView.tsx"];

/** The useEffect(...) call that sends the ghost request. */
function ghostEffect(): string {
  const call = chunkView.indexOf(".aiGhostCompleteStream(");
  expect(call, "ChunkView no longer requests ghost text").toBeGreaterThan(-1);
  const start = chunkView.lastIndexOf("useEffect(", call);
  const end = chunkView.indexOf("}, [", call);
  return chunkView.slice(start, end);
}

/** A `const name = …` arrow function body, up to the next top-level const. */
function fnBody(name: string): string {
  const start = chunkView.indexOf(`const ${name} = `);
  expect(start, `missing const ${name}`).toBeGreaterThan(-1);
  const rest = chunkView.slice(start + 1);
  const next = rest.search(/\n  const /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("BUG-001a — ghost request wiring", () => {
  it("the debounce effect asks shouldRequestGhost, with the user-edit flag, before requesting", () => {
    expect(chunkView).toMatch(/import \{ shouldRequestGhost \} from "\.\.\/ghostText";/);
    const effect = ghostEffect();
    const gate = effect.indexOf("shouldRequestGhost(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(effect.indexOf("startGhostRequest()"));
    expect(effect).toMatch(/editedSinceFocus: editedSinceFocus\.current/);
  });

  it("the user-edit flag is set only by an edit and reset on focus / chunk change", () => {
    const sets = [...chunkView.matchAll(/editedSinceFocus\.current = true/g)];
    expect(sets).toHaveLength(1);
    expect(fnBody("takeUndoBoundary")).toContain("editedSinceFocus.current = true");
    expect(chunkView).toMatch(
      /useEffect\(\(\) => \{\s*editedSinceFocus\.current = false;[\s\S]{0,200}?\}, \[isFocused, chunkId\]\);/
    );
  });

  it("records the request context once and passes it to every suggestion update", () => {
    const effect = ghostEffect();
    expect(effect).toMatch(
      /const ctx: GhostContext = \{\s*chunkId,\s*prefix: live\.content,\s*tabId: s\.activeTabId,\s*docNonce: s\.docNonce,?\s*\}/
    );
    expect(effect).toMatch(/\.aiGhostCompleteStream\(ctx\.prefix,/);
    const updates = [...effect.matchAll(/setGhostSuggestion\((\w+),/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThanOrEqual(2); // deltas + final text
    expect(new Set(updates)).toEqual(new Set(["ctx"]));
    expect(chunkView).not.toMatch(/setGhostSuggestion\(chunkId,/); // no legacy string form
  });

  it("logs the request start (ids only) with the request id", () => {
    expect(ghostEffect()).toMatch(
      /logAiOp\(\{\s*opId: requestId,\s*phase: "start",\s*action: "ghost",\s*tabId: ctx\.tabId,\s*docNonce: ctx\.docNonce,\s*chunkId,?\s*\}\)/
    );
  });

  it("Tab accepts through the store's validated action and only then prevents default", () => {
    const onKey = fnBody("onKeyDown");
    const tab = onKey.slice(0, onKey.indexOf('e.key === "Escape"'));
    const tabKey = tab.indexOf('e.key === "Tab"');
    const cond = tab.slice(tab.lastIndexOf("if (", tabKey), tab.indexOf("{", tabKey));
    expect(cond).toContain("acceptGhostSuggestion(chunkId)");
    expect(tab.indexOf("acceptGhostSuggestion(chunkId)")).toBeLessThan(tab.indexOf("e.preventDefault()"));
    expect(tab).not.toContain("ghostText;"); // no content + ghostText concatenation
    expect(tab).not.toContain("updateChunkContent");
  });

  it("exposes the FINAL suggestion to assistive tech through an always-mounted live region", () => {
    const body = chunkView.split("<textarea").slice(1).find((t) => t.includes("handleTextChange"));
    expect(body).toMatch(/aria-describedby=\{ghostHintId\}/);
    const region = chunkView.slice(chunkView.lastIndexOf("<span", chunkView.indexOf("id={ghostHintId}")));
    const tag = region.slice(0, region.indexOf(">"));
    expect(tag).toMatch(/className="sr-only"/);
    expect(tag).toMatch(/aria-live="polite"/);
    expect(region.slice(0, 400)).toContain('translateWith("Suggestion: {text} (Tab to accept, Esc to dismiss)"');
    // Announced from the final text only, never from each streamed delta.
    const effect = ghostEffect();
    const final = effect.slice(effect.indexOf(".then("));
    expect(final).toContain("setAnnouncedGhost(");
    expect(effect.slice(0, effect.indexOf(".then("))).not.toContain("setAnnouncedGhost(");
  });
});

describe("BUG-002 — every ChunkView textarea feeds undo boundaries", () => {
  const textareas = () => chunkView.split("<textarea").slice(1).map((t) => t.slice(0, t.indexOf("/>")));

  it("each textarea branch (heading, body, diagram) uses the boundary-recording ref and handler", () => {
    const tags = textareas();
    expect(tags).toHaveLength(3);
    for (const t of tags) {
      expect(t).toMatch(/ref=\{bindTextarea\}/);
      expect(t).toMatch(/onChange=\{\(e\) => handle(Text|Raw)Change\(e\.target\.value\)\}/);
      expect(t).not.toContain("updateChunkContent(");
    }
  });

  it("both change handlers pass the recorded boundary AND the composing flag to updateChunkContent", () => {
    expect(fnBody("handleTextChange")).toMatch(
      /updateChunkContent\(chunkId, value, \{ newUndoStep, composing \}\)/
    );
    expect(fnBody("handleRawChange")).toMatch(/updateChunkContent\(chunkId, value, takeUndoBoundary\(\)\)/);
    expect(fnBody("handleTextChange")).toMatch(/const \{ newUndoStep, composing \} = takeUndoBoundary\(\);/);
    const take = fnBody("takeUndoBoundary");
    expect(take).toMatch(/pendingNewStep\.current = false/);
    // state-async-1: the composition tracker decides `composing` per change.
    expect(take).toMatch(/return \{ newUndoStep, composing: composition\.current\.take\(\) \}/);
  });

  it("the composition tracker sees compositionstart / compositionend / beforeinput and resets on focus", () => {
    const bind = fnBody("bindTextarea");
    expect(bind).toMatch(/composition\.current\.input\(ie\)/);
    expect(bind).toMatch(/composition\.current\.start\(\)/);
    expect(bind).toMatch(/addEventListener\("compositionend", onCompositionEnd\)/);
    expect(bind).toMatch(/removeEventListener\("compositionend", onCompositionEnd\)/);
    expect(bind).toMatch(/const onCompositionEnd = \(\) => composition\.current\.end\(\)/);
    expect(chunkView).toMatch(/pendingNewStep\.current = false;\s*composition\.current\.reset\(\);/);
  });

  it("the ref installs native beforeinput + compositionstart listeners that call startsNewUndoStep", () => {
    expect(chunkView).toMatch(
      /import \{ createCompositionTracker, startsNewUndoStep \} from "\.\.\/undoBoundary";/
    );
    const bind = fnBody("bindTextarea");
    expect(bind).toMatch(/addEventListener\("beforeinput", /);
    expect(bind).toMatch(/addEventListener\("compositionstart", /);
    expect(bind).toMatch(/removeEventListener\("beforeinput", /);
    expect(bind).toMatch(/removeEventListener\("compositionstart", /);
    expect([...bind.matchAll(/pendingNewStep\.current \|\|= startsNewUndoStep\(/g)]).toHaveLength(2);
    expect(bind).toMatch(/compositionJustStarted: true/);
    // Pre-mutation selection is read from the element itself.
    expect(bind).toMatch(/selectionStart: el\.selectionStart,\s*selectionEnd: el\.selectionEnd/);
  });
});

describe("Help copy matches the ghost-text trigger (BUG-001a, testing rule 1)", () => {
  /** The rendered `ghostText.body` of the Help bundle whose ghost-text title is
   *  `title`. Read from HELP_I18N (not raw source): the 日本語 bundle builds its
   *  body as a template literal interpolating JA dictionary labels. */
  function ghostBody(title: string): string {
    const section = Object.values(HELP_I18N)
      .map((b) => b.ghostText)
      .find((g) => g?.title === title);
    expect(section, `missing ghost-text section ${title}`).toBeTruthy();
    return section?.body ?? "";
  }

  it("English says a suggestion follows typing, not focus", () => {
    const en = ghostBody("Ghost-text suggestions");
    expect(en).toMatch(/^After you type in a paragraph and pause/);
    expect(en).toContain("clicking into a paragraph never requests one");
    expect(en).not.toContain("While your cursor sits at the end of a paragraph");
  });

  it("Japanese says the same", () => {
    // Section retitled in w5-help to match the Settings switch label
    // (「インライン補完をローカルモデルに限定する」).
    const ja = ghostBody("インライン補完（ゴーストテキスト）");
    expect(ja).toMatch(/^段落に入力してから/);
    expect(ja).toContain("クリックしただけでは表示されません");
  });
});
