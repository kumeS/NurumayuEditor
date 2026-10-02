// Where an image reference in a document actually lives.
//
// A Markdown file written next to its figures says `![図 1](figures/fig1.png)`.
// Handing that string straight to <img> makes the webview resolve it against
// the APP's origin (tauri://localhost/figures/…), which never exists — so every
// relative figure rendered as "Image could not be displayed". This module
// turns such a reference into an absolute filesystem path relative to the
// document's own folder; the bytes are then read by Rust (`read_local_image`:
// regular non-symlink file, extension allowlist, size cap and a content sniff
// that must match an allowlisted image format), never by the webview.
//
// Pure and framework-free so it runs in the node unit suite.

export type ImageSource =
  /** Usable as-is: http(s) or an inline data: URL. */
  | { kind: "direct"; src: string }
  /** A file on disk, to be read through the Rust command. */
  | { kind: "local"; path: string }
  /** A relative path, but the document has no folder yet (unsaved/imported). */
  | { kind: "needs-document-folder" }
  /** Nothing usable (empty, or a scheme the preview refuses). */
  | { kind: "missing" };

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A literal `%` in a real file name (e.g. `100%.png`) isn't an escape.
    return value;
  }
}

function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** Collapse `.` and `..` segments; `..` never climbs above the root. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Classify an image `src` and, for local files, resolve it to an absolute path.
 * `docPath` is the open document's file path (null for unsaved/imported docs).
 *
 * Sync contract: the `"local"` result has a Rust twin, `local_image_path` in
 * src-tauri/src/imageio.rs (used by the headless CLI export), with the same
 * rules in the same order — http(s) / data:image are not local; `file://`
 * (case-insensitive, optional `localhost`); any other scheme is refused; drop
 * `?query`/`#fragment`, then percent-decode (malformed → verbatim); absolute
 * paths as-is; relative paths against the document's folder; collapse
 * `.`/`..` never above `/`. Change both. src/localImages.contract.test.ts runs
 * this function over the Rust test table and checks every case in
 * localImages.test.ts is in that table.
 */
export function resolveImageSource(src: string | undefined, docPath: string | null): ImageSource {
  const value = (src ?? "").trim();
  if (!value) return { kind: "missing" };
  if (/^(?:https?:|data:image\/)/i.test(value)) return { kind: "direct", src: value };

  if (/^file:\/\//i.test(value)) {
    const path = value.replace(/^file:\/\/(?:localhost)?/i, "").split(/[?#]/)[0];
    return { kind: "local", path: normalize(decode(path)) };
  }
  // Any other explicit scheme (javascript:, data:text/html, …) is not an image.
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return { kind: "missing" };

  const path = decode(value.split(/[?#]/)[0]);
  if (path.startsWith("/")) return { kind: "local", path: normalize(path) };
  if (!docPath) return { kind: "needs-document-folder" };
  return { kind: "local", path: normalize(`${dirname(docPath)}/${path}`) };
}
