import { describe, expect, it } from "vitest";
import { resolveImageSource } from "./localImages";

// Sync contract (testing.md rule 3): TS `resolveImageSource` ("local" result)
// and Rust `imageio::local_image_path` resolve figure references the same way.
// The Rust case table (imageio.rs `local_image_path_mirrors_resolve_image_source`)
// is parsed from source and replayed through the TS function, and every case
// in localImages.test.ts must appear in that table — so a case added on either
// side without the other, or a rule changed on one side, fails here.

function rawFile(files: Record<string, unknown>, name: string): string {
  const src = Object.values(files)[0];
  if (typeof src !== "string") throw new Error(`could not read ${name}`);
  return src;
}

const imageioRs = rawFile(
  import.meta.glob("../src-tauri/src/imageio.rs", { eager: true, query: "?raw", import: "default" }),
  "src-tauri/src/imageio.rs"
);
const tsTests = rawFile(
  import.meta.glob("./localImages.test.ts", { eager: true, query: "?raw", import: "default" }),
  "localImages.test.ts"
);

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;

interface RustCase {
  src: string;
  withDoc: boolean;
  want: string | null;
}

/** The `cases` table of the Rust mirror test, and nothing outside it. */
function rustCases(): RustCase[] {
  const start = imageioRs.indexOf("fn local_image_path_mirrors_resolve_image_source()");
  expect(start, "Rust mirror test").toBeGreaterThan(-1);
  const end = imageioRs.indexOf("for (src, doc, want) in cases", start);
  expect(end, "Rust mirror test loop").toBeGreaterThan(start);
  const body = imageioRs.slice(start, end);
  const row = new RegExp(String.raw`\(${STR},\s*(Some\(DOC\)|None),\s*(?:None|Some\(${STR}\))\)`, "g");
  return [...body.matchAll(row)].map((m) => ({
    src: m[1],
    withDoc: m[2] !== "None",
    want: m[3] ?? null,
  }));
}

function constDoc(src: string, decl: RegExp): string | undefined {
  return src.match(decl)?.[1];
}

describe("resolveImageSource ↔ imageio.rs local_image_path", () => {
  const cases = rustCases();
  const DOC = constDoc(imageioRs, new RegExp(String.raw`const DOC: &str = ${STR};`));

  it("both suites use the same document path", () => {
    expect(DOC).toBeTruthy();
    expect(constDoc(tsTests, new RegExp(String.raw`const DOC = ${STR};`))).toBe(DOC);
  });

  it("the Rust table covers file:, http(s), data:, relative and absolute sources", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const srcs = cases.map((c) => c.src.trim());
    expect(srcs.some((s) => /^file:/i.test(s))).toBe(true);
    expect(srcs.some((s) => /^https:/i.test(s))).toBe(true);
    expect(srcs.some((s) => /^http:/i.test(s))).toBe(true);
    expect(srcs.some((s) => /^data:/i.test(s))).toBe(true);
    expect(srcs.some((s) => s.startsWith("/"))).toBe(true);
    expect(srcs.some((s) => s !== "" && !s.startsWith("/") && !/^[a-z][a-z\d+.-]*:/i.test(s))).toBe(true);
  });

  it("TS gives the Rust answer for every row of the Rust table", () => {
    for (const c of cases) {
      const got = resolveImageSource(c.src, c.withDoc ? DOC! : null);
      const label = `src=${JSON.stringify(c.src)} doc=${c.withDoc ? "DOC" : "null"}`;
      if (c.want === null) expect(got.kind, label).not.toBe("local");
      else expect(got, label).toEqual({ kind: "local", path: c.want });
    }
  });

  it("every literal case in localImages.test.ts is a row of the Rust table", () => {
    const tsRows = [
      ...tsTests.matchAll(new RegExp(String.raw`resolveImageSource\(${STR},\s*(DOC|null)\)`, "g")),
    ].map((m) => `${m[1]}|${m[2] === "DOC"}`);
    // The inline data: URL is passed through a local `data` constant.
    const dataUrl = tsTests.match(new RegExp(String.raw`const data = ${STR};`))?.[1];
    expect(dataUrl, "localImages.test.ts data constant").toBeTruthy();
    tsRows.push(`${dataUrl}|true`);
    expect(tsRows.length).toBeGreaterThanOrEqual(18);
    const rustRows = new Set(cases.map((c) => `${c.src}|${c.withDoc}`));
    for (const r of tsRows) expect(rustRows, `missing in imageio.rs: ${r}`).toContain(r);
  });
});
