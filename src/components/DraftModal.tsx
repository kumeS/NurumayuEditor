// "Draft a document by AI" dialog: a theme, an approximate target length, and
// optional reference material (pasted text, an attached .txt/.md/.rtf/.pdf
// file, or a fetched URL) that the draft should draw on. The draft itself is
// streamed into a new tab by `draftDocument`.
//
// Lifecycle (BUG-014): Draft does not close the dialog up front. While the
// request waits for its first content the dialog shows a generating state
// (inputs disabled, not dismissible by Escape/backdrop); ✕ / Cancel detach
// the pending draft (its result is ignored, no tab is created). The dialog
// closes as soon as content arrives. A failure before any content keeps it
// open with the inputs intact and an inline error + Retry; the inputs also
// survive closing and reopening after a failed attempt.

import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { DRAFT_TARGETS, draftLengthOptionLabel } from "../draftLength";
import { detachPendingDraft, draftDocument } from "../fileActions";
import { translateWith, useLang, useT } from "../i18n";
import { isImeKeyEvent } from "../modalBehavior";
import { useStore } from "../store";
import { CloseIcon, DraftIcon, ImportIcon, NetworkIcon, SpinnerIcon } from "./icons";
import Modal from "./Modal";

// Rust truncates the combined reference at this many chars (ai.rs
// generate_draft_stream) — surfaced here instead of failing silently (§5-2).
const REFERENCE_CHAR_LIMIT = 12000;

/** One attached reference (a read file or a fetched URL), shown as a chip row. */
interface RefSource {
  label: string;
  text: string;
}

export default function DraftModal() {
  const t = useT();
  const lang = useLang();
  const open_ = useStore((s) => s.draftOpen);
  const close = useStore((s) => s.closeDraft);
  const globalBusy = useStore((s) => s.globalBusy);
  const notify = useStore((s) => s.notify);

  const [theme, setTheme] = useState("");
  const [lengthIdx, setLengthIdx] = useState(0);
  // Reference material: the paste textarea is ONE source kind; attached files
  // and fetched URLs are separate, individually removable sources (item 59) —
  // no longer blind-concatenated into the textarea.
  const [reference, setReference] = useState("");
  const [sources, setSources] = useState<RefSource[]>([]);
  const [url, setUrl] = useState("");
  const [working, setWorking] = useState<null | "file" | "url">(null);
  // Waiting for the draft's first content (BUG-014).
  const [generating, setGenerating] = useState(false);
  // Localized failure from the last attempt, shown inline with Retry.
  const [error, setError] = useState<string | null>(null);
  // After a failed or abandoned attempt the inputs are kept for the next open.
  const keepInputs = useRef(false);
  const titleId = useId();
  const themeId = useId();
  const lengthId = useId();
  const referenceId = useId();

  useEffect(() => {
    if (!open_) return;
    setError(null);
    setWorking(null);
    if (!keepInputs.current) {
      setTheme("");
      setLengthIdx(0);
      setReference("");
      setSources([]);
      setUrl("");
    }
  }, [open_]);

  if (!open_) return null;

  const field =
    "w-full rounded-md border border-chrome-edge px-3 py-2 text-sm outline-none focus:border-accent";

  const addSource = (chunk: string, source: string) => {
    const piece = chunk.trim();
    if (!piece) {
      notify(translateWith("No readable text found in {source}.", lang, { source }), "info");
      return;
    }
    // Quiet success (ui.md #6): the new chip row is the confirmation.
    setSources((prev) => [...prev, { label: source, text: piece }]);
  };

  const attachFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: t("Reference"), extensions: ["txt", "md", "markdown", "rtf", "pdf"] },
        ],
      });
      if (typeof selected !== "string") return;
      setWorking("file");
      const text = await api.readReferenceFile(selected);
      const name = selected.split(/[\\/]/).pop() ?? "file";
      addSource(text, name);
    } catch (e) {
      notify(typeof e === "string" ? e : String(e), "error");
    } finally {
      setWorking(null);
    }
  };

  const fetchUrl = async () => {
    const u = url.trim();
    if (!u) return;
    try {
      setWorking("url");
      const text = await api.fetchUrlText(u);
      addSource(text, u);
      setUrl("");
    } catch (e) {
      notify(typeof e === "string" ? e : String(e), "error");
    } finally {
      setWorking(null);
    }
  };

  // Pasted text first (no header, as before), then each source under its
  // "--- {source} ---" separator — the same format the backend always received.
  const combinedReference = [
    reference.trim(),
    ...sources.map((s) => `--- ${s.label} ---\n${s.text}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  const submit = async () => {
    if (generating) return;
    if (!theme.trim()) {
      notify(t("Enter a theme to draft about."), "info");
      return;
    }
    const words = DRAFT_TARGETS[lengthIdx] ?? undefined;
    setError(null);
    setGenerating(true);
    const r = await draftDocument(theme, words ?? undefined, combinedReference || undefined, () => {
      // First content: the draft owns its tab now — close; start fresh next time.
      keepInputs.current = false;
      setGenerating(false);
      close();
    });
    // Success closed the dialog already; a detached draft was dismissed; a
    // failure after content is reported by draftDocument on its own surfaces.
    if (r.ok || r.reason === "detached" || r.hadContent) return;
    setGenerating(false);
    keepInputs.current = true;
    // "not-ready" opens Settings (with a toast) instead of an inline error.
    if (r.error && r.reason !== "not-ready") setError(r.error);
  };

  // ✕ / Cancel / Escape / backdrop. While waiting for content, only ✕ and
  // Cancel are live (the Modal is not dismissible): they detach the draft.
  const dismiss = () => {
    if (generating) {
      detachPendingDraft();
      setGenerating(false);
      keepInputs.current = true;
    }
    close();
  };

  return (
    <Modal
      name="draft"
      onClose={dismiss}
      dismissible={!generating}
      labelledBy={titleId}
      panelClassName="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl"
    >
        <div className="flex shrink-0 items-center justify-between border-b border-chrome-hairline px-6 pb-3 pt-5">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-ink">
            <DraftIcon />{t("Draft a document by AI")}</h2>
          <button
            onClick={dismiss}
            className="text-ink-faint hover:text-ink"
            aria-label={t("Close")}
            title={generating ? t("Stop waiting (the draft result will be discarded)") : t("Close")}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div>
            <label htmlFor={themeId} className="mb-1 block text-sm font-medium text-ink-soft">
              {t("Theme / topic")}
            </label>
            <textarea
              id={themeId}
              value={theme}
              autoFocus
              disabled={generating}
              onChange={(e) => setTheme(e.target.value)}
              placeholder={t("e.g. The role of attention mechanisms in NLP")}
              rows={3}
              className={`${field} resize-y`}
            />
          </div>

          <div>
            <label htmlFor={lengthId} className="mb-1 block text-sm font-medium text-ink-soft">
              {t("Approximate length")}
            </label>
            <select
              id={lengthId}
              value={lengthIdx}
              disabled={generating}
              onChange={(e) => setLengthIdx(Number(e.target.value))}
              className={field}
            >
              {DRAFT_TARGETS.map((words, i) => (
                <option key={words ?? "auto"} value={i}>
                  {draftLengthOptionLabel(words, lang)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">
              {t("Length is approximate; the result is reported after drafting.")}
            </p>
          </div>

          <div>
            <label htmlFor={referenceId} className="mb-1 block text-sm font-medium text-ink-soft">{t("Reference material")}<span className="ml-1 text-ink-faint">{t("(optional)")}</span>
            </label>
            <textarea
              id={referenceId}
              value={reference}
              disabled={generating}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("Paste notes or text here, and/or attach a file / fetch a URL below.")}
              rows={4}
              className={`${field} resize-y`}
            />
            {sources.length > 0 && (
              <div className="mt-2 space-y-1">
                {sources.map((s, i) => (
                  <div
                    key={`${s.label}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-chrome-line bg-chrome/60 px-2 py-1 text-xs text-ink-soft"
                  >
                    <span className="min-w-0 flex-1 truncate" title={s.label}>
                      {s.label}
                    </span>
                    <span className="shrink-0 text-ink-faint">
                      {translateWith("{n} chars", lang, { n: s.text.length.toLocaleString() })}
                    </span>
                    <button
                      type="button"
                      aria-label={translateWith("Remove {name}", lang, { name: s.label })}
                      title={translateWith("Remove {name}", lang, { name: s.label })}
                      disabled={generating}
                      onClick={() =>
                        setSources((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="shrink-0 text-ink-faint hover:text-danger disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {combinedReference.length > REFERENCE_CHAR_LIMIT && (
              <p className="mt-2 rounded-md border border-warn-line bg-warn-wash px-2 py-1 text-xs text-warn-strong">
                {t("Only about the first 12,000 characters will be used by the AI.")}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={attachFile}
                disabled={working !== null || generating}
                className="flex items-center gap-1.5 rounded-md border border-chrome-edge px-2.5 py-1.5 text-sm text-ink-soft hover:bg-chrome-hairline disabled:opacity-50"
              >
                {working === "file" ? <SpinnerIcon /> : <ImportIcon className="h-4 w-4" />}
                {t("Attach .txt / .md / .rtf / .pdf")}
              </button>
              {/* MISS-06: the native picker's column view is easy to misread. */}
              <span className="text-xs text-ink-faint">{t("Select a file, then choose Open.")}</span>
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={url}
                aria-label={t("Reference URL")}
                disabled={generating}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeKeyEvent(e.nativeEvent)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void fetchUrl();
                  }
                }}
                placeholder={t("https://… reference URL")}
                className={field}
              />
              <button
                type="button"
                onClick={() => void fetchUrl()}
                disabled={working !== null || generating || !url.trim()}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-chrome-edge px-3 py-2 text-sm text-ink-soft hover:bg-chrome-hairline disabled:opacity-50"
              >
                {working === "url" ? <SpinnerIcon /> : <NetworkIcon className="h-4 w-4" />}
                {t("Fetch")}
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              {t("The draft is grounded in this material (it won't copy it verbatim).")}{" "}
              {t("PDF text extraction is best-effort.")}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-wash px-3 py-2 text-sm text-danger"
            >
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button
                type="button"
                onClick={() => void submit()}
                className="shrink-0 rounded-md border border-danger-line px-2 py-0.5 text-xs font-medium hover:bg-danger-line/50"
              >
                {t("Retry")}
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-chrome-hairline px-6 py-4">
          {generating && (
            <p className="mr-auto text-xs text-ink-faint" aria-live="polite">
              {t("The dialog closes as soon as the draft starts to appear.")}
            </p>
          )}
          <button
            onClick={dismiss}
            title={generating ? t("Stop waiting (the draft result will be discarded)") : undefined}
            className="rounded-md px-4 py-2 text-sm text-ink-soft hover:bg-chrome-hairline"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={() => void submit()}
            disabled={!!globalBusy || !theme.trim() || generating}
            aria-busy={generating}
            className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
          >
            {generating ? (
              <>
                <SpinnerIcon className="h-4 w-4" />
                {t("Generating…")}
              </>
            ) : (
              <>
                <DraftIcon className="h-4 w-4" />
                {t("Draft")}
              </>
            )}
          </button>
        </div>
    </Modal>
  );
}
