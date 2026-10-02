import { describe, expect, it } from "vitest";

// Source-contract guards for the Draft dialog lifecycle (BUG-014, BUG-005a,
// MISS-06). There is no DOM in this suite: the behaviour of draftDocument is
// tested in draftDocument.test.ts; these prove the dialog is WIRED to it
// (stays open while waiting, closes on first content, detaches on cancel,
// shows failures inline). Real rendering is closed by the manual QA re-run.

const source = (
  import.meta.glob("./components/DraftModal.tsx", { eager: true, query: "?raw", import: "default" }) as Record<
    string,
    string
  >
)["./components/DraftModal.tsx"];

/** Body of `const <name> = …` up to the next top-level `const`/`return (`. */
function fnBody(name: string): string {
  const start = source.indexOf(`const ${name} = `);
  expect(start, `missing const ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n  (const |return \()/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Every opening tag `<tag …>` (to the next `>` that closes a JSX tag). */
function tags(tag: string): string[] {
  return source
    .split(`<${tag}`)
    .slice(1)
    .map((t) => t.slice(0, t.search(/\/?>\s*(\n|\{|<|[A-Za-z])/) + 2));
}

describe("DraftModal — lifecycle wiring (BUG-014)", () => {
  it("submit does not close up front; it closes from onFirstContent", () => {
    const submit = fnBody("submit");
    const call = submit.indexOf("await draftDocument(");
    expect(call).toBeGreaterThan(-1);
    // No close() before the draft is started…
    expect(submit.slice(0, call)).not.toMatch(/\bclose\(\)/);
    // …the 4th argument (onFirstContent) is the callback that closes.
    const args = submit.slice(call);
    expect(args).toMatch(/draftDocument\([^;]*,\s*\(\)\s*=>\s*\{[\s\S]*?close\(\);[\s\S]*?\}\s*\)/);
  });

  it("a failure before content keeps the dialog open with the inline error (no reset)", () => {
    const submit = fnBody("submit");
    expect(submit).toMatch(/setError\(r\.error\)/);
    expect(submit).toMatch(/keepInputs\.current = true/);
    // The open effect wipes inputs only when the last attempt did not fail.
    const effect = source.slice(source.indexOf("useEffect("), source.indexOf('setTheme("")'));
    expect(effect).toMatch(/!keepInputs\.current/);
  });

  it("cannot be dismissed by Escape/backdrop while generating; ✕ and Cancel detach", () => {
    const modal = tags("Modal")[0];
    expect(modal).toMatch(/dismissible=\{!generating\}/);
    expect(modal).toMatch(/onClose=\{dismiss\}/);
    expect(fnBody("dismiss")).toMatch(/if \(generating\) \{[\s\S]*detachPendingDraft\(\)/);
    // No close control bypasses the detach path.
    expect(source).not.toMatch(/onClick=\{close\}/);
    expect(source).not.toMatch(/onClose=\{close\}/);
    expect(source.match(/onClick=\{dismiss\}/g)?.length).toBe(2);
  });

  it("disables every input while generating", () => {
    const inputs = [...tags("textarea"), ...tags("select"), ...tags("input")];
    expect(inputs.length).toBe(4); // theme, reference, length, URL
    for (const t of inputs) expect(t).toMatch(/disabled=\{generating\}/);
  });

  it("shows the failure inline (role=alert) with a Retry that re-submits", () => {
    const alert = source.slice(source.indexOf('role="alert"'));
    expect(source.indexOf('role="alert"')).toBeGreaterThan(-1);
    expect(alert.slice(0, 600)).toMatch(/\{error\}/);
    expect(alert.slice(0, 900)).toMatch(/onClick=\{\(\) => void submit\(\)\}[\s\S]{0,200}t\("Retry"\)/);
  });
});

describe("DraftModal — length labels and hints (BUG-005a, MISS-06)", () => {
  it("builds the length options from draftLength (no hard-coded word labels)", () => {
    expect(source).toMatch(/DRAFT_TARGETS\.map\(/);
    expect(source).toMatch(/draftLengthOptionLabel\(/);
    expect(source).not.toMatch(/~300 words/);
    expect(source).toContain('t("Length is approximate; the result is reported after drafting.")');
  });

  it("explains the native picker next to the attach button", () => {
    const attach = source.indexOf('t("Attach .txt / .md / .rtf / .pdf")');
    const hint = source.indexOf('t("Select a file, then choose Open.")');
    expect(attach).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(attach);
    expect(hint - attach).toBeLessThan(400);
  });
});
