// The rendered Markdown preview, editable in place.
//
// Editing never re-serializes a block from the DOM. Each editable block maps
// its rendered text to exact source offsets (previewEditing.ts); on commit only
// the characters you changed are spliced into the source, so every untouched
// byte — escapes, link titles, hard breaks, list markers — stays as written.
//
// Keys: Enter = new paragraph (in a list: new bullet); Shift+Enter = line break;
// Enter at the end of a paragraph opens an empty "draft" paragraph (Markdown
// has no empty paragraphs, so it only enters the source once you type).
// Images, math, links and inline code are atomic: click a formula to edit its
// TeX; a link opens its popover.

import {
  Children,
  createContext,
  createElement,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  memo,
} from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useT } from "../i18n";
import { documentToMarkdown } from "../markdown";
import { isImeKeyEventSince } from "../modalBehavior";
import { PREVIEW_REHYPE_PLUGINS, markdownUrlTransform, sourceLineAttrs } from "../markdownPreview";
import {
  ATOM,
  PARAGRAPH_BREAK,
  applyPlan,
  buildSegments,
  draftToMarkdown,
  blockEnd,
  planTextEdit,
  plainTextOf,
  rewriteMath,
  splitContextFor,
  textStart,
  type HNode,
} from "../previewEditing";
import { useStore } from "../store";
import MermaidChunk from "./MermaidChunk";
import ResolvedImage from "./ResolvedImage";

export type LinkRequest = { href: string; label: string; x: number; y: number };

// ---- DOM helpers (mirror previewEditing's text model exactly) ---------------

/** Plain text of an editable block as the core sees it: atoms → U+FFFC, <br> → "\n". */
function domPlainText(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue ?? "";
      else if (child instanceof HTMLElement) {
        if (child.hasAttribute("data-md-atomic")) out += ATOM;
        else if (child.tagName === "BR") out += "\n";
        else walk(child);
      } else if (child instanceof DocumentFragment) walk(child);
    }
  };
  walk(root);
  return out;
}

/** Plain-text offset of the caret inside `root`. */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return domPlainText(range.cloneContents()).length;
}

/** Whether the caret sits inside formatting (<strong>, <em>, <del>) within `root`. */
function caretInFormatting(root: HTMLElement): boolean {
  let node: Node | null = window.getSelection()?.anchorNode ?? null;
  while (node && node !== root) {
    if (node instanceof HTMLElement && ["STRONG", "EM", "DEL", "B", "I", "S"].includes(node.tagName)) return true;
    node = node.parentNode;
  }
  return false;
}

/** Replace the current selection inside `root` with `node`, caret after it. */
function insertAtCaret(root: HTMLElement, node: Node): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtStart(el: HTMLElement): void {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

const isImeEnter = (e: ReactKeyboardEvent, lastCompositionEnd: number) =>
  e.nativeEvent.isComposing || e.keyCode === 229 || Date.now() - lastCompositionEnd < 80;

// ---- Shared editing state ----------------------------------------------------

type DraftKind = "paragraph" | "heading";
/** An empty block the user is typing into; enters the source on commit. */
interface Draft {
  /** Source offset to insert at. */
  at: number;
  kind: DraftKind;
  /** "after": insert "\n\n" + md at `at`; "before": md + "\n\n"; "end": append. */
  place: "after" | "before" | "end";
}

interface PreviewEditing {
  source: string;
  editable: boolean;
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
  /** Re-render from source (restores the DOM after a refused edit). */
  reset: () => void;
}

const PreviewEditingContext = createContext<PreviewEditing | null>(null);

// Where the caret belongs after a split (a source offset); claimed by the
// first block that starts at/just after it once the new source renders.
let pendingFocus: number | null = null;

const start = (n: HNode | undefined) => n?.position?.start?.offset;

/** Commit a new source from the preview: its own undo step, never merged. */
function useCommitSource() {
  const setMarkdownSource = useStore((s) => s.setMarkdownSource);
  return (next: string) => setMarkdownSource(next, { newUndoStep: true });
}

const UNSAFE_MESSAGE: Record<string, string> = {
  "crosses-formatting": "That edit crosses formatting (bold, italics…) and can't be applied in Preview — use Edit or Split for it.",
  atom: "Images, formulas, links and code can only be deleted whole in Preview.",
  "breaks-not-allowed": "Line breaks aren't possible inside a table cell.",
};

// ---- Editable blocks -----------------------------------------------------------

function useBlockEditing(node: HNode | undefined, tag: string) {
  const ctx = useContext(PreviewEditingContext);
  const t = useT();
  const notify = useStore((s) => s.notify);
  const commitSource = useCommitSource();
  const ref = useRef<HTMLElement | null>(null);
  const focusedText = useRef<string | null>(null);
  const insertedStyled = useRef(false);
  const lastCompositionEnd = useRef(0);

  const source = ctx?.source ?? "";
  const segs = useMemo(() => (node ? buildSegments(node, source) : null), [node, source]);
  const canEdit = !!ctx?.editable && !!segs;
  const isCell = tag === "td" || tag === "th";
  const isParagraphLike = tag === "p" || /^h[1-6]$/.test(tag);

  // Claim the caret after a split that created this block.
  useLayoutEffect(() => {
    if (!canEdit || pendingFocus === null || !node || !ref.current) return;
    const from = textStart(node, source);
    if (from !== null && from >= pendingFocus && from - pendingFocus <= 8) {
      pendingFocus = null;
      placeCaretAtStart(ref.current);
    }
  });

  /** Splice the block's text change into the source. Returns the plan applied, if any. */
  const commit = (): { from: number; to: number; insert: string } | null => {
    const el = ref.current;
    if (!ctx || !canEdit || !segs || !node || !el) return null;
    const current = documentToMarkdown(useStore.getState().doc);
    // Positions belong to `ctx.source`; never apply them over a newer source.
    if (current !== ctx.source) return null;
    const oldText = plainTextOf(segs);
    const newText = domPlainText(el);
    // The DOM didn't match the model when editing began: don't guess.
    if (focusedText.current !== null && focusedText.current !== oldText) {
      notify(t("This part can't be edited in Preview — use Edit or Split."), "info");
      ctx.reset();
      return null;
    }
    const plan = planTextEdit({
      source: current,
      segs,
      oldText,
      newText,
      context: splitContextFor(node, current),
      insertedStyled: insertedStyled.current,
    });
    if (plan.kind === "none") return null;
    if (plan.kind === "unsafe") {
      notify(t(UNSAFE_MESSAGE[plan.reason]), "info");
      ctx.reset();
      return null;
    }
    const applied = applyPlan(current, plan);
    if (applied.focusAt !== null) pendingFocus = applied.focusAt;
    commitSource(applied.source);
    return plan;
  };

  const props = {
    ref: (el: HTMLElement | null) => {
      ref.current = el;
    },
    contentEditable: canEdit,
    // Edits commit to the document (setMarkdownSource, own undo step): ⌘Z here
    // is the document's undo (shortcuts.ts), after flushing this block.
    "data-doc-history": canEdit ? "true" : undefined,
    suppressContentEditableWarning: true,
    spellCheck: true,
    role: canEdit ? "textbox" : undefined,
    "aria-label": canEdit ? t("Edit rendered Markdown text") : undefined,
    onFocus: () => {
      focusedText.current = ref.current ? domPlainText(ref.current) : null;
      insertedStyled.current = false;
    },
    onInput: () => {
      if (ref.current) insertedStyled.current = caretInFormatting(ref.current);
    },
    onCompositionEnd: () => {
      lastCompositionEnd.current = Date.now();
    },
    onPaste: (e: React.ClipboardEvent<HTMLElement>) => {
      if (!canEdit || !ref.current) return;
      // Plain text only: rich HTML would arrive as unmappable <span>/<div>s.
      e.preventDefault();
      const text = e.clipboardData
        .getData("text/plain")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{2,}/g, isCell ? " " : PARAGRAPH_BREAK)
        .replace(/\n/g, isCell ? " " : "\n");
      insertAtCaret(ref.current, document.createTextNode(text));
      insertedStyled.current = caretInFormatting(ref.current);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter" || !canEdit || !ref.current || !ctx || !node) return;
      if (isImeEnter(e, lastCompositionEnd.current)) return; // confirming a kana→kanji conversion
      e.preventDefault();
      if (isCell) return; // a newline would break the table row
      const el = ref.current;
      if (e.shiftKey) {
        const atEnd = (caretOffset(el) ?? 0) >= domPlainText(el).replace(/\n+$/, "").length;
        const br = document.createElement("br");
        insertAtCaret(el, br);
        // A <br> that ends a block renders no line, so the caret (and what is
        // typed next) would sit before it. A second, placeholder <br> gives the
        // new line a height; the core drops trailing breaks on commit.
        // insertNode at the end of a text node leaves an empty text node behind.
        let next = br.nextSibling;
        while (next && next.nodeType === Node.TEXT_NODE && !next.nodeValue) {
          const after = next.nextSibling;
          next.remove();
          next = after;
        }
        if (atEnd && !next) {
          br.after(document.createElement("br"));
          const range = document.createRange();
          range.setStartAfter(br);
          range.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return;
      }
      // Trailing <br>s (a Shift+Enter placeholder) aren't content: the caret
      // on that last, empty line is still "at the end" of the block.
      const text = domPlainText(el).replace(/\n+$/, "");
      const caret = caretOffset(el) ?? text.length;
      if (isParagraphLike && caret >= text.length) {
        // End of a paragraph/heading: commit edits, then open an empty paragraph after it.
        const plan = commit();
        // The block's end, not its text's: a setext heading's "---" underline
        // (or an ATX heading's closing #s) belongs before the new paragraph.
        const endBefore = blockEnd(node) ?? 0;
        const delta = plan ? plan.insert.length - (plan.to - plan.from) : 0;
        ctx.setDraft({ at: endBefore + delta, kind: "paragraph", place: "after" });
        el.blur();
        return;
      }
      if (isParagraphLike && caret === 0 && text.length > 0) {
        // Start of a block: open an empty paragraph before it.
        const blockStart = start(node);
        if (typeof blockStart === "number") ctx.setDraft({ at: blockStart, kind: "paragraph", place: "before" });
        return;
      }
      insertAtCaret(el, document.createTextNode(PARAGRAPH_BREAK));
      commit();
    },
    onBlur: () => {
      commit();
      focusedText.current = null;
    },
  };
  return { props, canEdit, ctx };
}

/** p / h1–h6 / td / th. A draft paragraph renders next to its anchor block. */
function EditableBlock({ tag, node, children }: { tag: string; node?: HNode; children?: ReactNode }) {
  const { props, ctx } = useBlockEditing(node, tag);
  const element = createElement(tag, { ...props, ...sourceLineAttrs(node) }, children);
  const draft = ctx?.draft;
  if (!draft || !node || draft.place === "end") return element;
  if (draft.place === "after" && draft.at === blockEnd(node)) {
    return (
      <>
        {element}
        <DraftBlock draft={draft} />
      </>
    );
  }
  if (draft.place === "before" && draft.at === start(node)) {
    return (
      <>
        <DraftBlock draft={draft} />
        {element}
      </>
    );
  }
  return element;
}

/**
 * A list item. Tight items hold their text directly (no <p>), so the item's
 * inline content gets its own editable span; the checkbox and any nested list
 * stay outside it. Loose items hold <p>s, which edit themselves.
 */
function EditableListItem({ node, children }: { node?: HNode; children?: ReactNode }) {
  const loose = (node?.children ?? []).some((c) => c.type === "element" && c.tagName === "p");
  const { props } = useBlockEditing(loose ? undefined : node, "li");
  if (loose || !node) return <li {...sourceLineAttrs(node)}>{children}</li>;

  const checkbox: ReactNode[] = [];
  const inline: ReactNode[] = [];
  const nested: ReactNode[] = [];
  let inNested = false;
  for (const child of Children.toArray(children)) {
    const type = isValidElement(child) ? (child as ReactElement).type : null;
    if (type === "ul" || type === "ol") inNested = true;
    if (inNested) nested.push(child);
    else if (type === "input") checkbox.push(child);
    else inline.push(child);
  }
  // Trim the whitespace strings that sit between the text and a nested list.
  while (inline.length && typeof inline[inline.length - 1] === "string" && !(inline[inline.length - 1] as string).trim()) {
    nested.unshift(inline.pop());
  }
  return (
    <li {...sourceLineAttrs(node)}>
      {checkbox}
      {createElement("span", { ...props, className: "md-li-text" }, inline)}
      {nested}
    </li>
  );
}

/** An empty paragraph/heading being typed; enters the source only when it has text. */
function DraftBlock({ draft }: { draft: Draft }) {
  const ctx = useContext(PreviewEditingContext);
  const t = useT();
  const commitSource = useCommitSource();
  const ref = useRef<HTMLParagraphElement>(null);
  const done = useRef(false);
  const lastCompositionEnd = useRef(0);

  useLayoutEffect(() => {
    if (ref.current) placeCaretAtStart(ref.current);
  }, []);

  const finish = (openNext: boolean) => {
    if (done.current || !ctx || !ref.current) return;
    done.current = true;
    const text = domPlainText(ref.current).replace(/ /g, " ").trim();
    if (!text) {
      ctx.setDraft(null);
      return;
    }
    const current = documentToMarkdown(useStore.getState().doc);
    if (current !== ctx.source) {
      ctx.setDraft(null);
      return;
    }
    const md = draftToMarkdown(text, draft.kind);
    let next: string;
    let insertedEnd: number;
    if (draft.place === "after") {
      next = `${current.slice(0, draft.at)}\n\n${md}${current.slice(draft.at)}`;
      insertedEnd = draft.at + 2 + md.length;
    } else if (draft.place === "before") {
      next = `${current.slice(0, draft.at)}${md}\n\n${current.slice(draft.at)}`;
      insertedEnd = draft.at + md.length;
    } else {
      const trimmed = current.replace(/\s+$/, "");
      next = `${trimmed}${trimmed ? "\n\n" : ""}${md}\n`;
      insertedEnd = next.length - 1;
    }
    ctx.setDraft(openNext ? { at: insertedEnd, kind: "paragraph", place: "after" } : null);
    commitSource(next);
  };

  return (
    <p
      ref={ref}
      contentEditable
      data-doc-history="true"
      suppressContentEditableWarning
      role="textbox"
      aria-label={draft.kind === "heading" ? t("New heading") : t("New paragraph")}
      data-placeholder={draft.kind === "heading" ? t("Type a heading…") : t("Type a new paragraph…")}
      className={`md-draft ${draft.kind === "heading" ? "md-draft-heading" : ""}`}
      onCompositionEnd={() => {
        lastCompositionEnd.current = Date.now();
      }}
      onPaste={(e) => {
        e.preventDefault();
        if (ref.current) insertAtCaret(ref.current, document.createTextNode(e.clipboardData.getData("text/plain")));
      }}
      onKeyDown={(e) => {
        // Any key that belongs to an IME composition — Esc backs out of a
        // kana→kanji conversion and must not discard the draft.
        if (isImeKeyEventSince(e.nativeEvent, lastCompositionEnd.current)) return;
        if (e.key === "Escape") {
          done.current = true;
          ctx?.setDraft(null);
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (e.shiftKey && ref.current) insertAtCaret(ref.current, document.createElement("br"));
        else finish(true);
      }}
      onBlur={() => finish(false)}
    />
  );
}

// ---- Atomic embeds ------------------------------------------------------------------

function atomProps(node: HNode | undefined) {
  const from = node?.position?.start?.offset;
  const to = node?.position?.end?.offset;
  return {
    contentEditable: false,
    "data-md-atomic": "",
    "data-md-start": typeof from === "number" ? from : undefined,
    "data-md-end": typeof to === "number" ? to : undefined,
  };
}

/** Passed as `components.img` BY REFERENCE (stable identity → no re-reads while typing). */
function MarkdownImage({ src, alt, node }: { src?: unknown; alt?: string; node?: HNode }) {
  return (
    <span {...atomProps(node)} className="markdown-embed">
      <ResolvedImage
        src={typeof src === "string" ? src : undefined}
        alt={alt}
        placeholderClassName="markdown-image-error font-sans text-sm text-ink-faint"
      />
    </span>
  );
}

function texOf(node: HNode | undefined): string {
  return (node?.children ?? []).map((c) => c.value ?? "").join("");
}

function renderTex(tex: string, display: boolean): string {
  // trust stays false (default): \href, \url, \includegraphics are disabled.
  return katex.renderToString(tex, { throwOnError: false, displayMode: display, output: "html" });
}

/** A rendered formula; click to edit its TeX (only that `$…$` span changes). */
function MathAtom({ node, display }: { node?: HNode; display: boolean }) {
  const ctx = useContext(PreviewEditingContext);
  const t = useT();
  const tex = texOf(node);
  const html = useMemo(() => renderTex(tex, display), [tex, display]);
  const anchor = useRef<HTMLSpanElement>(null);
  const [editing, setEditing] = useState(false);
  const canEdit = !!ctx?.editable && typeof start(node) === "number";

  return (
    <span
      {...atomProps(node)}
      ref={anchor}
      className={display ? "math-atom math-atom-display" : "math-atom"}
      role={canEdit ? "button" : undefined}
      tabIndex={canEdit ? 0 : undefined}
      title={canEdit ? t("Click to edit the formula") : undefined}
      onClick={() => canEdit && setEditing(true)}
      onKeyDown={(e) => {
        if (canEdit && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      <span dangerouslySetInnerHTML={{ __html: html }} />
      {editing && node && (
        <MathEditor node={node} display={display} anchor={anchor.current} onClose={() => setEditing(false)} />
      )}
    </span>
  );
}

/**
 * React events from a portal bubble through the React tree, not the DOM: without
 * this, typing, Enter, paste, focus and clicks in the formula popover would reach
 * the editable paragraph that hosts the formula (splitting it, pasting into it,
 * re-opening the popover). The popover handles its own events.
 */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const isolateFromEditableAncestor = {
  onMouseDown: stop,
  onClick: stop,
  onKeyDown: stop,
  onInput: stop,
  onPaste: stop,
  onFocus: stop,
  onBlur: stop,
  onCompositionStart: stop,
  onCompositionEnd: stop,
};

function MathEditor({
  node,
  display,
  anchor,
  onClose,
}: {
  node: HNode;
  display: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const ctx = useContext(PreviewEditingContext);
  const t = useT();
  const notify = useStore((s) => s.notify);
  const commitSource = useCommitSource();
  const [value, setValue] = useState(texOf(node));
  const lastCompositionEnd = useRef(0);
  const preview = useMemo(() => renderTex(value, display), [value, display]);
  const rect = anchor?.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect?.left ?? 100, window.innerWidth - 380));
  const top = Math.min((rect?.bottom ?? 100) + 8, window.innerHeight - 220);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = () => {
    const from = start(node);
    const to = node.position?.end?.offset;
    const current = documentToMarkdown(useStore.getState().doc);
    if (!ctx || typeof from !== "number" || typeof to !== "number" || current !== ctx.source) {
      notify(t("The document changed — reopen the formula to edit it."), "info");
      onClose();
      return;
    }
    commitSource(current.slice(0, from) + rewriteMath(current.slice(from, to), value) + current.slice(to));
    onClose();
  };

  return createPortal(
    <div
      role="dialog"
      aria-label={t("Edit formula")}
      className="fixed z-50 w-[360px] rounded-lg border border-ink-faint/30 bg-white p-3 font-sans shadow-xl"
      style={{ left, top }}
      {...isolateFromEditableAncestor}
    >
      <label className="mb-1 block text-xs font-medium text-ink-soft" htmlFor="math-editor-input">
        {t("Formula (TeX)")}
      </label>
      {display ? (
        <textarea
          id="math-editor-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply();
          }}
          rows={3}
          className="w-full rounded border border-ink-faint/40 px-2 py-1 font-mono text-sm outline-none focus:border-accent"
        />
      ) : (
        <input
          id="math-editor-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionEnd={() => {
            lastCompositionEnd.current = Date.now();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeEnter(e, lastCompositionEnd.current)) apply();
          }}
          className="w-full rounded border border-ink-faint/40 px-2 py-1 font-mono text-sm outline-none focus:border-accent"
        />
      )}
      <div
        className="mt-2 min-h-[2rem] overflow-x-auto rounded bg-accent/5 px-2 py-1 text-center"
        aria-live="polite"
        dangerouslySetInnerHTML={{ __html: preview }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1 text-xs text-ink-soft hover:bg-accent/5">
          {t("Cancel")}
        </button>
        <button type="button" onClick={apply} className="rounded bg-accent px-3 py-1 text-xs text-white">
          {t("Apply")}
        </button>
      </div>
    </div>,
    document.body
  );
}

// ---- The preview --------------------------------------------------------------------

/** Command-palette bridge: "Add paragraph/heading" in the Markdown preview. */
export const PREVIEW_ADD_EVENT = "nurumayu:preview-add";
export function requestPreviewAdd(kind: DraftKind): void {
  window.dispatchEvent(new CustomEvent(PREVIEW_ADD_EVENT, { detail: kind }));
}

export default memo(MarkdownPreview);

function MarkdownPreview({
  source,
  editable = true,
  onLink,
}: {
  source: string;
  editable?: boolean;
  onLink?: (request: LinkRequest) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!editable) return;
    const onAdd = (e: Event) => {
      const kind = (e as CustomEvent<DraftKind>).detail === "heading" ? "heading" : "paragraph";
      setDraft({ at: source.length, kind, place: "end" });
    };
    window.addEventListener(PREVIEW_ADD_EVENT, onAdd);
    return () => window.removeEventListener(PREVIEW_ADD_EVENT, onAdd);
  }, [editable, source.length]);

  const ctx = useMemo<PreviewEditing>(
    () => ({ source, editable, draft, setDraft, reset: () => setNonce((n) => n + 1) }),
    [source, editable, draft]
  );

  // Components are rebuilt per render on purpose: an edited block must remount
  // from the new source rather than let React reconcile a DOM the user changed.
  const block = (tag: string) =>
    ({ node, children }: { node?: HNode; children?: ReactNode }) => (
      <EditableBlock tag={tag} node={node}>
        {children}
      </EditableBlock>
    );

  const addBar = editable && (
    <div className="mt-10 flex flex-wrap items-center gap-1.5 font-sans text-sm text-ink-faint">
      <button
        type="button"
        onClick={() => setDraft({ at: source.length, kind: "paragraph", place: "end" })}
        className="rounded-md px-2 py-1 hover:bg-accent/5 hover:text-accent"
      >
        ＋ {t("Add paragraph")}
      </button>
      <button
        type="button"
        onClick={() => setDraft({ at: source.length, kind: "heading", place: "end" })}
        className="rounded-md px-2 py-1 hover:bg-accent/5 hover:text-accent"
      >
        ＋ {t("Add heading")}
      </button>
    </div>
  );

  if (!source.trim() && !draft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center font-sans text-sm text-ink-faint">
        {t("Start writing Markdown to see the preview.")}
        {addBar}
      </div>
    );
  }

  return (
    <PreviewEditingContext.Provider value={ctx}>
      {/* Zoom and the sideways offset are applied by the wrappers in
          MarkdownEditor, so zooming never re-renders (or remounts) the blocks. */}
      <article key={nonce} className="markdown-preview mx-auto w-full max-w-prose px-10 py-12 font-sans text-ink">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={PREVIEW_REHYPE_PLUGINS}
          urlTransform={markdownUrlTransform}
          components={{
            h1: block("h1"),
            h2: block("h2"),
            h3: block("h3"),
            h4: block("h4"),
            h5: block("h5"),
            h6: block("h6"),
            p: block("p"),
            td: block("td"),
            th: block("th"),
            li: ({ node, children }) => <EditableListItem node={node as HNode}>{children}</EditableListItem>,
            a: ({ children, href, node }) => (
              <a
                href={href}
                {...atomProps(node as HNode)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (href) onLink?.({ href, label: event.currentTarget.innerText, x: event.clientX, y: event.clientY });
                }}
              >
                {children}
              </a>
            ),
            img: MarkdownImage,
            pre: ({ children, node }) => {
              const first = (node as HNode | undefined)?.children?.find((c) => c.type === "element");
              const cls = first?.properties?.className;
              const isDisplayMath = Array.isArray(cls) && cls.map(String).includes("math-display");
              const lines = sourceLineAttrs(node as HNode | undefined);
              return isDisplayMath ? (
                <div className="math-display-block" {...lines}>{children}</div>
              ) : (
                <pre {...lines}>{children}</pre>
              );
            },
            code: ({ className, children, node, ...props }) => {
              const cls = className ?? "";
              if (cls.includes("math-inline")) return <MathAtom node={node as HNode} display={false} />;
              if (cls.includes("math-display")) return <MathAtom node={node as HNode} display />;
              if (cls === "language-mermaid") {
                return <MermaidChunk code={String(children).replace(/\n$/, "")} />;
              }
              const inline = !(node as HNode | undefined)?.properties?.className && !String(children).includes("\n");
              return inline ? (
                <code className={className} {...props} {...atomProps(node as HNode)}>
                  {children}
                </code>
              ) : (
                <code className={className} {...props} contentEditable={false}>
                  {children}
                </code>
              );
            },
          }}
        >
          {source}
        </ReactMarkdown>
        {draft?.place === "end" && <DraftBlock draft={draft} />}
        {addBar}
      </article>
    </PreviewEditingContext.Provider>
  );
}
