// "Review criteria ↔ body text" mapping view (開発.txt Stage 2, item 2-1, Part
// B): the user types/pastes their OWN list of review-criteria phrases (e.g.
// grant-review points) and asks the AI which ones have no supporting
// paragraph anywhere in the document. This module holds NO built-in criteria
// list and no knowledge of any real institution's actual review form — see
// 開発.txt §9: which official government/funding-body forms to bundle is an
// explicitly unresolved decision, out of scope here. Everything the user
// checks against is text they typed in themselves.
//
// Mount point: opened via the command palette (and rendered unconditionally,
// self-hiding, from HealthBar.tsx — see the bottom of that file) rather than
// being wired into App.tsx's docked-panel layout, so it owns its own
// open/closed state via the tiny store below. This keeps the change confined
// to this feature's owned files instead of touching the shared App.tsx /
// store.ts. It renders as a non-modal, dismissible, corner-docked panel (UI
// rule: no new modal when a docked panel suffices) rather than a blocking
// dialog, since checking criteria coverage never needs to block editing.

import { useState } from "react";
import { create } from "zustand";
import { checkAgainstCriteria, type CriteriaCheckResult } from "../aiActions";
import { translateWith, useLang, useT } from "../i18n";
import { useStore } from "../store";
import { CheckSquareIcon, CloseIcon, SquareIcon } from "./icons";

interface CriteriaPanelStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Standalone panel-visibility store — see the module doc comment above. */
export const useCriteriaPanelStore = create<CriteriaPanelStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

/** Imperative helper for callers outside React (e.g. CommandPalette entries). */
export function openCriteriaPanel(): void {
  useCriteriaPanelStore.getState().setOpen(true);
}

/** A chunk's display title: its first ~60 chars (mirrors ReviewPanel's). */
function chunkPreview(content: string, max = 60): string {
  const text = content.trim().replace(/\s+/g, " ");
  if (!text) return "(empty paragraph)";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function CriteriaPanel() {
  const t = useT();
  const lang = useLang();
  const open = useCriteriaPanelStore((s) => s.open);
  const setOpen = useCriteriaPanelStore((s) => s.setOpen);
  const chunks = useStore((s) => s.doc.chunks);
  const globalBusy = useStore((s) => s.globalBusy);
  const flashChunk = useStore((s) => s.flashChunk);

  const [text, setText] = useState("");
  const [results, setResults] = useState<CriteriaCheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const criteria = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const runCheck = async () => {
    if (!criteria.length || checking) return;
    setChecking(true);
    setError(null);
    try {
      const r = await checkAgainstCriteria(criteria);
      // checkAgainstCriteria already surfaces a toast for every failure case
      // (missing key, stale analysis, empty doc, request/parse error) via the
      // shared notify() convention — this local error state is a SECOND,
      // persistent surface inside the panel itself, so the failure is still
      // visible if the toast has already faded.
      if (r === null) {
        setError(
          t("The check could not run — see the notification for why (e.g. run Analyze first, or set an API key).")
        );
      } else {
        setResults(r);
      }
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed bottom-9 right-2 z-40 w-96 rounded-lg border border-gray-200 bg-white p-3 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <CheckSquareIcon className="h-4 w-4" />
          {t("Review criteria coverage")}
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink"
          aria-label={t("Close review criteria panel")}
          title={t("Close")}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-2 text-xs text-ink-faint">
        {t(
          "Type your own review criteria, one per line (e.g. from a grant's review rubric) — this app has no built-in list. The AI checks whether each one has a supporting paragraph anywhere in the document (run Analyze first)."
        )}
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={[
          t("One criterion per line, e.g.:"),
          t("Explains the significance of the research"),
          t("States a clear methodology"),
        ].join("\n")}
        className="w-full resize-none rounded-md border border-gray-300 p-2 text-xs text-ink-soft outline-none focus:border-accent"
      />

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-ink-faint">
          {criteria.length === 1
            ? t("1 criterion")
            : translateWith("{n} criteria", lang, { n: criteria.length })}
        </span>
        <button
          onClick={() => void runCheck()}
          disabled={criteria.length === 0 || checking || !!globalBusy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-soft disabled:opacity-50"
        >
          {checking ? t("Checking…") : t("Check against criteria")}
        </button>
      </div>

      {/* Empty state: no criteria entered yet AND no result to show. */}
      {criteria.length === 0 && results === null && !error && (
        <p className="mt-3 rounded-md bg-gray-50/60 px-2 py-3 text-center text-xs text-ink-faint">
          {t("Add one or more criteria above, then run the check.")}
        </p>
      )}

      {/* Loading state. */}
      {checking && (
        <p className="mt-3 text-center text-xs text-ink-faint">{t("Checking against the document…")}</p>
      )}

      {/* Error state — persistent, not just the toast fileActions/aiActions
          already fire via notify(). */}
      {error && !checking && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Result state. */}
      {results && !checking && (
        <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {results.map((r, i) => (
            <li
              key={`${r.criterion}-${i}`}
              className={`rounded-md border px-2 py-1.5 text-xs ${
                r.covered
                  ? "border-emerald-200 bg-emerald-50/60"
                  : "border-amber-200 bg-amber-50/60"
              }`}
            >
              <div className="flex items-start gap-1.5">
                {r.covered ? (
                  <CheckSquareIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                ) : (
                  <SquareIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                )}
                <span className="text-ink">{r.criterion}</span>
              </div>
              {r.covered ? (
                <div className="mt-1 flex flex-wrap gap-1 pl-5">
                  {r.supportingChunkIds.map((id) => {
                    const c = chunks.find((x) => x.id === id);
                    return (
                      <button
                        key={id}
                        onClick={() => flashChunk(id)}
                        className="rounded bg-white px-1.5 py-0.5 text-[10px] text-emerald-700 underline decoration-dotted hover:bg-emerald-100"
                        title={t("Jump to this paragraph")}
                      >
                        {c ? chunkPreview(c.content, 30) : id}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 pl-5 text-[11px] text-amber-700">
                  {t("No supporting paragraph found.")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
