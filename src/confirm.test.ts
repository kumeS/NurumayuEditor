import { beforeEach, describe, expect, it, vi } from "vitest";

// The unsaved-changes dialog (BUG-011): three outcomes via plugin-dialog
// `message()` with yes/no/cancel buttons, resolved by the clicked LABEL.
const dialogMessage = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => dialogMessage(...args),
}));

import { askUnsaved, resolveUnsavedChoice } from "./confirm";
import { useStore } from "./store";

const JA_LABELS = { save: "保存", discard: "保存しない", cancel: "キャンセル" };

describe("resolveUnsavedChoice — only the exact Save / Don't Save labels act", () => {
  it("maps the Save label to save and the Don't Save label to discard", () => {
    expect(resolveUnsavedChoice("保存", JA_LABELS)).toBe("save");
    expect(resolveUnsavedChoice("保存しない", JA_LABELS)).toBe("discard");
  });

  it("treats everything else — Cancel, a dismissed dialog, plugin defaults, junk — as cancel", () => {
    for (const r of ["キャンセル", "Cancel", "Yes", "No", "Ok", "", "unexpected", " 保存", "保存しない "]) {
      expect(resolveUnsavedChoice(r, JA_LABELS), r).toBe("cancel");
    }
    expect(resolveUnsavedChoice(null, JA_LABELS)).toBe("cancel");
    expect(resolveUnsavedChoice(undefined, JA_LABELS)).toBe("cancel");
  });

  it("never discards when the Save and Don't Save labels collide (a broken translation)", () => {
    const broken = { save: "保存", discard: "保存", cancel: "キャンセル" };
    expect(resolveUnsavedChoice("保存", broken)).toBe("cancel");
  });
});

describe("askUnsaved — the native three-button dialog", () => {
  beforeEach(() => {
    dialogMessage.mockReset();
    useStore.setState({ settings: null }); // English UI
  });

  it("puts Save in the default slot and Cancel in the dismiss (cancel) slot", async () => {
    dialogMessage.mockResolvedValue("Cancel");
    await askUnsaved("tab", "Report");
    const opts = dialogMessage.mock.calls[0][1];
    expect(opts.buttons).toEqual({ yes: "Save", no: "Don't Save", cancel: "Cancel" });
    expect(opts.kind).toBe("warning");
    expect(opts.title).toBe("Unsaved changes");
  });

  it("names the document in the message, falling back to Untitled", async () => {
    dialogMessage.mockResolvedValue("Cancel");
    await askUnsaved("tab", "Report");
    await askUnsaved("quit", "");
    expect(dialogMessage.mock.calls[0][0]).toBe(
      "Do you want to save the changes to “Report” before closing it?"
    );
    expect(dialogMessage.mock.calls[1][0]).toBe(
      "Do you want to save the changes to “Untitled” before quitting?"
    );
  });

  it("resolves the clicked label against the same labels it showed (Japanese UI)", async () => {
    useStore.setState({ settings: { defaultTargetLanguage: "日本語" } as never });
    dialogMessage.mockResolvedValueOnce("保存");
    expect(await askUnsaved("tab", "報告書")).toBe("save");
    dialogMessage.mockResolvedValueOnce("保存しない");
    expect(await askUnsaved("tab", "報告書")).toBe("discard");
    dialogMessage.mockResolvedValueOnce("キャンセル");
    expect(await askUnsaved("tab", "報告書")).toBe("cancel");
    expect(dialogMessage.mock.calls[0][1].buttons).toEqual({
      yes: "保存",
      no: "保存しない",
      cancel: "キャンセル",
    });
    expect(dialogMessage.mock.calls[0][0]).toBe("閉じる前に「報告書」の変更を保存しますか?");
  });

  it("a dialog that fails to open counts as cancel (nothing is closed or discarded)", async () => {
    useStore.setState({ toasts: [] });
    dialogMessage.mockRejectedValue(new Error("no window"));
    expect(await askUnsaved("tab", "Report")).toBe("cancel");
    const toasts = useStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ kind: "error", message: "no window" });
  });
});
