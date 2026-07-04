// Document health bar (提案2): a persistent, one-line status strip. The
// warnings it surfaces — stale AI understanding, export omissions — used to
// exist only as 3.5-second toasts or deep inside the graph panel; here they
// stay visible and clickable.

import { useMemo, useState } from "react";
import { analyzeDocument } from "../aiActions";
import { staleSummaryChunkIds, useStore } from "../store";

/** Approximate word count: Latin words + one per CJK character. */
function countWords(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0;
  const latin = text
    .replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

function relative(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function HealthBar() {
  const chunks = useStore((s) => s.doc.chunks);
  const dirty = useStore((s) => s.dirty);
  const analysis = useStore((s) => s.analysis);
  const analysisStale = useStore((s) => s.analysisStale);
  const globalBusy = useStore((s) => s.globalBusy);
  const speaking = useStore((s) => s.speakingChunkId !== null);
  const lastExportReport = useStore((s) => s.lastExportReport);
  const doc = useStore((s) => s.doc);
  const [showWarnings, setShowWarnings] = useState(false);

  const { words, staleCount } = useMemo(
    () => ({
      words: countWords(chunks.map((c) => c.content).join(" ")),
      staleCount: staleSummaryChunkIds(doc).length,
    }),
    [chunks, doc]
  );

  const analyzedAt = analysis?.analyzedAt;
  const item = "flex items-center gap-1.5 px-2";

  return (
    <div className="relative flex h-7 shrink-0 items-center border-t border-gray-200 bg-gray-50/80 px-2 text-[11px] text-ink-faint">
      {/* Save state */}
      <span className={item} title={dirty ? "Unsaved changes (⌘S to save)" : "All changes saved"}>
        <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-amber-400" : "bg-emerald-500"}`} />
        {dirty ? "Unsaved" : "Saved"}
      </span>

      <span className={item}>
        {chunks.length} paragraph{chunks.length === 1 ? "" : "s"} · ~{words} words
      </span>

      {/* AI understanding freshness (ズレ②): when was Analyze last run, is the
          graph stale, and how many summaries will refresh on the next AI run. */}
      <button
        onClick={() => void analyzeDocument()}
        className={`${item} rounded hover:bg-gray-200/70 ${
          analysisStale ? "text-amber-600" : ""
        }`}
        title={
          analysis
            ? analysisStale
              ? "The document changed since the last Analyze — click to re-analyze"
              : "Relationship graph is up to date — click to re-analyze"
            : "Not analyzed yet — click to analyze relationships"
        }
      >
        {analysis
          ? `AI: analyzed ${analyzedAt ? relative(analyzedAt) : "earlier"}${
              analysisStale ? " · out of date" : ""
            }`
          : "AI: not analyzed"}
      </button>
      {staleCount > 0 && (
        <span
          className={`${item} text-amber-600`}
          title="These paragraph summaries no longer match their text; they refresh automatically before the next AI action."
        >
          {staleCount} stale summar{staleCount === 1 ? "y" : "ies"}
        </span>
      )}

      <span className="flex-1" />

      {speaking && <span className={`${item} text-accent`}>Reading aloud…</span>}
      {globalBusy && <span className={`${item} text-accent`}>{globalBusy}</span>}

      {/* Last export report (ズレ① visibility): keep omission warnings around. */}
      {lastExportReport && (
        <button
          onClick={() => setShowWarnings((v) => !v)}
          className={`${item} rounded hover:bg-gray-200/70 ${
            lastExportReport.warnings.length ? "text-amber-600" : ""
          }`}
          title="Details of the most recent export"
        >
          Export ({lastExportReport.format.toUpperCase()}):{" "}
          {lastExportReport.warnings.length
            ? `${lastExportReport.warnings.length} warning${
                lastExportReport.warnings.length === 1 ? "" : "s"
              }`
            : "clean"}
        </button>
      )}
      {showWarnings && lastExportReport && (
        <div className="absolute bottom-8 right-2 z-40 w-96 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ink">
            <span>
              Last export — {lastExportReport.format.toUpperCase()} (
              {relative(lastExportReport.at)})
            </span>
            <button
              onClick={() => setShowWarnings(false)}
              className="text-ink-faint hover:text-ink"
            >
              ×
            </button>
          </div>
          {lastExportReport.warnings.length === 0 ? (
            <p className="text-xs text-ink-soft">No warnings — nothing was omitted.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
              {lastExportReport.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
