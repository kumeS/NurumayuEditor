import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error node builtin; this project ships no @types/node
import { execSync } from "node:child_process";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** This config file's directory (the app root, a git checkout) — git runs
 *  here regardless of the cwd `tauri build` / vitest were started from. */
const APP_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);

/**
 * Build identifier for `__BUILD_ID__` (MISS-02, read via src/buildInfo.ts):
 * a non-blank `env.BUILD_ID` verbatim; else the short git SHA of `cwd`, plus
 * "-dirty" when `git status --porcelain` is non-empty; else "unknown". Never
 * throws — a missing git or a non-repo directory must not fail the build.
 */
export function computeBuildId(
  env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {},
  cwd: string = APP_DIR,
): string {
  const fromEnv = env.BUILD_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const git = (args: string): string =>
      String(execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })).trim();
    const sha = git("rev-parse --short HEAD");
    if (!/^[0-9a-f]{7,}$/.test(sha)) return "unknown";
    return git("status --porcelain") ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Build identity shown in the Help footer (src/buildInfo.ts).
  define: { __BUILD_ID__: JSON.stringify(computeBuildId()) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
