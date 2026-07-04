// Shared Mermaid entry point (items 27/53 + export snapshots). The lazy loader
// and its configuration used to live inside MermaidChunk.tsx; they are hoisted
// here so the editor preview, AI diagram validation, and export rasterisation
// all share ONE mermaid instance with ONE config (securityLevel "strict" also
// disables HTML labels, which keeps the SVG safely rasterisable to canvas).
//
// Mermaid is large, so it is loaded lazily on first use — it stays out of the
// initial bundle and only loads once a diagram is actually needed (spec §4.1).

type MermaidApi = typeof import("mermaid")["default"];
let mermaidPromise: Promise<MermaidApi> | null = null;

export function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "neutral",
        securityLevel: "strict", // sanitize generated diagram markup
        fontFamily: "Georgia, serif",
      });
      return mod.default;
    });
  }
  return mermaidPromise;
}

/**
 * Validate Mermaid source without rendering it. Resolves with the parse-error
 * message when the code is invalid, or null when it parses cleanly — so AI-
 * generated diagrams can be checked (and retried) BEFORE a chunk is inserted.
 */
export async function validateMermaid(code: string): Promise<string | null> {
  try {
    const mermaid = await getMermaid();
    await mermaid.parse(code.trim());
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

let renderSeq = 0;

/**
 * Render Mermaid source to an SVG string, off-screen (mermaid.render measures
 * in a hidden container of its own — no mounted chunk needed). Returns null on
 * any failure. Used by the PDF export when a diagram chunk isn't in the DOM.
 */
export async function renderMermaidToSvg(code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const id = `mmd-offscreen-${(renderSeq += 1)}`;
  try {
    const mermaid = await getMermaid();
    const { svg } = await mermaid.render(id, trimmed);
    return svg;
  } catch {
    // Mermaid may leave a temporary measuring node behind on failure.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    return null;
  }
}

/**
 * Render Mermaid source to a PNG data URL (default 2x for crisp export). The
 * SVG is given explicit pixel dimensions (from its viewBox), loaded into an
 * <img> via a data URL, and drawn onto a canvas over an opaque background.
 * Returns null on any failure — callers fall back to their previous behaviour.
 */
export async function renderMermaidToPng(
  code: string,
  opts: { scale?: number; background?: string } = {}
): Promise<string | null> {
  const { scale = 2, background = "white" } = opts;
  const svg = await renderMermaidToSvg(code);
  if (!svg) return null;
  try {
    // Give the root <svg> explicit width/height (mermaid emits width="100%"),
    // otherwise the image has no intrinsic size to rasterise at.
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    const viewBox = (root.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    let width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : 0;
    let height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : 0;
    if (width && height) {
      root.setAttribute("width", String(width));
      root.setAttribute("height", String(height));
    }
    const serialized = new XMLSerializer().serializeToString(root);

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG could not be loaded"));
      // A data URL keeps the canvas untainted; encodeURIComponent handles
      // non-ASCII labels (CJK text in diagrams).
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
    });
    if (!width || !height) {
      width = img.naturalWidth || 800;
      height = img.naturalHeight || 600;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
