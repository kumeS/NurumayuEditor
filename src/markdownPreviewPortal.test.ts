import { describe, expect, it } from "vitest";

// The formula popover is a React portal rendered from inside an editable
// paragraph. React bubbles portal events through the React tree, so unless the
// portal root stops them, Enter/paste/focus in the popover reach the paragraph's
// handlers (splitting or pasting into it). Guard: every portal in the preview
// spreads the isolation handlers on its root element.
const source = Object.values(
  import.meta.glob("./components/MarkdownPreview.tsx", { eager: true, query: "?raw", import: "default" })
)[0] as string;

describe("Markdown preview portals", () => {
  it("isolate their events from the editable block that hosts them", () => {
    const portals = source.split("createPortal(").slice(1);
    expect(portals.length).toBeGreaterThan(0);
    for (const portal of portals) {
      // The root element's opening tag is the first `<div ... >` of the portal.
      const rootTag = portal.slice(portal.indexOf("<div"), portal.indexOf("\n    >") + 6);
      expect(rootTag).toContain("{...isolateFromEditableAncestor}");
    }
    const isolation = source.slice(source.indexOf("const isolateFromEditableAncestor"));
    const block = isolation.slice(0, isolation.indexOf("};"));
    for (const event of ["onClick", "onKeyDown", "onInput", "onPaste", "onFocus", "onBlur", "onMouseDown"]) {
      expect(block).toContain(`${event}: stop`);
    }
  });
});

// QA 20261003 follow-up (Esc ordering): one Esc, one effect. React 19
// delegates a portal's events to its container (document.body), and the
// isolation's `onKeyDown: stop` calls the native stopPropagation there — so a
// key pressed INSIDE the formula popover never reaches a document or window
// listener. The old window listener therefore could not close the popover
// from its own (autoFocused) field. Esc is now handled in React on the portal
// root (keeping the isolation), and a document listener — which runs before
// usePanelEscape's window listener — covers focus outside the popover and
// claims the key so an open docked panel stays open. Source-text guards (no
// DOM here); the real key routing in WKWebView needs the manual QA re-run.
describe("formula popover Esc (QA 20261003 follow-up)", () => {
  /** MathEditor's body, from its declaration to the next top-level `}`. */
  const editor = () => {
    const at = source.indexOf("function MathEditor(");
    expect(at, "MathEditor").toBeGreaterThan(-1);
    return source.slice(at, source.indexOf("\n}\n", at));
  };
  /** `const name = (…) => { … };` inside MathEditor, up to the `};` at the
   *  declaration's own indentation (so a nested handler is not over-read). */
  const fn = (name: string) => {
    const e = editor();
    const at = e.indexOf(`const ${name} = (`);
    expect(at, name).toBeGreaterThan(-1);
    const indent = at - e.lastIndexOf("\n", at) - 1;
    const end = e.indexOf(`\n${" ".repeat(indent)}};`, at);
    expect(end, `end of ${name}`).toBeGreaterThan(at);
    return e.slice(at, end);
  };
  /** The opening tag `<tag …>` containing `marker`, read up to its own `>`
   *  at brace depth 0 (so `=>` inside `{…}` attribute values does not end it). */
  const tagWith = (s: string, tag: string, marker: string) => {
    const hits: string[] = [];
    for (const m of s.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
      let depth = 0;
      let i = m.index! + m[0].length;
      for (; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        else if (s[i] === ">" && depth === 0) break;
      }
      const t = s.slice(m.index!, i + 1);
      if (t.includes(marker)) hits.push(t);
    }
    expect(hits, `<${tag}> with ${marker}`).toHaveLength(1);
    return hits[0];
  };

  it("the tag reader does not stop at an arrow function inside an attribute", () => {
    expect(tagWith('<div a={(e) => f(e)} role="dialog">x</div>', "div", 'role="dialog"')).toBe(
      '<div a={(e) => f(e)} role="dialog">'
    );
  });

  it("from its own field: the portal root handles Esc in React, AFTER (overriding) the isolation spread", () => {
    const root = tagWith(editor(), "div", 'role="dialog"');
    const spread = root.indexOf("{...isolateFromEditableAncestor}");
    const own = root.indexOf("onKeyDown={onDialogKeyDown}");
    expect(spread).toBeGreaterThan(-1);
    // Before the spread, the spread's `onKeyDown: stop` would win and Esc
    // would again do nothing from inside the popover.
    expect(own).toBeGreaterThan(spread);
  });

  it("…and that handler keeps the isolation, skips IME keys, claims the key, then closes", () => {
    const h = fn("onDialogKeyDown");
    const isolate = h.indexOf("stop(e);");
    const ime = h.indexOf("isImeKeyEventSince(e.nativeEvent, lastCompositionEnd.current)");
    const esc = h.indexOf('e.key !== "Escape"');
    const claim = h.indexOf("e.preventDefault();");
    const close = h.indexOf("onClose();");
    expect(isolate).toBeGreaterThan(-1);
    expect(ime).toBeGreaterThan(isolate);
    expect(esc).toBeGreaterThan(isolate);
    expect(claim).toBeGreaterThan(Math.max(ime, esc));
    expect(close).toBeGreaterThan(claim);
  });

  it("from outside the popover: a document listener (never window) that skips IME / claimed keys and claims its own", () => {
    const e = editor();
    expect(e).toContain('document.addEventListener("keydown", onKey);');
    expect(e).toContain('document.removeEventListener("keydown", onKey);');
    expect(e).not.toMatch(/window\.(add|remove)EventListener\("keydown"/);
    const h = fn("onKey");
    const skip = h.indexOf('if (e.key !== "Escape" || e.defaultPrevented) return;');
    const ime = h.indexOf("if (isImeKeyEventSince(e, lastCompositionEnd.current)) return;");
    const claim = h.indexOf("e.preventDefault();");
    expect(skip).toBeGreaterThan(-1);
    expect(ime).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(Math.max(skip, ime));
    expect(h.indexOf("onClose();")).toBeGreaterThan(claim);
  });

  it("both formula fields (display textarea, inline input) record compositionend for the 80 ms IME window", () => {
    for (const tag of ["textarea", "input"]) {
      const field = tagWith(editor(), tag, 'id="math-editor-input"');
      expect(field, tag).toMatch(/onCompositionEnd=\{\(\) => \{\s*lastCompositionEnd\.current = Date\.now\(\);\s*\}\}/);
    }
  });
});

describe("draft paragraph Esc (QA 20261003 follow-up)", () => {
  it("claims the key (preventDefault) when it discards the draft, after the IME guard", () => {
    const at = source.indexOf("function DraftBlock(");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf("\n}\n", at));
    const ime = block.indexOf("if (isImeKeyEventSince(e.nativeEvent, lastCompositionEnd.current)) return;");
    const branch = block.indexOf('if (e.key === "Escape") {');
    expect(ime).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(ime);
    const body = block.slice(branch, block.indexOf("return;", branch));
    const claim = body.indexOf("e.preventDefault();");
    expect(claim).toBeGreaterThan(-1);
    expect(body.indexOf("ctx?.setDraft(null);")).toBeGreaterThan(claim);
  });
});
