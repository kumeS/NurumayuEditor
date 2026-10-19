import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SlideEditor, { SlideViewTabs } from "./components/SlideEditor";
import { useStore } from "./store";

// BUG-003 (QA 20261003): in Slides, after Preview → Edit the macOS
// accessibility tree showed BOTH "スライドを編集" and "スライドをプレビュー"
// selected, although only Edit had aria-selected="true". WebKit exposes a
// role=tab as selected when aria-selected="true" OR when a tabpanel it
// aria-controls holds the keyboard focus (AccessibilityObject::isSelected →
// isTabItemSelected). Both tabs controlled the one canvas panel, and in Edit
// the focused slide paragraph's ChunkView mounts inside that panel and takes
// the focus (its applyFocus effect) — so the unselected Preview tab read as
// selected too. In Preview no ChunkView mounts, so focus stayed outside and
// only one tab was selected (the asymmetry QA reported).
//
// There is no DOM here: the editor is server-rendered (SSR reads the store's
// INITIAL state — one blank tab, one slide holding one paragraph, English UI),
// and the WebKit rule is modelled by `exposedSelected`. The Edit/Preview
// `view` is the only state the switch depends on, so the Edit render IS the
// state after Preview → Edit.

const firstChunkId = useStore.getInitialState().doc.chunks[0].id;

interface Tab {
  label: string;
  attrs: Record<string, string>;
}

/** The attributes of one opening tag (`<tag a="b" …>`). */
function attrsOf(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of openTag.matchAll(/\s([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** The element (opening tag … matching close) of `tag` that starts at `start`. */
function elementAt(html: string, start: number, tag: string): string {
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`unclosed <${tag}> at ${start}`);
}

/** The role=tab buttons inside the role=tablist, scoped to that element. */
function tabsIn(html: string): Tab[] {
  const at = html.indexOf('role="tablist"');
  expect(at, "tablist").toBeGreaterThan(-1);
  const list = elementAt(html, html.lastIndexOf("<div", at), "div");
  return [...list.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)]
    .map((m) => ({ label: m[2], attrs: attrsOf(m[1]) }))
    .filter((t) => t.attrs.role === "tab");
}

/** The role=tabpanel element (opening tag through its close). */
function panelIn(html: string): { attrs: Record<string, string>; html: string } {
  const at = html.indexOf('role="tabpanel"');
  expect(at, "tabpanel").toBeGreaterThan(-1);
  const el = elementAt(html, html.lastIndexOf("<div", at), "div");
  return { attrs: attrsOf(el.slice(0, el.indexOf(">") + 1)), html: el };
}

/**
 * WebKit's AX "selected" for a role=tab (AccessibilityObject::isSelected):
 * aria-selected="true", or it aria-controls a tabpanel holding the focus.
 */
function exposedSelected(tab: Tab, focusedPanelId: string | null): boolean {
  if (tab.attrs["aria-selected"] === "true") return true;
  const controls = (tab.attrs["aria-controls"] ?? "").split(/\s+/).filter(Boolean);
  return focusedPanelId !== null && controls.includes(focusedPanelId);
}

describe("BUG-003 (QA 20261003) — the Slides Edit/Preview tabs expose exactly one selected tab", () => {
  // Fails if both tabs aria-control the canvas panel again (the pre-fix
  // `aria-controls="slide-canvas-panel"` on every tab): the slide's paragraph
  // editor sits in that panel, so with the caret there the Preview tab would
  // also read as selected.
  it("Edit (after Preview → Edit, focus in the slide's paragraph): only Edit slide is selected", () => {
    const html = renderToStaticMarkup(createElement(SlideEditor));
    const tabs = tabsIn(html);
    expect(tabs.map((t) => t.label)).toEqual(["Edit slide", "Preview slide"]);
    const panel = panelIn(html);
    // The slide's paragraph editor (ChunkView) is rendered inside the panel —
    // that is where its mount effect puts the keyboard focus.
    expect(panel.html).toContain(`data-chunk-id="${firstChunkId}"`);
    const focusedPanelId = panel.attrs.id;
    expect(focusedPanelId).toBeTruthy();
    expect(tabs.filter((t) => exposedSelected(t, focusedPanelId)).map((t) => t.label)).toEqual([
      "Edit slide",
    ]);
  });

  // Fails if the panel stops naming the selected tab (no aria-labelledby) or
  // the selected tab stops controlling it. (That the label follows `view`
  // into Preview is guarded at the source in slideEditorWiring.test.ts.)
  it("the panel is controlled by, and labelled by, the selected tab only", () => {
    const html = renderToStaticMarkup(createElement(SlideEditor));
    const [edit, preview] = tabsIn(html);
    const panel = panelIn(html);
    expect(edit.attrs.id).toBeTruthy();
    expect(edit.attrs["aria-controls"]).toBe(panel.attrs.id);
    expect(panel.attrs["aria-labelledby"]).toBe(edit.attrs.id);
    expect(preview.attrs).not.toHaveProperty("aria-controls");
  });
});

describe("BUG-003 (QA 20261003) — SlideViewTabs in each view", () => {
  const noop = () => {};
  const render = (view: "edit" | "preview") => tabsIn(renderToStaticMarkup(createElement(SlideViewTabs, { view, onSelect: noop })));
  const panelId = panelIn(renderToStaticMarkup(createElement(SlideEditor))).attrs.id;

  // Fails if aria-selected stops tracking `view` (a stale or hard-coded
  // value) or if the unselected tab aria-controls the panel again: in either
  // view the panel can hold the focus (Edit's paragraph editors, Preview's
  // speaker-notes field), so each case is checked with focus in and out.
  for (const [view, label] of [
    ["edit", "Edit slide"],
    ["preview", "Preview slide"],
  ] as const) {
    it(`${view}: exactly one tab is selected — ${label} — with focus inside the panel or not`, () => {
      const tabs = render(view);
      expect(tabs.map((t) => t.label)).toEqual(["Edit slide", "Preview slide"]);
      expect(tabs.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.label)).toEqual([label]);
      expect(tabs.filter((t) => exposedSelected(t, panelId)).map((t) => t.label)).toEqual([label]);
      expect(tabs.filter((t) => exposedSelected(t, null)).map((t) => t.label)).toEqual([label]);
      expect(tabs.filter((t) => "aria-controls" in t.attrs).map((t) => t.label)).toEqual([label]);
    });
  }

  it("each tab has its own id (the panel's aria-labelledby target)", () => {
    const ids = render("edit").map((t) => t.attrs.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(render("preview").map((t) => t.attrs.id)).toEqual(ids);
  });
});
