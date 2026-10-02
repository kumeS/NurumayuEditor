import { describe, expect, it } from "vitest";

// Raw-source wiring guards (w2-ai-a). The behaviour of the pieces below is
// tested in aiActions.test.ts / store.test.ts / aiErrors.test.ts; these guards
// fail when the pieces stop being USED where the fix depends on them.

const raw = import.meta.glob(
  ["./aiActions.ts", "./components/NetworkPanel.tsx", "../src-tauri/src/ai.rs"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

const aiActions = raw["./aiActions.ts"];
const networkPanel = raw["./components/NetworkPanel.tsx"];
const aiRs = raw["../src-tauri/src/ai.rs"];

/** Source of one top-level `export async function name(` up to the next top-level function. */
function fnBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\nexport (?:async )?function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:export )?(?:async )?function \w+\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("aiActions wiring (BUG-001b / BUG-013c / UX-errors-en)", () => {
  it("imports localizeAiError and the store's op-ownership helpers", () => {
    expect(aiActions).toMatch(/import \{[^}]*\blocalizeAiError\b[^}]*\} from "\.\/aiErrors"/);
    expect(aiActions).toMatch(/import \{[^}]*\bcaptureOp\b[^}]*\} from "\.\/store"/);
    expect(aiActions).toMatch(/import \{[^}]*\bownsOp\b[^}]*\} from "\.\/store"/);
  });

  it("the old id-only guard is gone (it let results land in a reopened copy)", () => {
    expect(aiActions).not.toMatch(/\bchunkStillActive\(/);
  });

  it("every AI action captures an op and checks ownership AFTER its last AI await and BEFORE its first commit", () => {
    const actions = [
      "bulletizeChunks",
      "summarizeSlide",
      "suggestSlideLayout",
      "runChunkAction",
      "generateDiagramFromChunk",
      "generateImageFromChunk",
      "generateImageFromSelection",
      "generatePresentationFromChunk",
      "regenerateImageChunk",
      "editSelection",
      "analyzeDocument",
      "reviewDocument",
      "checkIntegrity",
      "checkAgainstCriteria",
    ];
    for (const name of actions) {
      const body = fnBody(aiActions, name);
      expect(body, `${name} must capture an op`).toMatch(/\bcaptureOp\(\)/);
      expect(body, `${name} must check ownership`).toMatch(/\b(?:ownsOp|staleReason)\(op\)/);
      // promise-sync-3: an early check before the request does not count — the
      // one that matters runs after the LAST awaited AI call and before the
      // first store commit (editSelection delegates to runChunkAction).
      const lastAwait = body.lastIndexOf("await api.");
      if (name !== "editSelection") expect(lastAwait, `${name} awaits no api call`).toBeGreaterThan(-1);
      if (lastAwait >= 0) {
        const tail = body.slice(lastAwait);
        const check = tail.search(/\b(?:ownsOp|staleReason)\(op\)/);
        expect(check, `${name}: no ownership check after its last AI await`).toBeGreaterThan(-1);
        const commit = tail.search(
          /\.(?:insertImageAfter|insertDiagramAfter|replaceChunkContent|replaceChunksWithTexts|setSlideBody|setChunkLayout|setChunkSummary|addComment|applyAnalysis)\(/
        );
        if (commit >= 0) expect(check, `${name}: commits before checking ownership`).toBeLessThan(commit);
      }
      // A bare tab-id compare is not a document-identity check (same-tab reload).
      expect(body, `${name} still compares activeTabId`).not.toMatch(/activeTabId\s*[!=]==\s*tab\b/);
    }
  });

  it("no AI catch site shows the raw backend string; speech (OS, not AI) is the only exception", () => {
    const withoutSpeech = aiActions.replace(fnBody(aiActions, "speakChunk"), "");
    expect(withoutSpeech).not.toMatch(/notify\(\s*message\(e\)/);
    expect(aiActions).toMatch(/localizeAiError\(message\(e\)/);
    // The model-issue flag is set only for the model-unavailable kind.
    expect(aiActions).toMatch(/kind === "model-unavailable"[\s\S]{0,200}setAiModelIssue\(/);
  });

  it("busy labels are passed translated (tNow/tf), never as raw English literals", () => {
    expect(aiActions).not.toMatch(/setGlobalBusy\(\s*["`]/);
  });
});

describe("NetworkPanel shows the AI op log (MISS-01)", () => {
  it("reads aiOpLog from the store and copies it via aiOpLogToJsonLines", () => {
    expect(networkPanel).toMatch(/useStore\(\(s\) => s\.aiOpLog\)/);
    expect(networkPanel).toMatch(/\baiOpLogToJsonLines\(/);
  });

  // Guards the panel's "Kept in memory for this session only" copy: the log
  // must not reach the session file (App.tsx collectSession → api.saveSession)
  // or any other I/O path. Only the store, the writer and the panel touch it.
  it("the op log is in-memory only: nothing outside store/aiActions/NetworkPanel references it", () => {
    const all = import.meta.glob("./**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;
    const allowed = new Set(["./store.ts", "./aiActions.ts", "./components/NetworkPanel.tsx"]);
    const users = Object.entries(all)
      .filter(([path, src]) => !/\.test\.tsx?$/.test(path) && /\baiOpLog\b/.test(src))
      .map(([path]) => path)
      .filter((path) => !allowed.has(path));
    expect(users).toEqual([]);
  });
});

describe("analyzeDocument's empty-document guard matches the Rust listing (BUG-015a)", () => {
  // The TS guard skips the IPC only when no text/heading chunk has non-blank
  // content. That is safe only while ai.rs analysis_listing (which decides
  // whether the backend short-circuits) also lists nothing but non-blank
  // text/heading chunks and never the title.
  it("ai.rs analysis_listing lists only non-blank text/heading chunks and ignores the title", () => {
    const m = /fn analysis_listing\(doc: &Document\) -> String \{([\s\S]*?)\n\}/.exec(aiRs);
    expect(m, "analysis_listing not found in ai.rs").not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/chunk_type != CHUNK_TYPE_TEXT && !is_heading[\s\S]*?continue;/);
    expect(body).toMatch(/snippet\.trim\(\)\.is_empty\(\)[\s\S]*?continue;/);
    expect(body).not.toMatch(/doc\.title/);
    expect(aiRs).toMatch(/let listing = analysis_listing\(doc\);\s*if listing\.trim\(\)\.is_empty\(\) \{\s*return Ok\(AnalysisResult \{ nodes: vec!\[\], edges: vec!\[\]/);
  });

  it("aiActions has the matching predicate and analyzeDocument uses it before the key check", () => {
    const body = fnBody(aiActions, "analyzeDocument");
    const guard = body.indexOf("hasAnalyzableContent(");
    const keyCheck = body.indexOf("aiReady()");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(keyCheck);
  });
});
