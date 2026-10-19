import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TextChange } from "../findReplace";
import { documentToMarkdown, eolOf, normalizeEol, restoreEol } from "../markdown";
import { findMarkdownLinkAt } from "../markdownPreview";
import { markdownSourceHighlightStyle, markdownSourceThemeSpec } from "../markdownSourceTheme";
import { useT } from "../i18n";
import { isImeKeyEventSince } from "../modalBehavior";
import { PREVIEW_SCOPE_NOTE, helperFor, type MarkdownSurface } from "../markdownSurfaceHelp";
import { previewBackgroundOf } from "../previewBackground";
import { createHistoryReset, onlyStoreSync, syncFromStore } from "../sourceHistory";
import { useStore } from "../store";
import MarkdownPreview, { type LinkRequest } from "./MarkdownPreview";
import PreviewBackgroundPicker from "./PreviewBackgroundPicker";
import { editorTopLine, previewTopLine, scrollEditorToLine, scrollPreviewToLine } from "./scrollSync";
import { usePreviewViewport } from "./usePreviewViewport";


// ----- Find bridge (BUG-010) -----------------------------------------------
// The docked FindBar lives outside this component; it reaches the mounted
// CodeMirror source view (and the Preview → Split switch) through this
// module-level bridge. Only one Markdown editor is mounted at a time.
let mountedSourceView: EditorView | null = null;
let showSourceRequest: (() => void) | null = null;

/** CodeMirror user events of find-bar replacements. The update listener gives
 *  each its own store undo step (setMarkdownSource … newUndoStep). */
export const FIND_REPLACE_EVENT = "input.replace";

export const markdownSourceBridge = {
  /** The mounted source view, or null (Preview surface / not Markdown mode). */
  view(): EditorView | null {
    return mountedSourceView;
  },
  /** Make the source visible so matches can be shown: Preview → Split. */
  show(): void {
    showSourceRequest?.();
  },
  /** Select [from, to) and scroll it to the middle; `focus` moves focus into
   *  the source. False when no source view is mounted. */
  select(from: number, to: number, focus = false): boolean {
    const view = mountedSourceView;
    if (!view) return false;
    const len = view.state.doc.length;
    const a = Math.min(Math.max(0, from), len);
    const b = Math.min(Math.max(a, to), len);
    view.dispatch({
      selection: { anchor: a, head: b },
      effects: EditorView.scrollIntoView(a, { y: "center" }),
    });
    if (focus) view.focus();
    return true;
  },
  /** Apply find-bar replacements as ONE isolated CodeMirror history event
   *  (so ⌘Z in the source undoes exactly the replace) and one store undo
   *  step. False when no source view is mounted. */
  replace(changes: readonly TextChange[], all: boolean): boolean {
    const view = mountedSourceView;
    if (!view) return false;
    if (changes.length === 0) return true;
    view.dispatch({
      changes: [...changes],
      annotations: isolateHistory.of("full"),
      userEvent: all ? `${FIND_REPLACE_EVENT}.all` : FIND_REPLACE_EVENT,
    });
    return true;
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CodeMirrorEditor({
  source,
  onLink,
  viewRef: exposed,
  onScroll,
}: {
  source: string;
  onLink: (request: LinkRequest) => void;
  viewRef?: MutableRefObject<EditorView | null>;
  onScroll?: () => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const setMarkdownSource = useStore((state) => state.setMarkdownSource);
  // md-slides-export-3: CodeMirror stores LF only. The editor gets LF text and
  // every write-back is converted to the source's line ending, so opening a
  // CRLF file is not an edit (no dirty, no undo step) and saving keeps CRLF.
  // Sticky: a source with no line break yet keeps the last known ending.
  const eolRef = useRef(eolOf(source));
  if (/\r\n|\n/.test(source)) eolRef.current = eolOf(source);
  // Empties CodeMirror's history inside the store → view sync below
  // (sourceHistory.ts: a store undo must never be re-applied by ⌘Z here).
  const historyReset = useMemo(createHistoryReset, []);

  const extensions = useMemo(
    () => [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      historyReset.extension,
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      bracketMatching(),
      markdown(),
      syntaxHighlighting(markdownSourceHighlightStyle),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || onlyStoreSync(update.transactions)) return;
        // A find-bar replace is its own store undo step, never merged into
        // the typing session before it (BUG-010).
        const replaced = update.transactions.some((tr) => tr.isUserEvent(FIND_REPLACE_EVENT));
        setMarkdownSource(
          restoreEol(update.state.doc.toString(), eolRef.current),
          replaced ? { newUndoStep: true } : undefined
        );
      }),
      EditorView.domEventHandlers({
        click: (event, view) => {
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (position === null) return false;
          const match = findMarkdownLinkAt(view.state.doc.toString(), position);
          if (!match) return false;
          event.preventDefault();
          onLink({ href: match.href, label: match.label, x: event.clientX, y: event.clientY });
          return true;
        },
      }),
      // Layout, active line and selection styling (tokens only; see module doc).
      EditorView.theme(markdownSourceThemeSpec),
    ],
    [onLink, setMarkdownSource, historyReset]
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: normalizeEol(source), extensions }),
    });
    viewRef.current = view;
    mountedSourceView = view;
    if (exposed) exposed.current = view;
    const scroller = view.scrollDOM;
    const handleScroll = () => onScroll?.();
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      view.destroy();
      viewRef.current = null;
      if (mountedSourceView === view) mountedSourceView = null;
      if (exposed) exposed.current = null;
    };
  }, [extensions]);

  // Store → view (store undo/redo, preview edit, load): one unrecorded
  // minimal change that also empties CodeMirror's history, so ⌘Z here can not
  // re-apply what the store undid. No-op when the LF texts agree (CodeMirror's
  // own edits keep their history; CRLF sources). See sourceHistory.ts.
  // A LAYOUT effect (C14, review follow-up, QA 20261003): React runs every
  // layout effect of a commit before any passive one, so FindBar's passive
  // [loc] effect — FindBar renders first, in App.tsx — already reads the
  // synced view and its mapped selection ("k / N", not "N matches"). It also
  // means a Preview edit committed on the blur of a find-bar press is in the
  // view before that click runs the replace (C11). Effect kinds are pinned in
  // sourceHistoryWiring.test.ts; React's ordering in the real webview is NOT
  // guarded by this suite (no DOM) — manual QA in the installed app. On first
  // mount the view does not exist yet (created by the passive effect above,
  // from `source`).
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) syncFromStore(view, historyReset, source);
  }, [source]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" aria-label={t("Markdown source editor")} />;
}

function LinkPopover({ request, onClose }: { request: LinkRequest; onClose: () => void }) {
  const notify = useStore((state) => state.notify);
  const t = useT();
  const openable = /^(?:https?:|mailto:)/i.test(request.href);
  const left = Math.max(12, Math.min(request.x, window.innerWidth - 340));
  const top = Math.max(12, Math.min(request.y + 10, window.innerHeight - 150));
  // Esc closes it like the other local Esc handlers (QA 20261003 follow-up):
  // never for an IME key — including WebKit's Esc that cancels a conversion
  // AFTER compositionend with isComposing false (isImeKeyEventSince, 80 ms
  // window; compositionend is recorded on document in the capture phase, as
  // usePanelEscape does, in a ref so a re-subscribed effect keeps it) — claims
  // the key (preventDefault) so the docked-panel Esc (window listener,
  // panelEscape.ts) does not act on it too, and listens on document, which
  // runs before that window listener. Wiring pinned in
  // sourceHistoryWiring.test.ts; real WebKit key order by manual QA.
  const lastCompositionEnd = useRef(0);
  useEffect(() => {
    const onCompositionEnd = () => {
      lastCompositionEnd.current = Date.now();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKeyEventSince(event, lastCompositionEnd.current, Date.now()) || event.defaultPrevented)
        return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("compositionend", onCompositionEnd, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("compositionend", onCompositionEnd, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);
  return (
    <div
      className="fixed z-50 w-80 rounded-md border border-ink-faint/30 bg-white p-3 font-sans shadow-xl"
      style={{ left, top }}
      role="dialog"
      aria-label={t("Markdown link")}
    >
      <div className="truncate text-sm font-semibold text-ink">{request.label || t("Link")}</div>
      <div className="mt-1 break-all text-xs text-ink-faint">{request.href}</div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-ink-faint/30 px-3 py-1.5 text-xs text-ink-soft hover:bg-accent/5">{t("Close")}</button>
        <button
          type="button"
          disabled={!openable}
          onClick={() => {
            void openUrl(request.href).catch((error) => notify(message(error), "error"));
            onClose();
          }}
          className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("Open link")}
        </button>
      </div>
    </div>
  );
}

export default function MarkdownEditor() {
  const source = useStore((state) => documentToMarkdown(state.doc));
  const t = useT();
  // Preview-first: reading the rendered document is the common case; the
  // Edit/Split switch is one click away.
  const [surface, setSurface] = useState<MarkdownSurface>("preview");
  const [link, setLink] = useState<LinkRequest | null>(null);
  const zoom = useStore((state) => state.markdownZoom);
  const setMarkdownZoom = useStore((state) => state.setMarkdownZoom);
  const offsetX = useStore((state) => state.markdownOffsetX);
  const setMarkdownOffsetX = useStore((state) => state.setMarkdownOffsetX);
  const previewBg = useStore((state) => previewBackgroundOf(state.settings));

  const showLink = useCallback((request: LinkRequest) => setLink(request), []);

  // Keep the reading position across Preview / Split / Edit: capture the source
  // line at the top of the surface being read, switch, then scroll the new
  // surface(s) to that line. In Split, "being read" = the pane scrolled last.
  const editorView = useRef<EditorView | null>(null);
  const previewScroller = useRef<HTMLDivElement>(null);
  const lastScrolled = useRef<"editor" | "preview">("preview");
  const pendingLine = useRef<number | null>(null);
  usePreviewViewport(previewScroller, surface !== "edit");
  const markEditorScrolled = useCallback(() => {
    lastScrolled.current = "editor";
  }, []);

  const switchSurface = (next: MarkdownSurface) => {
    if (next === surface) return;
    const fromPreview = surface === "preview" || (surface === "split" && lastScrolled.current === "preview");
    pendingLine.current = fromPreview ? previewTopLine(previewScroller.current) : editorTopLine(editorView.current);
    setSurface(next);
  };

  // BUG-010: opening Find from the Preview shows the source beside it.
  useEffect(() => {
    const request = () => {
      if (surface === "preview") switchSurface("split");
    };
    showSourceRequest = request;
    return () => {
      if (showSourceRequest === request) showSourceRequest = null;
    };
  });

  useEffect(() => {
    const line = pendingLine.current;
    pendingLine.current = null;
    if (line === null) return;
    const apply = () => {
      if (surface !== "preview") scrollEditorToLine(editorView.current, line);
      if (surface !== "edit") scrollPreviewToLine(previewScroller.current, line);
    };
    const frame = requestAnimationFrame(apply);
    // Images and formulas can finish laying out after the first frame and push
    // the text down; re-anchor a couple of times unless the user takes over.
    const timers = [250, 700].map((ms) => window.setTimeout(apply, ms));
    const cancel = () => timers.forEach((id) => window.clearTimeout(id));
    const events = ["wheel", "keydown", "pointerdown", "touchstart"] as const;
    events.forEach((type) => window.addEventListener(type, cancel, { once: true, passive: true }));
    return () => {
      cancelAnimationFrame(frame);
      cancel();
      events.forEach((type) => window.removeEventListener(type, cancel));
    };
  }, [surface]);

  // ⌘/Ctrl +, −, 0 while the preview is on screen — the shortcuts people
  // already expect for "make this bigger", scoped to this view so they never
  // fight the editor. Registered here (not in useShortcuts) because they only
  // mean anything while a preview is visible.
  useEffect(() => {
    if (surface === "edit") return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const step = 0.1;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setMarkdownZoom(useStore.getState().markdownZoom + step);
      } else if (event.key === "-") {
        event.preventDefault();
        setMarkdownZoom(useStore.getState().markdownZoom - step);
      } else if (event.key === "0") {
        event.preventDefault();
        setMarkdownZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surface, setMarkdownZoom]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-ink-faint/30 px-3 font-sans">
        <div className="text-xs text-ink-faint">{t(helperFor(surface))}</div>
        <div className="flex items-center gap-2">
          {surface !== "edit" && (
            <div
              className="flex items-center overflow-hidden rounded-md border border-ink-faint/30 text-xs shadow-sm"
              aria-label={t("Preview zoom")}
            >
              <button
                type="button"
                onClick={() => setMarkdownZoom(zoom - 0.1)}
                disabled={zoom <= 0.6}
                title={`${t("Zoom out")} (⌘−)\n${t(PREVIEW_SCOPE_NOTE)}`}
                aria-label={t("Zoom out")}
                className="px-2 py-1.5 text-ink-soft hover:bg-accent/5 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setMarkdownZoom(1)}
                title={`${t("Reset zoom to 100%")} (⌘0)\n${t("⌘ + scroll or pinch to zoom · swipe sideways, Shift + scroll or Option + drag to move left/right")}\n${t(PREVIEW_SCOPE_NOTE)}`}
                className="min-w-[3.5rem] border-x border-ink-faint/30 px-2 py-1.5 tabular-nums text-ink-soft hover:bg-accent/5"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setMarkdownZoom(zoom + 0.1)}
                disabled={zoom >= 2.5}
                title={`${t("Zoom in")} (⌘+)\n${t(PREVIEW_SCOPE_NOTE)}`}
                aria-label={t("Zoom in")}
                className="px-2 py-1.5 text-ink-soft hover:bg-accent/5 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                ＋
              </button>
            </div>
          )}
          {surface !== "edit" && offsetX !== 0 && (
            <button
              type="button"
              onClick={() => setMarkdownOffsetX(0)}
              title={t("Move the preview back to the centre")}
              className="rounded-md border border-ink-faint/30 px-2 py-1.5 text-xs text-ink-soft shadow-sm hover:bg-accent/5"
            >
              {t("Re-center")}
            </button>
          )}
          {surface !== "edit" && <PreviewBackgroundPicker />}
        <div className="flex overflow-hidden rounded-md border border-ink-faint/30 text-xs shadow-sm" aria-label={t("Markdown layout")}>
          {(["edit", "split", "preview"] as const).map((item) => (
            <button
              key={item}
              onClick={() => switchSurface(item)}
              className={`px-3 py-1.5 capitalize ${surface === item ? "bg-accent text-white" : "bg-white text-ink-soft hover:bg-accent/5"}`}
            >
              {item === "edit" ? t("Edit") : item === "split" ? t("Split") : t("Preview")}
            </button>
          ))}
        </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={`grid min-h-0 flex-1 ${surface === "split" ? "grid-cols-2" : "grid-cols-1"}`}>
            {surface !== "preview" && (
              <div className={`min-h-0 overflow-hidden ${surface === "split" ? "border-r border-ink-faint/30" : ""}`}>
                <CodeMirrorEditor source={source} onLink={showLink} viewRef={editorView} onScroll={markEditorScrolled} />
              </div>
            )}
            {surface !== "edit" && (
              <div
                ref={previewScroller}
                className="min-h-0 overflow-y-auto overflow-x-hidden"
                data-preview-bg={previewBg}
                onScroll={() => {
                  lastScrolled.current = "preview";
                }}
              >
                {/* Outer wrapper: sideways offset in screen px. Inner: `zoom` (not
                    font-size) so the WHOLE page scales — text, measure, margins,
                    tables and images together. */}
                <div className="relative h-full" style={{ left: offsetX }}>
                  <div className="h-full" style={{ zoom }}>
                    <MarkdownPreview source={source} onLink={showLink} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {link && <LinkPopover request={link} onClose={() => setLink(null)} />}
    </section>
  );
}
