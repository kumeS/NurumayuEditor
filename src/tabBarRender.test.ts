import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TabBar from "./components/TabBar";

// BUG-018 behavioural guard (closes the C5c brittleness gap): the regex guard
// in closeTabWiring.test.ts misses an equivalently spelled gate such as
// `tabOrder.length !== 1`; rendering the bar with its only tab does not.
// Server rendering reads the store's INITIAL state, which is exactly one
// untitled tab — the case under test.

describe("TabBar renders a close button even for the only tab", () => {
  it("one tab → one 'Close tab' button", () => {
    const html = renderToStaticMarkup(createElement(TabBar));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1); // exactly one tab rendered
    expect(html.match(/aria-label="Close tab"/g)).toHaveLength(1);
  });
});
