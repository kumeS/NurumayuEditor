// DOM/CodeMirror side of keeping the reading position across Markdown views.
// Measures each surface into source lines and back; the line arithmetic lives
// in ../scrollAnchor.ts (unit-tested).

import { EditorView } from "@codemirror/view";
import { lineAtOffset, offsetForLine, type LineBlock } from "../scrollAnchor";

function previewBlocks(container: HTMLElement): LineBlock[] {
  const base = container.getBoundingClientRect().top - container.scrollTop;
  return Array.from(container.querySelectorAll<HTMLElement>("[data-source-line]"), (el) => {
    const rect = el.getBoundingClientRect();
    const start = Number(el.dataset.sourceLine);
    const end = Number(el.dataset.sourceEndLine ?? start);
    return { start, end: Number.isFinite(end) ? end : start, top: rect.top - base, height: rect.height };
  }).filter((b) => Number.isFinite(b.start));
}

/** Source line at the top of the preview (1 at the very top). */
export function previewTopLine(container: HTMLElement | null): number | null {
  if (!container) return null;
  if (container.scrollTop <= 0) return 1;
  return lineAtOffset(previewBlocks(container), container.scrollTop + 1) ?? 1;
}

export function scrollPreviewToLine(container: HTMLElement | null, line: number): void {
  if (!container) return;
  const offset = line <= 1 ? 0 : offsetForLine(previewBlocks(container), line) ?? 0;
  container.scrollTop = Math.max(0, offset);
}

/** Source line at the top of the editor's viewport (fractional inside a wrapped line). */
export function editorTopLine(view: EditorView | null): number | null {
  if (!view) return null;
  const scroller = view.scrollDOM;
  if (scroller.scrollTop <= 0) return 1;
  const height = scroller.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  const line = view.state.doc.lineAt(block.from).number;
  const into = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
  return line + into;
}

export function scrollEditorToLine(view: EditorView | null, line: number): void {
  if (!view) return;
  const doc = view.state.doc;
  const number = Math.min(doc.lines, Math.max(1, Math.floor(line)));
  const into = Math.min(1, Math.max(0, line - Math.floor(line)));
  const pos = doc.line(number).from;
  // Bring the line into view first (so CodeMirror measures real heights around
  // it), then place the exact point inside it — a long wrapped line, or the
  // very end of one line, which is where the next one starts.
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 0 }) });
  view.requestMeasure({
    read: (v) => {
      const block = v.lineBlockAt(pos);
      const scroller = v.scrollDOM;
      const docOffset = v.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
      return docOffset + block.top + into * block.height;
    },
    write: (target, v) => {
      v.scrollDOM.scrollTop = Math.max(0, Math.round(target));
    },
  });
}
