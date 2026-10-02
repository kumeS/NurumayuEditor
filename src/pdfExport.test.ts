import { describe, expect, it } from "vitest";
import { HELP_I18N } from "./components/HelpModal";

// Guards for the PDF export contract (BUG-003): the TS/Rust report mirror, and
// the user-facing copy that used to promise an OS print dialog that never
// opened. Sources are read raw so the assertions track the shipped files;
// Help copy is read as rendered from HELP_I18N.

function rawFile(files: Record<string, unknown>, name: string): string {
  const src = Object.values(files)[0];
  if (typeof src !== "string") throw new Error(`could not read ${name}`);
  return src;
}

const pdfRs = rawFile(
  import.meta.glob("../src-tauri/src/pdf.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/pdf.rs"
);
const typesTs = rawFile(
  import.meta.glob("./types.ts", { eager: true, query: "?raw", import: "default" }),
  "types.ts"
);
const readme = rawFile(
  import.meta.glob("../README.md", { eager: true, query: "?raw", import: "default" }),
  "README.md"
);

/** Phrases (all five Help languages) that promise a print dialog for PDF. */
const PRINT_DIALOG_PROMISE =
  /Save as PDF|print dialog|印刷ダイアログ|打印对话框|diálogo de impresión|boîte de dialogue d'impression/i;

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("PdfReport — the TS type mirrors the Rust struct", () => {
  it("has exactly the Rust fields, camelCased, in the same order", () => {
    const rustBlock = pdfRs.match(/pub struct PdfReport \{([^}]*)\}/)?.[1];
    const tsBlock = typesTs.match(/export interface PdfReport \{([^}]*)\}/)?.[1];
    expect(rustBlock, "pdf.rs PdfReport struct").toBeTruthy();
    expect(tsBlock, "types.ts PdfReport interface").toBeTruthy();
    const rustFields = [...rustBlock!.matchAll(/pub (\w+):/g)].map((m) => snakeToCamel(m[1]));
    const tsFields = [...tsBlock!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(rustFields.length).toBeGreaterThan(0);
    expect(tsFields).toEqual(rustFields);
    // serde must actually camelCase the wire names, or the mirror is a lie.
    const attrs = pdfRs.slice(0, pdfRs.indexOf("pub struct PdfReport"));
    expect(attrs.slice(attrs.lastIndexOf("#[derive")), "serde rename on PdfReport").toMatch(
      /#\[serde\(rename_all = "camelCase"\)\]/
    );
  });
});

describe("PDF copy never promises a print dialog", () => {
  it("every Help language's 'Save & export' section describes the save-dialog export", () => {
    // Rendered bodies from HELP_I18N (not raw source): the 日本語 bundle builds
    // its step bodies as template literals interpolating JA dictionary labels,
    // so this also catches a print-dialog phrase arriving via the dictionary.
    const bodies = Object.values(HELP_I18N).flatMap((b) =>
      b.steps.filter((s) => /^6\. /.test(s.title)).map((s) => s.body)
    );
    expect(bodies).toHaveLength(5); // en, ja, zh, es, fr
    for (const body of bodies) {
      expect(body).toMatch(/\.pdf/);
      expect(body).not.toMatch(PRINT_DIALOG_PROMISE);
    }
  });

  it("no README line about PDF mentions a print dialog, and the PDF limits bullet labels embedding as planned", () => {
    const pdfLines = readme.split("\n").filter((l) => /pdf/i.test(l));
    expect(pdfLines.length).toBeGreaterThan(0);
    for (const line of pdfLines) expect(line).not.toMatch(PRINT_DIALOG_PROMISE);
    const bullet = readme.match(/^- PDF export[^\n]*(?:\n {2}[^\n]*)*/m)?.[0];
    expect(bullet, "README '- PDF export …' limitations bullet").toBeTruthy();
    expect(bullet).toMatch(/placeholder/);
    expect(bullet).toMatch(/planned/);
    expect(bullet).not.toMatch(/print dialog/i);
  });

  it("the PDF limits bullet names every case pdf.rs counts inline markup in (markup_is_formatting)", () => {
    const bullet = (readme.match(/^- PDF export[^\n]*(?:\n {2}[^\n]*)*/m)?.[0] ?? "").replace(/\s+/g, " ");
    expect(bullet, "README '- PDF export …' limitations bullet").toBeTruthy();
    // pdf.rs: mode == markdown || mode == slide || markdown_source.is_some().
    const rust = Object.values(
      import.meta.glob("../src-tauri/src/pdf.rs", { eager: true, query: "?raw", import: "default" })
    )[0] as string;
    const gate = rust.slice(rust.indexOf("fn markup_is_formatting"), rust.indexOf("fn lossy_report"));
    expect(gate).toContain("DOC_MODE_MARKDOWN");
    expect(gate).toContain("DOC_MODE_SLIDE");
    expect(gate).toContain("markdown_source.is_some()");
    expect(bullet).toMatch(/Markdown or Slide mode/);
    expect(bullet).toMatch(/Markdown-backed/);
    expect(bullet).toMatch(/inline markup[^.]*counted|counted[^.]*inline markup|each is counted/);
    // The plain-Editor half of the claim is guarded on the Rust side.
    expect(rust).toContain("fn plain_editor_document_markers_are_content_not_formatting()");
    expect(bullet).toMatch(/plain Editor document that is not Markdown-backed[^.]*uncounted/);
  });
});
