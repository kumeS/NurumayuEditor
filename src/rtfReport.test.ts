import { describe, expect, it } from "vitest";

// Contract guard for the RTF export report (rust.md rule 4 / testing.md rule
// 3): the TS `RtfReport` mirrors Rust `fileio::RtfReport`, and the IPC wrapper
// types the `export_document` response with it. Sources are read raw so the
// assertions track the shipped files.

function rawFile(files: Record<string, unknown>, name: string): string {
  const src = Object.values(files)[0];
  if (typeof src !== "string") throw new Error(`could not read ${name}`);
  return src;
}

const fileioRs = rawFile(
  import.meta.glob("../src-tauri/src/fileio.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/fileio.rs"
);
const commandsRs = rawFile(
  import.meta.glob("../src-tauri/src/commands.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/commands.rs"
);
const typesTs = rawFile(import.meta.glob("./types.ts", { eager: true, query: "?raw", import: "default" }), "types.ts");
const apiTs = rawFile(import.meta.glob("./api.ts", { eager: true, query: "?raw", import: "default" }), "api.ts");

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("RtfReport — the TS type mirrors the Rust struct", () => {
  it("has exactly the Rust fields, camelCased, in the same order", () => {
    const rustBlock = fileioRs.match(/pub struct RtfReport \{([^}]*)\}/)?.[1];
    const tsBlock = typesTs.match(/export interface RtfReport \{([^}]*)\}/)?.[1];
    expect(rustBlock, "fileio.rs RtfReport struct").toBeTruthy();
    expect(tsBlock, "types.ts RtfReport interface").toBeTruthy();
    const rustFields = [...rustBlock!.matchAll(/pub (\w+):/g)].map((m) => snakeToCamel(m[1]));
    const tsFields = [...tsBlock!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(rustFields).toContain("warnings");
    expect(tsFields).toEqual(rustFields);
    // serde must actually camelCase the wire names, or the mirror is a lie.
    const attrs = fileioRs.slice(0, fileioRs.indexOf("pub struct RtfReport"));
    expect(attrs.slice(attrs.lastIndexOf("#[derive")), "serde rename on RtfReport").toMatch(
      /#\[serde\(rename_all = "camelCase"\)\]/
    );
  });

  it("export_document returns Option<RtfReport> and api.exportDocument is typed RtfReport | null", () => {
    const sig = commandsRs.match(/pub async fn export_document\(([\s\S]*?)\{/)?.[1];
    expect(sig, "commands.rs export_document").toBeTruthy();
    expect(sig).toMatch(/->\s*AppResult<Option<fileio::RtfReport>>\s*$/);
    const wrapper = apiTs.match(/exportDocument:[\s\S]*?invoke<([^>]*)>\("export_document"/)?.[1];
    expect(wrapper, "api.ts exportDocument").toBe("RtfReport | null");
  });
});

const mcpRs = rawFile(
  import.meta.glob("../src-tauri/src/mcp.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/mcp.rs"
);
const cliRs = rawFile(
  import.meta.glob("../src-tauri/src/cli.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/cli.rs"
);

// CLI/MCP export: the mcp.rs `call_export` doc and docs/ai/06 state one known
// limit (no document-relative figures), guarded below so the docs are
// updated when it is lifted. The former RTF limit (warnings dropped) has been
// lifted; its test now guards against that regression.
describe("documented CLI/MCP export limits stay true", () => {
  it("MCP export resolves no document-relative figures (cli::export, no source path)", () => {
    const body = mcpRs.match(/fn call_export\(args: &Value\)[\s\S]*?\n\}/)?.[0];
    expect(body, "mcp.rs call_export").toBeTruthy();
    expect(body).toMatch(/crate::cli::export\(&doc, &target\)/);
    expect(body).not.toMatch(/export_from/);
  });

  // Limit lifted: CLI/MCP RTF now returns the RtfReport warnings. The guard
  // is flipped so the report-dropping route can't come back, and the docs
  // that stated the old limit must not reappear.
  it("CLI RTF goes through export_with_report, so its warnings reach the caller", () => {
    const fn = cliRs.match(/pub\(crate\) fn export_from\([\s\S]*?\n\}/)?.[0];
    expect(fn, "cli.rs export_from").toBeTruthy();
    expect(fn).toMatch(/_ => fileio::export_with_report\(doc, output, &ext\)/);
    expect(fn).not.toMatch(/export_to_path/);
    const callExportDoc = mcpRs.slice(0, mcpRs.indexOf("fn call_export(args: &Value)"));
    expect(callExportDoc.slice(callExportDoc.lastIndexOf("/// MCP `export`"))).not.toMatch(
      /RTF warnings are empty/
    );
    const exportToPathDoc = fileioRs.slice(0, fileioRs.indexOf("pub fn export_to_path("));
    expect(exportToPathDoc.slice(exportToPathDoc.lastIndexOf("\n\n"))).not.toMatch(/DROPS the `RtfReport`/);
  });
});
