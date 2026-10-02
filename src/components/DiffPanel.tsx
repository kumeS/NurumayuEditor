// "Changes since last save" panel (item 1-2): the at-a-glance "what did I do
// since last time" view for weekly progress reporting. Compares the current
// document against the baseline captured at the last save/open (store.ts
// `savedDoc`) via the pure documentDiff() and renders a Title row (when the
// title changed) plus three sections — Added / Removed / Changed — reusing the SAME word-diff highlight JSX
// ChunkView.tsx already uses for the per-paragraph AI-edit diff, so the two
// diff surfaces stay visually consistent.
//
// States: when no paragraph or title differs, the empty state shows
// changesLabel() for the same changeSummary() the health bar uses, so the
// panel never says "No changes" while the document is dirty (BUG-015b): it
// names an order/analysis/metadata change, or "Unsaved (matches last save)".
// No loading state:
// documentDiff() is a synchronous in-memory computation over already-loaded
// state, nothing to await. No error state: a pure function over validated
// in-memory Documents cannot fail (no I/O, no parsing of untrusted input).

import { useMemo } from "react";
import { changeSummary, documentDiff, wordDiff, type ChangedChunk } from "../diff";
import { changesLabel } from "../healthLabels";
import { translateWith, useLang, useT } from "../i18n";
import { useStore } from "../store";
import type { Chunk } from "../types";
import { CloseIcon, HistoryIcon } from "./icons";

/** Short single-line preview of a chunk's content for the Added/Removed lists. */
function preview(content: string, t: (key: string) => string, max = 90): string {
  const flat = content.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || t("(empty paragraph)");
}

/** Word-diff highlight — mirrors ChunkView.tsx's "What changed" rendering
 *  (same tags, same additive-mark/removed-mark tokens) so both diff surfaces
 *  read identically. */
function WordDiffPreview({ before, after }: { before: string; after: string }) {
  return (
    <p className="font-serif text-[0.95rem] leading-6 text-ink-soft">
      {wordDiff(before, after).map((op, i) =>
        op.type === "equal" ? (
          <span key={i}>{op.text}</span>
        ) : op.type === "insert" ? (
          <mark key={i} className="rounded bg-additive-mark/70 text-ink">
            {op.text}
          </mark>
        ) : (
          <span key={i} className="rounded bg-removed-mark/50 text-ink-faint line-through">
            {op.text}
          </span>
        )
      )}
    </p>
  );
}

interface DiffPanelProps {
  onClose: () => void;
}

export default function DiffPanel({ onClose }: DiffPanelProps) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const savedDoc = useStore((s) => s.savedDoc);
  const dirty = useStore((s) => s.dirty);
  const lang = useLang();

  const diff = useMemo(() => documentDiff(savedDoc, doc), [savedDoc, doc]);
  const summary = useMemo(() => changeSummary(savedDoc, doc), [savedDoc, doc]);
  const isEmpty = summary.paragraphs === 0 && !summary.titleChanged;

  return (
    <div className="w-96 rounded-lg border border-chrome-line bg-white p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <HistoryIcon className="h-4 w-4" />
          {t("Changes since last save")}
        </div>
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink"
          aria-label={t("Close changes panel")}
          title={t("Close")}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {isEmpty ? (
        <p className="px-1 py-4 text-center text-xs text-ink-faint">
          {changesLabel(summary, dirty, lang)}
        </p>
      ) : (
        <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
          {summary.titleChanged && (
            <DiffSection title={t("Title")} tone="changed">
              <li className="rounded bg-warn-wash/60 px-2 py-1">
                <WordDiffPreview before={savedDoc?.title || t("Untitled")} after={doc.title || t("Untitled")} />
              </li>
            </DiffSection>
          )}

          {diff.added.length > 0 && (
            <DiffSection title={translateWith("Added ({n})", lang, { n: diff.added.length })} tone="added">
              {diff.added.map((c: Chunk) => (
                <li key={c.id} className="rounded bg-additive-wash px-2 py-1 text-xs text-ink-soft">
                  {preview(c.content, t)}
                </li>
              ))}
            </DiffSection>
          )}

          {diff.removed.length > 0 && (
            <DiffSection title={translateWith("Removed ({n})", lang, { n: diff.removed.length })} tone="removed">
              {diff.removed.map((c: Chunk) => (
                <li
                  key={c.id}
                  className="rounded bg-removed-wash px-2 py-1 text-xs text-ink-faint line-through"
                >
                  {preview(c.content, t)}
                </li>
              ))}
            </DiffSection>
          )}

          {diff.changed.length > 0 && (
            <DiffSection title={translateWith("Changed ({n})", lang, { n: diff.changed.length })} tone="changed">
              {diff.changed.map((c: ChangedChunk) => (
                <li key={c.id} className="rounded bg-warn-wash/60 px-2 py-1">
                  <WordDiffPreview before={c.before} after={c.after} />
                </li>
              ))}
            </DiffSection>
          )}

          {summary.otherChanged && (
            <p className="text-xs text-ink-faint">{t("Order, analysis or metadata changed")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function DiffSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "added" | "removed" | "changed";
  children: React.ReactNode;
}) {
  const toneCls =
    tone === "added" ? "text-additive" : tone === "removed" ? "text-removed" : "text-warn-strong";
  return (
    <div>
      <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${toneCls}`}>
        {title}
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}
