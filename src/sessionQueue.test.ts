import { beforeEach, describe, expect, it, vi } from "vitest";

// save_session / clear_session are async Rust commands (BUG-006 step 1), so
// Tauri no longer runs them in send order. api.ts chains every session call
// so a clear sent after an autosave is only sent once that autosave settled.
type Pending = { cmd: string; resolve: (v?: unknown) => void; reject: (e: unknown) => void };
const pending: Pending[] = [];
const invoke = vi.fn(
  (cmd: string) =>
    new Promise((resolve, reject) => {
      pending.push({ cmd, resolve, reject });
    })
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
  Channel: class {},
}));

import { api } from "./api";

const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = () => invoke.mock.calls.map((c) => c[0]);

describe("session commands are sent in order (api.ts session queue)", () => {
  beforeEach(() => {
    invoke.mockClear();
    pending.length = 0;
  });

  it("a clear issued behind a pending autosave is sent only after the save resolves", async () => {
    const save = api.saveSession({ tabs: [], activeTabId: null } as never);
    const clear = api.clearSession();
    await flush();
    expect(sent()).toEqual(["save_session"]); // the clear waits

    pending[0].resolve();
    await save;
    await flush();
    expect(sent()).toEqual(["save_session", "clear_session"]);

    pending[1].resolve();
    await expect(clear).resolves.toBeUndefined();
  });

  it("a failed save does not stall the queue, and the caller still sees its error", async () => {
    const save = api.saveSession({ tabs: [], activeTabId: null } as never);
    const clear = api.clearSession();
    await flush();
    pending[0].reject(new Error("disk full"));
    await expect(save).rejects.toThrow("disk full");
    await flush();
    expect(sent()).toEqual(["save_session", "clear_session"]);
    pending[1].resolve();
    await expect(clear).resolves.toBeUndefined();
  });
});

// get_settings / save_settings / set_api_key / delete_api_key are async Rust
// commands (settings-io-async), so they complete in SETTINGS_IO lock order,
// not send order. saveSettings sends the WHOLE object, so api.ts chains every
// settings write: a second save is only sent once the first one settled.
describe("settings writes are sent in order (api.ts settings queue)", () => {
  beforeEach(() => {
    invoke.mockClear();
    pending.length = 0;
  });

  const settings = (sidebarWidth: number) => ({ sidebarWidth }) as never;

  it("a second saveSettings is sent only after the first one resolves", async () => {
    const first = api.saveSettings(settings(200));
    const second = api.saveSettings(settings(300));
    await flush();
    expect(sent()).toEqual(["save_settings"]); // the second waits

    pending[0].resolve();
    await first;
    await flush();
    expect(sent()).toEqual(["save_settings", "save_settings"]);

    pending[1].resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it("setApiKey and deleteApiKey join the same queue as saveSettings", async () => {
    const save = api.saveSettings(settings(200));
    const setKey = api.setApiKey("sk-test");
    const del = api.deleteApiKey();
    await flush();
    expect(sent()).toEqual(["save_settings"]);

    pending[0].resolve();
    await save;
    await flush();
    expect(sent()).toEqual(["save_settings", "set_api_key"]);

    pending[1].resolve();
    await setKey;
    await flush();
    expect(sent()).toEqual(["save_settings", "set_api_key", "delete_api_key"]);
    pending[2].resolve();
    await expect(del).resolves.toBeUndefined();
  });

  it("a failed save does not stall the queue, and the caller still sees its error", async () => {
    const first = api.saveSettings(settings(200));
    const second = api.saveSettings(settings(300));
    await flush();
    pending[0].reject(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    await flush();
    expect(sent()).toEqual(["save_settings", "save_settings"]);
    pending[1].resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it("the settings queue is separate from the session queue", async () => {
    const save = api.saveSession({ tabs: [], activeTabId: null } as never);
    const settingsSave = api.saveSettings(settings(200));
    await flush();
    // A pending session save does not hold back a settings write.
    expect([...sent()].sort()).toEqual(["save_session", "save_settings"]);
    pending[0].resolve();
    pending[1].resolve();
    await save;
    await settingsSave;
  });
});
