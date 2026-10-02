import { defineConfig } from "vitest/config";
import { computeBuildId } from "./vite.config";

// Unit-test config for the frontend's pure logic (slide grouping/derivation,
// store helpers, diff). The Tauri/React UI itself is not unit-tested here — these
// tests cover the framework-free functions that back the editor's behaviour, so
// they run fast in a plain Node environment with no DOM.
export default defineConfig({
  // vitest reads only this file, not vite.config.ts: mirror the build-time
  // define so src/buildInfo.ts sees the real value under test.
  define: { __BUILD_ID__: JSON.stringify(computeBuildId()) },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Let contract tests read src/index.css as raw text (`?raw`); by default
    // vitest replaces CSS imports with empty modules.
    css: { include: [/index\.css/] },
  },
});
