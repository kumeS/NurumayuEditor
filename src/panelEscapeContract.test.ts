import { describe, expect, it } from "vitest";
import { JA } from "./i18n";

// Source-contract guards for Esc-to-close on the right-docked side panels
// (BUG-006, QA 20261003). There is no DOM in this suite, so these prove the
// WIRING — the panels register usePanelEscape, Esc and the ✕ button share one
// close path, the hook listens where the "already claimed" (defaultPrevented)
// rule holds and asks the pure decision in panelEscape.ts. The real key/focus
// behaviour in WKWebView is closed by the manual QA re-run, not claimed here.

const SOURCES = import.meta.glob(
  [
    "./usePanelEscape.ts",
    "./components/ReviewPanel.tsx",
    "./components/NetworkPanel.tsx",
    "./components/Toolbar.tsx",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(path: string): string {
  const s = SOURCES[path];
  expect(s, `${path} not found`).toBeTruthy();
  return s;
}
const hook = () => src("./usePanelEscape.ts");

/** Every opening JSX tag `<tag …>`, read up to the `>` that closes it at
 *  brace depth 0 (so `=>` inside `{…}` attribute values does not end it). */
function openingTags(source: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
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

/** The single opening tag of `tag` that contains `marker`. */
function tagWith(source: string, tag: string, marker: string): string {
  const hits = openingTags(source, tag).filter((t) => t.includes(marker));
  expect(hits, `<${tag}> containing ${marker}`).toHaveLength(1);
  return hits[0];
}

/** Body of a function, from `start` up to the next top-level declaration. */
function slice(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  return source.slice(at, stop === -1 ? undefined : stop);
}

describe("usePanelEscape wiring", () => {
  it("the tag reader does not stop at an arrow function inside an attribute", () => {
    expect(openingTags("<button onClick={() => close()} title={x}>✕</button>", "button")).toEqual([
      "<button onClick={() => close()} title={x}>",
    ]);
  });

  it("installs ONE window bubble-phase keydown listener — after React's handlers and every document listener", () => {
    const h = hook();
    expect([...h.matchAll(/window\.addEventListener\("keydown", onKey\)/g)]).toHaveLength(1);
    expect(h).toMatch(/window\.removeEventListener\("keydown", onKey\)/);
    // Capture phase, or a document listener, would run BEFORE the find bar /
    // toolbar dropdowns get to claim the key with preventDefault.
    expect(h).not.toMatch(/addEventListener\("keydown",\s*\w+,\s*(true|\{)/);
    expect(h).not.toMatch(/document\.addEventListener\("keydown"/);
  });

  it("asks the pure decision with the live target, stack, modal and presentation state, and acts only for itself", () => {
    const handler = slice(hook(), "const onKey", "window.addEventListener");
    for (const arg of [
      "panelEscapeTarget(e, {",
      "panels: openPanels",
      "targetPanel: dockedPanelOf(e.target)",
      "targetKind: shortcutTargetKind(e.target)",
      "modalOpen: useModalStack.getState().stack.length > 0",
      "presenting: useStore.getState().presentationOpen",
    ]) {
      expect(handler, arg).toContain(arg);
    }
    const guard = handler.indexOf("!== name) return;");
    const claim = handler.indexOf("e.preventDefault()");
    const close = handler.indexOf("close()");
    expect(guard).toBeGreaterThan(handler.indexOf("panelEscapeTarget("));
    expect(claim).toBeGreaterThan(guard);
    expect(close).toBeGreaterThan(claim);
  });

  it("keeps the open order on a UI-only stack: push on mount, pop on unmount, in a layout effect", () => {
    const effect = slice(hook(), "useLayoutEffect(() => {\n    openPanels", "}, [name]);");
    expect(effect).toMatch(/openPanels = pushModal\(openPanels, name\)/);
    expect(effect).toMatch(/openPanels = popModal\(openPanels, name\)/);
    expect(hook()).not.toMatch(/useStore\.setState|localStorage|sessionStorage/);
  });

  it("the closer reads where focus is BEFORE closing (the panel unmounts) and hands it back via the pure helpers", () => {
    const close = slice(hook(), "const close = useCallback", "useEffect(");
    const decide = close.indexOf("shouldReturnPanelFocus(");
    const run = close.indexOf("onCloseRef.current()");
    expect(decide).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(decide);
    expect(hook()).toContain("panelFocusReturnIndex(");
    expect(hook()).toMatch(/\[data-panel-opener="\$\{name\}"\]/);
    // The deferred return never steals focus something else placed meanwhile.
    const ret = slice(hook(), "function returnFocus(", "\n}\n");
    const stillLost = ret.indexOf("if (active && active !== document.body) return;");
    expect(stillLost).toBeGreaterThan(-1);
    expect(ret.indexOf(".focus()")).toBeGreaterThan(stillLost);
  });

  it("returns the closer, so a panel's ✕ button can use the very same path", () => {
    expect(hook()).toMatch(/export function usePanelEscape\(name: string, onClose: \(\) => void\): \(\) => void/);
    expect(hook()).toMatch(/\n  return close;\n\}/);
  });
});

const PANELS = [
  { file: "ReviewPanel", name: "review", closer: "toggleReviewPanel(false)", fn: "export default function ReviewPanel" },
  { file: "NetworkPanel", name: "network", closer: "toggleNetwork(false)", fn: "export default function NetworkPanel" },
] as const;

describe.each(PANELS)("$file closes on Esc through its ✕ path (BUG-006)", ({ file, name, closer, fn }) => {
  const panel = () => src(`./components/${file}.tsx`);
  const body = () => panel().slice(panel().indexOf(fn));

  it("registers usePanelEscape with its name and its close action", () => {
    expect(panel()).toMatch(/import \{ usePanelEscape \} from "\.\.\/usePanelEscape";/);
    expect(body()).toContain(`const closePanel = usePanelEscape("${name}", () => ${closer});`);
  });

  it("has ONE close path: the ✕ button calls the closer the hook returned", () => {
    const button = tagWith(body(), "button", 'aria-label={t("Close panel")}');
    expect(button).toContain("onClick={closePanel}");
    // The raw close action appears only inside the hook call — no second path.
    expect(panel().split(closer)).toHaveLength(2);
  });

  it("its root <aside> carries the data-docked-panel name the hook looks for", () => {
    const aside = openingTags(body(), "aside")[0];
    expect(aside).toContain(`data-docked-panel="${name}"`);
  });

  it("the ✕ tooltip names the Esc shortcut it now has, in Japanese too", () => {
    const button = tagWith(body(), "button", 'aria-label={t("Close panel")}');
    expect(button).toContain('title={t("Close panel (Esc)")}');
    expect(JA["Close panel (Esc)"]).toBe("パネルを閉じる (Esc)");
  });
});

describe("Toolbar marks each panel's toggle so Esc can return focus to it", () => {
  const toolbar = () => src("./components/Toolbar.tsx");

  it("ToolButton forwards its opener prop as data-panel-opener", () => {
    const fn = slice(toolbar(), "function ToolButton(", "\n}\n");
    expect(tagWith(fn, "button", "onClick={onClick}")).toContain("data-panel-opener={opener}");
  });

  it("the Review toggle is opener=\"review\"", () => {
    expect(tagWith(toolbar(), "ToolButton", "toggleReviewPanel()")).toContain('opener="review"');
  });

  it("the graph toggle is data-panel-opener=\"network\"", () => {
    expect(tagWith(toolbar(), "button", "toggleNetwork(false)")).toContain('data-panel-opener="network"');
  });
});
