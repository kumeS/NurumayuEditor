import { describe, expect, it } from "vitest";
import { useCitationsPanelStore } from "./components/CitationsPanel";
import { useCriteriaPanelStore } from "./components/CriteriaPanel";
import { usePersonalLibraryPanelStore } from "./components/PersonalLibraryPanel";

// Review follow-up (QA 20261003): the Criteria, Personal library and Citations
// panels all open in the same bottom-right corner (`fixed bottom-9 right-2`),
// painted in DOM order. With two open, Esc closed the most recently OPENED one
// even when it was hidden underneath the other. The corner now holds one panel
// at a time, so the panel on screen is the only one open — and the one Esc
// closes. Fails if a store's setOpen(true) / toggle() stops closing the others.
const STORES = {
  citations: useCitationsPanelStore,
  criteria: useCriteriaPanelStore,
  library: usePersonalLibraryPanelStore,
};
const openNames = () =>
  Object.entries(STORES)
    .filter(([, s]) => s.getState().open)
    .map(([n]) => n);
const closeAll = () => Object.values(STORES).forEach((s) => s.getState().setOpen(false));

describe("the bottom-right corner shows one panel at a time", () => {
  it("opening a panel closes the other two (setOpen)", () => {
    closeAll();
    STORES.citations.getState().setOpen(true);
    expect(openNames()).toEqual(["citations"]);
    STORES.criteria.getState().setOpen(true);
    expect(openNames()).toEqual(["criteria"]);
    STORES.library.getState().setOpen(true);
    expect(openNames()).toEqual(["library"]);
  });

  it("toggling a panel open closes the others; toggling it shut leaves them shut", () => {
    closeAll();
    STORES.criteria.getState().setOpen(true);
    STORES.citations.getState().toggle();
    expect(openNames()).toEqual(["citations"]);
    STORES.citations.getState().toggle();
    expect(openNames()).toEqual([]);
  });

  it("closing one never opens or closes another", () => {
    closeAll();
    STORES.library.getState().setOpen(true);
    STORES.criteria.getState().setOpen(false);
    expect(openNames()).toEqual(["library"]);
  });
});
