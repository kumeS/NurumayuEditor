import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { documentToMarkdown } from "../markdown";
import {
  findMarkdownLinkAt,
  markdownUrlTransform,
  replaceMarkdownRange,
} from "../markdownPreview";
import { useT } from "../i18n";
import { useStore } from "../store";
import MermaidChunk from "./MermaidChunk";

type MarkdownSurface = "edit" | "split" | "preview";
type PositionedNode = {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};
type LinkRequest = { href: string; label: string; x: number; y: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert the inline DOM inside one edited rendered block back to Markdown. */
function renderedInlineToMarkdown(root: HTMLElement): string {
  const serialize = (node: ChildNode): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const body = Array.from(node.childNodes).map(serialize).join("");
    switch (node.tagName) {
      case "STRONG":
      case "B":
        return `**${body}**`;
      case "EM":
      case "I":
        return `*${body}*`;
      case "DEL":
      case "S":
        return `~~${body}~~`;
      case "CODE":
        return `\`${body}\``;
      case "A":
        return `[${body}](${node.getAttribute("href") ?? ""})`;
      case "IMG":
        return `![${node.getAttribute("alt") ?? ""}](${node.getAttribute("src") ?? ""})`;
      case "BR":
        return "\n";
      case "DIV":
        return `${body}\n`;
      default:
        return body;
    }
  };
  return Array.from(root.childNodes).map(serialize).join("").replace(/\n+$/, "");
}

function EditableBlock({
  tag,
  node,
  source,
  editable,
  prefix = "",
  children,
}: {
  tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "td" | "th";
  node?: PositionedNode;
  source: string;
  editable: boolean;
  prefix?: string;
  children: ReactNode;
}) {
  const changed = useRef(false);
  const t = useT();
  const setMarkdownSource = useStore((state) => state.setMarkdownSource);
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  const canEdit = editable && typeof start === "number" && typeof end === "number";

  return createElement(
    tag,
    {
      contentEditable: canEdit,
      suppressContentEditableWarning: true,
      spellCheck: true,
      role: canEdit ? "textbox" : undefined,
      "aria-label": canEdit ? t("Edit rendered Markdown text") : undefined,
      onInput: () => {
        changed.current = true;
      },
      onBlur: (event: { currentTarget: HTMLElement }) => {
        if (!canEdit || !changed.current) return;
        changed.current = false;
        const current = documentToMarkdown(useStore.getState().doc);
        // Positions belong to `source`; do not apply a stale span over a newer
        // simultaneous source edit.
        if (current !== source) return;
        const text = renderedInlineToMarkdown(event.currentTarget);
        setMarkdownSource(replaceMarkdownRange(current, start, end, `${prefix}${text}`));
      },
    },
    children
  );
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const t = useT();
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span className="markdown-image-error font-sans text-sm text-ink-faint" role="img" aria-label={alt || t("Image")}>
        {t("Image could not be displayed")}{alt ? `: ${alt}` : "."}
      </span>
    );
  }
  return <img src={src} alt={alt ?? ""} loading="lazy" onError={() => setFailed(true)} />;
}

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
  const zoom = useStore((state) => state.markdownZoom);
  if (!source.trim()) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center font-sans text-sm text-ink-faint">
        {t("Start writing Markdown to see the preview.")}
      </div>
    );
  }

  const block = (tag: Parameters<typeof EditableBlock>[0]["tag"], prefix = "") =>
    ({ node, children }: { node?: PositionedNode; children?: ReactNode }) => (
      <EditableBlock tag={tag} node={node} source={source} editable={editable} prefix={prefix}>
        {children}
      </EditableBlock>
    );

  return (
    <article
      className="markdown-preview mx-auto w-full max-w-prose px-10 py-12 font-sans text-ink"
      style={{ fontSize: `${(17 * zoom).toFixed(2)}px` }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={markdownUrlTransform}
        components={{
          h1: block("h1", "# "),
          h2: block("h2", "## "),
          h3: block("h3", "### "),
          h4: block("h4", "#### "),
          h5: block("h5", "##### "),
          h6: block("h6", "###### "),
          p: block("p"),
          td: block("td"),
          th: block("th"),
          a: ({ children, href }) => (
            <a
              href={href}
              contentEditable={false}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (href) onLink?.({ href, label: event.currentTarget.innerText, x: event.clientX, y: event.clientY });
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
          code: ({ className, children, ...props }) => {
            if (className === "language-mermaid") {
              return <MermaidChunk code={String(children).replace(/\n$/, "")} />;
            }
            return (
              <code className={className} {...props} contentEditable={false}>
                {children}
              </code>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}

function CodeMirrorEditor({ source, onLink }: { source: string; onLink: (request: LinkRequest) => void }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const setMarkdownSource = useStore((state) => state.setMarkdownSource);

  const extensions = useMemo(
    () => [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      bracketMatching(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setMarkdownSource(update.state.doc.toString());
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
      EditorView.theme({
        "&": {
          height: "100%",
          backgroundColor: "transparent",
          color: "var(--color-ink)",
          fontSize: "var(--editor-font-size, 17px)",
        },
        ".cm-scroller": {
          fontFamily: "var(--font-content-mono)",
          lineHeight: "1.75",
          padding: "28px 0 56px",
        },
        ".cm-content": { maxWidth: "52rem", margin: "0 auto", padding: "0 32px" },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: "var(--color-ink-faint)",
          border: "none",
        },
        ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-accent-wash)" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--color-selection) !important",
        },
        "&.cm-focused": { outline: "none" },
      }),
    ],
    [onLink, setMarkdownSource]
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: source, extensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === source) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
  }, [source]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" aria-label={t("Markdown source editor")} />;
}

function LinkPopover({ request, onClose }: { request: LinkRequest; onClose: () => void }) {
  const notify = useStore((state) => state.notify);
  const t = useT();
  const openable = /^(?:https?:|mailto:)/i.test(request.href);
  const left = Math.max(12, Math.min(request.x, window.innerWidth - 340));
  const top = Math.max(12, Math.min(request.y + 10, window.innerHeight - 150));
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
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

  const showLink = useCallback((request: LinkRequest) => setLink(request), []);

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
        <div className="text-xs text-ink-faint">{t("Edit source or click rendered text to edit it directly.")}</div>
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
                title={`${t("Zoom out")} (⌘−)`}
                aria-label={t("Zoom out")}
                className="px-2 py-1.5 text-ink-soft hover:bg-accent/5 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setMarkdownZoom(1)}
                title={`${t("Reset zoom to 100%")} (⌘0)`}
                className="min-w-[3.5rem] border-x border-ink-faint/30 px-2 py-1.5 tabular-nums text-ink-soft hover:bg-accent/5"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() => setMarkdownZoom(zoom + 0.1)}
                disabled={zoom >= 2.5}
                title={`${t("Zoom in")} (⌘+)`}
                aria-label={t("Zoom in")}
                className="px-2 py-1.5 text-ink-soft hover:bg-accent/5 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                ＋
              </button>
            </div>
          )}
        <div className="flex overflow-hidden rounded-md border border-ink-faint/30 text-xs shadow-sm" aria-label={t("Markdown layout")}>
          {(["edit", "split", "preview"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setSurface(item)}
              className={`px-3 py-1.5 capitalize ${surface === item ? "bg-accent text-white" : "bg-white text-ink-soft hover:bg-accent/5"}`}
            >
              {t(item === "edit" ? "Edit" : item === "split" ? "Split" : "Preview")}
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
                <CodeMirrorEditor source={source} onLink={showLink} />
              </div>
            )}
            {surface !== "edit" && (
              <div className="min-h-0 overflow-y-auto bg-white">
                <MarkdownPreview source={source} onLink={showLink} />
              </div>
            )}
          </div>
        </div>
      </div>
      {link && <LinkPopover request={link} onClose={() => setLink(null)} />}
    </section>
  );
}
