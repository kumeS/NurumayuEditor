import { describe, expect, it } from "vitest";
import { JA } from "./i18n";

// Source-contract guards for Esc-to-close on the docked panels and popovers
// (BUG-006, QA 20261003; KI-35; review follow-up C8/C9/C10/C19). There is no
// DOM in this suite, so these prove the WIRING — the panels register
// usePanelEscape, Esc and the ✕ button share one close path, the hook listens
// where the "already claimed" (defaultPrevented) rule holds and asks the pure
// decision in panelEscape.ts. The real key/focus behaviour in WKWebView is
// closed by the manual QA re-run, not claimed here.

const SOURCES = import.meta.glob(
  [
    "./usePanelEscape.ts",
    "./components/ReviewPanel.tsx",
    "./components/NetworkPanel.tsx",
    "./components/Toolbar.tsx",
    "./components/DiffPanel.tsx",
    "./components/HealthBar.tsx",
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
    // The context is built once and shared with the unsent-text focus rule.
    expect(handler).toMatch(/const ctx = \{[\s\S]*?\};\s*const target = panelEscapeTarget\(e, ctx\);/);
    for (const arg of [
      "panels: openPanels",
      "targetPanel: dockedPanelOf(e.target)",
      "targetKind: shortcutTargetKind(e.target)",
      "modalOpen: useModalStack.getState().stack.length > 0",
      "presenting: useStore.getState().presentationOpen",
    ]) {
      expect(handler, arg).toContain(arg);
    }
    // Review follow-up (QA 20261003): the post-composition window reads the
    // recorded compositionend and the key's arrival on ONE clock (Date.now()).
    // Fails if the hook passes a constant, or e.timeStamp (another origin).
    expect(handler).toMatch(/\n\s+lastCompositionEnd,\n\s+now: Date\.now\(\),\n/);
    const guard = handler.indexOf("!== name) return;");
    const claim = handler.indexOf("e.preventDefault()");
    const close = handler.indexOf("close()");
    expect(guard).toBeGreaterThan(handler.indexOf("panelEscapeTarget("));
    expect(claim).toBeGreaterThan(guard);
    expect(close).toBeGreaterThan(claim);
  });

  // Review follow-up (QA 20261003): WebKit can deliver the Esc that cancels a
  // kana→kanji conversion AFTER compositionend, with isComposing false.
  // Fails if the listener is removed, moved off document capture phase (a
  // stopPropagation elsewhere would hide the event), or stops writing the time.
  it("records every compositionend (document, capture phase) for the post-composition window", () => {
    const h = hook();
    expect(h).toMatch(/\nlet lastCompositionEnd = 0;\n/);
    const effect = slice(h, "const onCompositionEnd = () => {", "}, [name, close]);");
    expect(effect).toMatch(/^const onCompositionEnd = \(\) => \{\s*lastCompositionEnd = Date\.now\(\);\s*\};/);
    expect(effect).toContain('document.addEventListener("compositionend", onCompositionEnd, true);');
    expect(effect).toContain('document.removeEventListener("compositionend", onCompositionEnd, true);');
    expect([...h.matchAll(/addEventListener\("compositionend"/g)]).toHaveLength(1);
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

  // Review follow-up (QA 20261003, C19): the helper NAMES above are not the
  // wiring — these arguments are. Each line is pinned in its own function body.
  // Killed mutants: `focusOnBody: false` (focus not handed back after the
  // common WebKit click-then-Esc), `[toggle, opener]` and
  // `returnFocus(null, name)` (keyboard opener loses to the toolbar toggle),
  // `closest("[data-docked-panel]")` (ANY panel counts as this one),
  // `inClosingPanel: false`, and an opener captured late or not at all.
  it("pins the focus-return arguments: this panel, body, opener before toggle, opener captured at first render", () => {
    const close = slice(hook(), "const close = useCallback", "useEffect(");
    expect(close).toContain('focusInPanel: !!active?.closest(`[data-docked-panel="${name}"]`),');
    expect(close).toContain("focusOnBody: !active || active === document.body,");
    expect(close).toContain("if (restore) setTimeout(() => returnFocus(opener, name), 0);");

    const ret = slice(hook(), "function returnFocus(", "\n}\n");
    expect(ret).toContain('const toggle = document.querySelector<HTMLElement>(`[data-panel-opener="${name}"]`);');
    expect(ret).toContain("const candidates = [opener, toggle];");
    expect(ret).toContain("const at = panelFocusReturnIndex(candidates.map((el) => candidateOf(el, name)));");
    expect(ret).toContain("if (at >= 0) candidates[at]?.focus();");

    const candidate = slice(hook(), "function candidateOf(", "\n}\n");
    for (const field of [
      "connected: el.isConnected,",
      "isBody: el === document.body,",
      'inClosingPanel: !!el.closest(`[data-docked-panel="${name}"]`),',
      'inert: !!el.closest("[inert]"),',
      'disabled: el.matches(":disabled"),',
    ]) {
      expect(candidate, field).toContain(field);
    }

    // Captured during the first render — before a child's autoFocus moves it.
    const capture = slice(hook(), "function captureOpener(", "\n}\n");
    expect(capture).toContain("return document.activeElement instanceof HTMLElement ? document.activeElement : null;");
    const body = slice(hook(), "export function usePanelEscape(", "\n}\n");
    expect(body).toContain("const [opener] = useState(captureOpener);");
    expect(body.indexOf("const [opener] = useState(captureOpener);")).toBeLessThan(body.indexOf("useLayoutEffect("));
  });

  it("returns the closer, so a panel's ✕ button can use the very same path", () => {
    expect(hook()).toMatch(/options\?: \{ unsentInput\?: \(\) => HTMLElement \| null \}\s*\): \(\) => void \{/);
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
    // Review passes an options object too (unsent comments); the close action is the same.
    expect(body()).toMatch(new RegExp(`const closePanel = usePanelEscape\\("${name}", \\(\\) => ${closer.replace(/[()]/g, "\\$&")}(\\);|, \\{)`));
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

// ---------------------------------------------------------------------------
// Every docked surface ↔ its hook (QA 20261003 follow-up). usePanelEscape
// finds "the panel focus is in" through data-docked-panel; a surface that
// carries the attribute but never registers the hook swallows Esc (the pure
// decision returns null for an unregistered panel holding focus), and a hook
// whose surface lacks the attribute never sees focus inside itself. Scanned
// over EVERY .tsx under src/ (App.tsx, components, any subfolder), so a future
// surface is caught without editing a list.

const SURFACES = import.meta.glob("./**/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// Review follow-up (QA 20261003, C10): the hook assumes mount = open. If App
// kept ReviewPanel / NetworkPanel mounted and hid it, the hidden panel would
// stay on the open stack for good and a stray Esc would "close" it (claiming
// the key and pulling focus to its toggle).
const APP_MOUNTS = [
  { component: "ReviewPanel", flag: "reviewPanelOpen" },
  { component: "NetworkPanel", flag: "networkOpen" },
] as const;

/** `{flag && (<Suspense …>…<Component />…</Suspense>)}`, the component inside
 *  that one Suspense (the match cannot run past its `</Suspense>`). */
function mountedOnlyWhile(source: string, flag: string, component: string): boolean {
  return new RegExp(
    `\\{${flag} && \\(\\s*<Suspense\\b(?:(?!<\\/Suspense>)[\\s\\S])*<${component} \\/>\\s*<\\/Suspense>\\s*\\)\\}`
  ).test(source);
}

describe.each(APP_MOUNTS)("App.tsx mounts $component only while open (mount = open)", ({ component, flag }) => {
  const app = () => {
    const s = SURFACES["./App.tsx"];
    expect(s, "App.tsx not found").toBeTruthy();
    return s;
  };

  it(`renders <${component} /> only inside {${flag} && (…)}`, () => {
    expect(mountedOnlyWhile(app(), flag, component)).toBe(true);
  });

  it("is rendered exactly once across every .tsx (no second, unconditional mount)", () => {
    const count = Object.values(SURFACES).reduce(
      (n, s) => n + [...s.matchAll(new RegExp(`<${component}\\b`, "g"))].length,
      0
    );
    expect(count).toBe(1);
  });

  // testing.md #2: the guard must reject the mutations that would keep the
  // panel mounted while closed.
  it("the predicate rejects an always-true flag and a mount moved out of the block", () => {
    const always = app().replace(`{${flag} && (`, `{(true || ${flag}) && (`);
    expect(always).not.toBe(app());
    expect(mountedOnlyWhile(always, flag, component)).toBe(false);
    const moved = app()
      .replace(`<${component} />`, "<div />")
      .replace(`{${flag} && (`, `<${component} />\n{${flag} && (`);
    expect(moved).not.toBe(app());
    expect(mountedOnlyWhile(moved, flag, component)).toBe(false);
  });
});

/** The top-level function declaration enclosing `index`, up to its closing `\n}\n`. */
function enclosingFunction(source: string, index: number): string {
  let start = -1;
  for (const m of source.matchAll(/^(?:export (?:default )?)?function \w+/gm)) {
    if (m.index! <= index) start = m.index!;
  }
  if (start === -1) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Wiring problems in one source file (an empty list = every surface is wired). */
function dockedSurfaceProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  if (/data-docked-panel=\{/.test(source)) problems.push(`${file}: dynamic data-docked-panel (the guard reads literals)`);
  for (const m of source.matchAll(/data-docked-panel="([^"]+)"/g)) {
    const fn = enclosingFunction(source, m.index!);
    if (!fn.includes(`usePanelEscape("${m[1]}",`)) {
      problems.push(`${file}: data-docked-panel="${m[1]}" without usePanelEscape("${m[1]}", …) in the same component`);
    }
  }
  for (const m of source.matchAll(/usePanelEscape\("([^"]+)",/g)) {
    const fn = enclosingFunction(source, m.index!);
    if (!fn.includes(`data-docked-panel="${m[1]}"`)) {
      problems.push(`${file}: usePanelEscape("${m[1]}") without data-docked-panel="${m[1]}" in the same component`);
    }
  }
  return problems;
}

describe("every data-docked-panel surface registers usePanelEscape under the same name", () => {
  it("the scanner catches an attribute without a hook, a hook without an attribute, and a name mismatch", () => {
    const attrOnly = 'function A() {\n  return <div data-docked-panel="a" />;\n}\n';
    const hookOnly = 'function B() {\n  const c = usePanelEscape("b", f);\n  return <div />;\n}\n';
    const mismatch = 'function C() {\n  const c = usePanelEscape("c", f);\n  return <div data-docked-panel="cc" />;\n}\n';
    // The hook in ANOTHER component does not count (each popover owns its own).
    const elsewhere =
      'function D() {\n  const c = usePanelEscape("d", f);\n  return null;\n}\nfunction E() {\n  return <div data-docked-panel="d" />;\n}\n';
    const good = 'function G() {\n  const c = usePanelEscape("g", f);\n  return <div data-docked-panel="g" />;\n}\n';
    expect(dockedSurfaceProblems("a", attrOnly)).toHaveLength(1);
    expect(dockedSurfaceProblems("b", hookOnly)).toHaveLength(1);
    expect(dockedSurfaceProblems("c", mismatch)).toHaveLength(2);
    expect(dockedSurfaceProblems("d", elsewhere)).toHaveLength(2);
    expect(dockedSurfaceProblems("g", good)).toEqual([]);
  });

  it("holds for every .tsx under src/", () => {
    expect(Object.keys(SURFACES)).toEqual(expect.arrayContaining(["./App.tsx", "./components/HealthBar.tsx"]));
    const problems = Object.entries(SURFACES).flatMap(([f, s]) => dockedSurfaceProblems(f, s));
    expect(problems).toEqual([]);
  });

  it("each name is one surface, and each has a toggle marked to take focus back (or is palette-only)", () => {
    const names = Object.values(SURFACES).flatMap((s) =>
      // JSX attributes only (preceded by whitespace) — not a selector string.
      [...s.matchAll(/\sdata-docked-panel="([^"]+)"/g)].map((m) => m[1])
    );
    // KI-35 (QA 20261003 follow-up): the changes panel and both status-bar
    // popovers; C8 (review follow-up): the three palette-only panels.
    expect(names).toEqual(
      expect.arrayContaining(["review", "network", "diff", "char-limit", "report", ...Object.keys(PALETTE_ONLY)])
    );
    expect(new Set(names).size).toBe(names.length);
    const all = Object.values(SURFACES).join("\n");
    const palette = SURFACES["./components/CommandPalette.tsx"];
    expect(palette, "CommandPalette.tsx not found").toBeTruthy();
    for (const name of names) {
      const marked = new RegExp(`(data-panel-opener|opener)="${name}"`);
      if (name in PALETTE_ONLY) {
        // An exact list: a palette-only panel that gains a marked toggle must
        // leave it, and each one really is opened from the palette.
        expect(all, `${name} has a marked toggle now — drop it from PALETTE_ONLY`).not.toMatch(marked);
        expect(palette, `palette entry for ${name}`).toContain(`run: wrap(${PALETTE_ONLY[name]})`);
      } else {
        expect(all, `opener for ${name}`).toMatch(marked);
      }
    }
  });
});

/** Docked surfaces with no persistent toggle (review follow-up, QA 20261003,
 *  C8): opened from the ⌘K palette (Personal library also from a link inside
 *  Settings, a modal that closes as it opens the panel). Their only
 *  focus-return candidate is the opener captured at mount, when still usable. */
const PALETTE_ONLY: Record<string, string> = {
  criteria: "openCriteriaPanel",
  "personal-library": "openPersonalLibraryPanel",
  citations: "openCitationsPanel",
};

// Review follow-up (QA 20261003, C8): the Criteria, Personal library and
// Citations panels were always mounted, self-hiding and unregistered, so Esc
// from a control inside one fell through to the topmost REGISTERED panel and
// closed, e.g., the Review panel across the screen. Each now registers through
// a frame component that its always-mounted wrapper renders only while open
// (mount = open; the hook is never called conditionally). The wrapper keeps
// the panel's state, so closing and reopening loses nothing (typed criteria,
// the session's cited entries, the search query).
const STATUS_PANELS = [
  {
    file: "CriteriaPanel",
    name: "criteria",
    frame: "CriteriaPanelFrame",
    openVar: "open",
    closeLabel: 'aria-label={t("Close review criteria panel")}',
    keeps: 'const [text, setText] = useState("");',
  },
  {
    file: "PersonalLibraryPanel",
    name: "personal-library",
    frame: "PersonalLibraryPanelFrame",
    openVar: "open_",
    closeLabel: 'aria-label={t("Close personal library panel")}',
    keeps: 'const [query, setQuery] = useState("");',
  },
  {
    file: "CitationsPanel",
    name: "citations",
    frame: "CitationsPanelFrame",
    openVar: "open_",
    closeLabel: 'aria-label={t("Close citations panel")}',
    keeps: "const [citedIds, setCitedIds] = useState<string[]>([]);",
  },
] as const;

describe.each(STATUS_PANELS)("$file closes on Esc through its ✕ path (C8)", ({ file, name, frame, openVar, closeLabel, keeps }) => {
  const panel = () => {
    const s = SURFACES[`./components/${file}.tsx`];
    expect(s, `${file}.tsx not found`).toBeTruthy();
    return s;
  };
  const frameFn = () => slice(panel(), `function ${frame}(`, "\n}\n");
  const wrapper = () => slice(panel(), `export default function ${file}(`, "\n}\n");

  // Fails if the hook is removed or registered under another name / action.
  it("its frame registers usePanelEscape with the close action it is given", () => {
    expect(panel()).toMatch(/import \{ usePanelEscape \} from "\.\.\/usePanelEscape";/);
    expect(frameFn()).toContain(`const closePanel = usePanelEscape("${name}", onClose);`);
  });

  // Fails if the tag leaves the root, or the ✕ bypasses the closer / loses the hint.
  it("the frame's root carries data-docked-panel, and its ✕ is the hook's closer naming the shortcut", () => {
    const ret = frameFn().slice(frameFn().indexOf("  return (\n"));
    expect(openingTags(ret, "div")[0]).toContain(`data-docked-panel="${name}"`);
    const button = tagWith(frameFn(), "button", closeLabel);
    expect(button).toContain("onClick={closePanel}");
    expect(button).toContain('title={t("Close (Esc)")}');
    expect(JA["Close (Esc)"]).toBe("閉じる (Esc)");
  });

  // Fails if the wrapper calls the hook (always mounted ≠ open), renders the
  // frame before its closed-guard, or keeps a second close path.
  it("the always-mounted wrapper never calls the hook and renders the frame only while open", () => {
    const w = wrapper();
    expect(w).not.toContain("usePanelEscape(");
    const guard = w.indexOf(`if (!${openVar}) return null;`);
    const mount = w.indexOf(`<${frame} onClose={() => setOpen(false)}>`);
    expect(guard).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(guard);
    expect(panel().split(`<${frame}`)).toHaveLength(2);
    expect(panel().split("setOpen(false)")).toHaveLength(2);
  });

  // Fails if the panel's state moves into the frame, which unmounts on close.
  it("the wrapper, not the frame, keeps the panel's state across close and reopen", () => {
    expect(wrapper()).toContain(keeps);
    expect(frameFn()).not.toMatch(/\buse(State|Effect|Reducer)\b/);
  });

  // Fails if the wrapper is mounted twice, or not at all.
  it("is mounted exactly once (in HealthBar), always", () => {
    const count = Object.values(SURFACES).reduce(
      (n, s) => n + [...s.matchAll(new RegExp(`<${file}\\b`, "g"))].length,
      0
    );
    expect(count).toBe(1);
    expect(SURFACES["./components/HealthBar.tsx"]).toContain(`<${file} />`);
  });
});

// KI-35 (v1.4.0): the changes panel and the two status-bar popovers did not
// close on Esc. DiffPanel registers the hook itself (HealthBar mounts it only
// while diffPanelOpen); each popover is its own component, mounted only while
// open, because the hook assumes mount = open and must never be called
// conditionally.
describe("DiffPanel closes on Esc through its ✕ path (KI-35)", () => {
  const dp = () => src("./components/DiffPanel.tsx");
  const body = () => dp().slice(dp().indexOf("export default function DiffPanel"));

  it("registers usePanelEscape(\"diff\") with the onClose it is given", () => {
    expect(dp()).toMatch(/import \{ usePanelEscape \} from "\.\.\/usePanelEscape";/);
    expect(body()).toContain('const closePanel = usePanelEscape("diff", onClose);');
  });

  it("its ✕ button is the hook's closer and names the shortcut; no second close path", () => {
    const button = tagWith(body(), "button", 'aria-label={t("Close changes panel")}');
    expect(button).toContain("onClick={closePanel}");
    expect(button).toContain('title={t("Close panel (Esc)")}');
    expect(dp()).not.toMatch(/onClick=\{onClose\}/);
  });

  it("its root element carries data-docked-panel=\"diff\"", () => {
    const ret = body().slice(body().indexOf("  return (\n"));
    expect(openingTags(ret, "div")[0]).toContain('data-docked-panel="diff"');
  });

  it("HealthBar mounts it only while open, and its toggle is the focus-return opener", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toMatch(/\{diffPanelOpen && \(\s*<div[^>]*>\s*<DiffPanel onClose=\{\(\) => toggleDiffPanel\(false\)\} \/>/);
    expect(tagWith(hb, "button", "onClick={() => toggleDiffPanel()}")).toContain('data-panel-opener="diff"');
  });
});

const POPOVERS = [
  {
    fn: "function CharLimitPopover(",
    name: "char-limit",
    closeLabel: 'aria-label={t("Close over-limit paragraph list")}',
    mount: /\{showCharLimit && overLimitChunks\.length > 0 && \(\s*<CharLimitPopover\b[^>]*onClose=\{\(\) => setShowCharLimit\(false\)\}/,
    toggle: "onClick={() => setShowCharLimit((v) => !v)}",
  },
  {
    fn: "function ExportReportPopover(",
    name: "report",
    closeLabel: 'aria-label={t("Close")}',
    mount: /\{showWarnings && lastExportReport && report && \(\s*<ExportReportPopover\b[^>]*onClose=\{\(\) => setShowWarnings\(false\)\}/,
    toggle: "setShowWarnings((v) => !v);",
  },
] as const;

describe.each(POPOVERS)("HealthBar $name popover closes on Esc (KI-35)", ({ fn, name, closeLabel, mount, toggle }) => {
  const hb = () => src("./components/HealthBar.tsx");
  const popover = () => slice(hb(), fn, "\n}\n");

  it("is its own component, mounted only while open, that registers the hook unconditionally", () => {
    expect(hb()).toMatch(/import \{ usePanelEscape \} from "\.\.\/usePanelEscape";/);
    expect(popover()).toContain(`const closePanel = usePanelEscape("${name}", onClose);`);
    expect(hb()).toMatch(mount);
    // The bar itself never calls the hook: it is always mounted (mount ≠ open).
    const bar = slice(hb(), "export default function HealthBar", "\n}\n");
    expect(bar).not.toContain("usePanelEscape(");
  });

  it("its root carries data-docked-panel, and its ✕ is the hook's closer naming the shortcut", () => {
    const ret = popover().slice(popover().indexOf("  return (\n"));
    expect(openingTags(ret, "div")[0]).toContain(`data-docked-panel="${name}"`);
    const button = tagWith(popover(), "button", closeLabel);
    expect(button).toContain("onClick={closePanel}");
    expect(button).toContain('title={t("Close (Esc)")}');
    expect(JA["Close (Esc)"]).toBe("閉じる (Esc)");
  });

  it("its toggle in the bar is marked as the focus-return opener", () => {
    expect(tagWith(hb(), "button", toggle)).toContain(`data-panel-opener="${name}"`);
  });
});

describe("char-limit popover: jumping to a paragraph is not a close-and-return-focus", () => {
  it("the jump button closes with the raw onClose — the hook's deferred focus return would race the caret placement", () => {
    const popover = slice(src("./components/HealthBar.tsx"), "function CharLimitPopover(", "\n}\n");
    const jump = tagWith(popover, "button", 'title={t("Jump to this paragraph")}');
    const focus = jump.indexOf("onJump(oc.id);");
    expect(focus).toBeGreaterThan(-1);
    expect(jump.indexOf("onClose();")).toBeGreaterThan(focus);
    expect(jump).not.toContain("closePanel");
    // …and onJump is what the bar used to do: focus + flash the paragraph.
    const bar = slice(src("./components/HealthBar.tsx"), "export default function HealthBar", "\n}\n");
    expect(tagWith(bar, "CharLimitPopover", "onJump=")).toMatch(
      /onJump=\{\(id\) => \{\s*setFocused\(id\);\s*flashChunk\(id\);\s*\}\}/
    );
  });
});

// Review follow-up (QA 20261003): once focus left the composer, Esc closed the
// Review panel and silently dropped an unsent comment (the composer and an
// open edit are local state that unmounts with the panel). Esc now claims the
// key, keeps the panel open and moves focus to the unsent text instead.
describe("Review panel: Esc never discards an unsent comment", () => {
  const review = () => src("./components/ReviewPanel.tsx");

  // Fails if the hook closes before asking, or forgets to claim the key.
  it("the hook asks for unsent input after claiming the key and before closing", () => {
    expect(hook()).toMatch(
      /export function usePanelEscape\(\s*name: string,\s*onClose: \(\) => void,\s*options\?: \{ unsentInput\?: \(\) => HTMLElement \| null \}\s*\)/
    );
    const onKey = slice(hook(), "const onKey = (e: KeyboardEvent) => {", "window.addEventListener");
    const claim = onKey.indexOf("e.preventDefault();");
    const ask = onKey.indexOf("optionsRef.current?.unsentInput?.()");
    const close = onKey.indexOf("close();");
    expect(claim).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(claim);
    expect(close).toBeGreaterThan(ask);
    expect(onKey.slice(ask, close)).toMatch(
      /if \(unsent\) \{\s*if \(unsentFocusAllowed\(name, ctx\)\) unsent\.focus\(\);\s*return;\s*\}/
    );
  });

  // Fails if ReviewPanel stops passing the option, or a draft field loses its marker.
  it("ReviewPanel reports its composer and an edited comment as unsent input", () => {
    expect(review()).toMatch(
      /usePanelEscape\("review", \(\) => toggleReviewPanel\(false\), \{\s*unsentInput: \(\) =>\s*document\.querySelector<HTMLElement>\('\[data-docked-panel="review"\] \[data-unsent="true"\]'\),\s*\}\)/
    );
    expect(tagWith(review(), "textarea", "value={composerText}")).toContain(
      'data-unsent={composerText.trim() ? "true" : undefined}'
    );
    expect(tagWith(review(), "textarea", "value={draft}")).toContain(
      'data-unsent={draft.trim() !== comment.text ? "true" : undefined}'
    );
  });
});
