import { describe, expect, it } from "vitest";
import { APP_VERSION, BUILD_ID } from "./buildInfo";
import { translateWith } from "./i18n";

// MISS-02: the installed binary must be traceable to a commit. vite.config.ts
// (and vitest.config.ts, so these tests see the same value) define
// __BUILD_ID__; src/buildInfo.ts exposes it with APP_VERSION, and the Help
// footer shows "Version 1.3.0 (abc1234-dirty)".

const raw = import.meta.glob(
  [
    "./components/HelpModal.tsx",
    "../src-tauri/tauri.conf.json",
    "../vite.config.ts",
    "../scripts/install-macos-app.sh",
  ],
  {
  eager: true,
  query: "?raw",
  import: "default",
  },
) as Record<string, string>;

// vite.config.ts belongs to the tsconfig.node.json project, so a static
// import would drag it into the app's `tsc` program; load it through the glob.
const { computeBuildId } = (
  import.meta.glob("../vite.config.ts", { eager: true }) as Record<
    string,
    { computeBuildId: (env: Record<string, string | undefined>, cwd?: string) => string }
  >
)["../vite.config.ts"];

const BUILD_ID_FORMAT = /^[0-9a-f]{7,}(-dirty)?$|^unknown$/;

describe("build identity", () => {
  it("the test config defines __BUILD_ID__ (not just the typeof fallback)", () => {
    expect(typeof __BUILD_ID__).toBe("string");
    expect(BUILD_ID).toBe(__BUILD_ID__);
  });

  it("BUILD_ID is a short git SHA, optionally -dirty, or 'unknown'", () => {
    expect(BUILD_ID).toMatch(BUILD_ID_FORMAT);
  });

  it("APP_VERSION is the version the Rust side ships (tauri.conf.json)", () => {
    const conf = JSON.parse(raw["../src-tauri/tauri.conf.json"]) as { version: string };
    expect(APP_VERSION).toBe(conf.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("computeBuildId (vite.config.ts)", () => {
  it("an explicit BUILD_ID env wins, verbatim (the install script exports one)", () => {
    expect(computeBuildId({ BUILD_ID: "abc1234-dirty" })).toBe("abc1234-dirty");
  });

  it("a blank BUILD_ID env counts as unset", () => {
    expect(computeBuildId({ BUILD_ID: "  " }, "/")).toBe("unknown");
  });

  it("falls back to 'unknown' outside a git checkout instead of failing the build", () => {
    expect(computeBuildId({}, "/")).toBe("unknown");
    expect(computeBuildId({}, "/nonexistent-dir-for-build-id-test")).toBe("unknown");
  });

  it("inside this checkout it yields the git format", () => {
    expect(computeBuildId({})).toMatch(BUILD_ID_FORMAT);
  });
});

describe("every build path injects the identity", () => {
  it("vite.config.ts defines __BUILD_ID__ from computeBuildId()", () => {
    expect(raw["../vite.config.ts"]).toMatch(/define:\s*\{\s*__BUILD_ID__:\s*JSON\.stringify\(computeBuildId\(\)\)/);
  });

  it("install-macos-app.sh exports BUILD_ID before `tauri build`", () => {
    const script = raw["../scripts/install-macos-app.sh"];
    const exported = script.indexOf("export BUILD_ID");
    expect(exported).toBeGreaterThan(-1);
    expect(script.indexOf("npx tauri build", exported)).toBeGreaterThan(exported);
    expect(script).toContain("git rev-parse --short HEAD");
    expect(script).toContain("git status --porcelain");
  });
});

describe("Help footer shows the build identity", () => {
  const help = raw["./components/HelpModal.tsx"];

  it("HelpModal imports buildInfo and renders both values through i18n", () => {
    expect(help).toMatch(/import\s*\{[^}]*\bAPP_VERSION\b[^}]*\bBUILD_ID\b[^}]*\}\s*from\s*"\.\.\/buildInfo"/);
    expect(help).toMatch(
      /translateWith\("Version \{version\} \(\{build\}\)",\s*uiLang,\s*\{\s*version:\s*APP_VERSION,\s*build:\s*BUILD_ID\s*\}\)/,
    );
  });

  it("reads 'Version 1.3.0 (abc1234-dirty)' / 'バージョン …'", () => {
    const vars = { version: "1.3.0", build: "abc1234-dirty" };
    expect(translateWith("Version {version} ({build})", "en", vars)).toBe("Version 1.3.0 (abc1234-dirty)");
    expect(translateWith("Version {version} ({build})", "ja", vars)).toBe("バージョン 1.3.0 (abc1234-dirty)");
  });
});
