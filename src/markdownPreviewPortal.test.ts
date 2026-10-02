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
