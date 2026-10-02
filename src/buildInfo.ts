// Build identity (MISS-02): which source a running binary was built from.
//
// Invariants:
// - BUILD_ID is `__BUILD_ID__`, injected at build time by vite.config.ts
//   (and by vitest.config.ts for tests): the BUILD_ID env var when set
//   (scripts/install-macos-app.sh exports one), else the short git SHA plus
//   "-dirty" when the working tree has uncommitted changes, else "unknown".
//   It is never computed at runtime — the webview has no git and no disk.
// - APP_VERSION is package.json's version; buildInfo.test.ts pins it to
//   src-tauri/tauri.conf.json's so the Help footer and the bundle agree.
// Known limit: "-dirty" says the tree differed from HEAD, not how.

import { version } from "../package.json";

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown";

export const APP_VERSION: string = version;
