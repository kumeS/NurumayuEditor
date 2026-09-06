// Document health bar (提案2): a persistent, one-line status strip. The
// warnings it surfaces — stale AI understanding, export omissions — used to
// exist only as 3.5-second toasts or deep inside the graph panel; here they
// stay visible and clickable.

import { useEffect, useMemo, useState } from "react";
import { analyzeDocument } from "../aiActions";
import { api } from "../api";
import { chunksOverCharLimit } from "../charLimitWarnings";
import { documentDiff } from "../diff";
import { useLang, useT } from "../i18n";
import { staleSummaryChunkIds, useStore } from "../store";
import type { NetworkStats } from "../types";
import CitationsPanel from "./CitationsPanel";
import CriteriaPanel from "./CriteriaPanel";
import DiffPanel from "./DiffPanel";
import { HistoryIcon } from "./icons";
import PersonalLibraryPanel from "./PersonalLibraryPanel";

/** Approximate word count: Latin words + one per CJK character. */
function countWords(text: string): number {
  const cjk = text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0;
  const latin = text
    .replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

function relative(ts: number, ja = false): string {
  const d = Date.now() - ts;
  if (d < 60_000) return ja ? "たった今" : "just now";
  if (d < 3_600_000) {
    const m = Math.floor(d / 60_000);
    return ja ? `${m}分前` : `${m} min ago`;
  }
  if (d < 86_400_000) {
    const h = Math.floor(d / 3_600_000);
    return ja ? `${h}時間前` : `${h} h ago`;
  }
  return new Date(ts).toLocaleDateString(ja ? "ja-JP" : undefined);
}

export default function HealthBar() {
  const chunks = useStore((s) => s.doc.chunks);
  const dirty = useStore((s) => s.dirty);
  const analysis = useStore((s) => s.analysis);
  const analysisStale = useStore((s) => s.analysisStale);
  const globalBusy = useStore((s) => s.globalBusy);
  const speaking = useStore((s) => s.speakingChunkId !== null);
  const t = useT();
  const ja = useLang() === "ja";
  const lastExportReport = useStore((s) => s.lastExportReport);
  const doc = useStore((s) => s.doc);
  const savedDoc = useStore((s) => s.savedDoc);
  const diffPanelOpen = useStore((s) => s.diffPanelOpen);
  const toggleDiffPanel = useStore((s) => s.toggleDiffPanel);
  const settings = useStore((s) => s.settings);
  const setFocused = useStore((s) => s.setFocused);
  const flashChunk = useStore((s) => s.flashChunk);
  const [showWarnings, setShowWarnings] = useState(false);
  const [showCharLimit, setShowCharLimit] = useState(false);

  // "Zero external transmission" visibility (開発.txt Stage 2, item 2-2): a
  // simple periodic poll of the combined Rust-side counters — there's no
  // single existing "an AI action just finished" hook point that covers ALL
  // of ai_process/ai_process_stream/ai_draft_stream/ai_generate_image/
  // ai_generate_diagram/ai_analyze_document plus fetch_url_text, so polling
  // is the minimal implementation that stays accurate regardless of which
  // action ran. Cleaned up on unmount.
  const [netStats, setNetStats] = useState<NetworkStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void api.getNetworkStats().then((stats) => {
        if (!cancelled) setNetStats(stats);
      });
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const { words, staleCount, changedCount } = useMemo(
    () => ({
      words: countWords(chunks.map((c) => c.content).join(" ")),
      staleCount: staleSummaryChunkIds(doc).length,
      // Item 1-2: cheap count for the indicator label, memoized like the other
      // doc-derived counts above — the full diff (with word-level highlights)
      // is only computed inside DiffPanel when it's actually open.
      changedCount: (() => {
        const d = documentDiff(savedDoc, doc);
        return d.added.length + d.removed.length + d.changed.length;
      })(),
    }),
    [chunks, doc, savedDoc]
  );

  // Grant-application beachhead (開発.txt Stage 2, item 2-1), Part A: which
  // paragraphs currently exceed the user-configured character limit. []
  // (nothing rendered) whenever the setting is unset — opt-in, no clutter for
  // users who never configured a limit.
  const overLimitChunks = useMemo(
    () => chunksOverCharLimit(chunks, settings?.charLimitWarning),
    [chunks, settings?.charLimitWarning]
  );

  const analyzedAt = analysis?.analyzedAt;
  const item = "flex items-center gap-1.5 px-2";

  return (
    <div className="relative flex h-7 shrink-0 items-center border-t border-gray-200 bg-gray-50/80 px-2 text-[11px] text-ink-faint">
      {/* Save state */}
      <span className={item} title={dirty ? t("Unsaved changes (⌘S to save)") : t("All changes saved")}>
        <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-amber-400" : "bg-emerald-500"}`} />
        {dirty ? t("Unsaved") : t("Saved")}
      </span>

      <span className={item}>
        {ja
          ? `${chunks.length}段落 · 約${words}語`
          : `${chunks.length} paragraph${chunks.length === 1 ? "" : "s"} · ~${words} words`}
      </span>

      {/* "Changes since last save" (item 1-2): the at-a-glance weekly-progress
          view — click opens DiffPanel, a documentDiff() over the last
          save/open baseline vs the current document. */}
      <button
        onClick={() => toggleDiffPanel()}
        className={`${item} rounded hover:bg-gray-200/70 ${changedCount > 0 ? "text-amber-600" : ""}`}
        title={t("Show paragraphs added, removed, or changed since the document was last saved")}
      >
        <HistoryIcon className="h-3 w-3" />
        {changedCount > 0
          ? ja
            ? `前回保存から${changedCount}件変更`
            : `${changedCount} changed since last save`
          : t("No changes since last save")}
      </button>

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
              ? t("The document changed since the last Analyze — click to re-analyze")
              : t("Relationship graph is up to date — click to re-analyze")
            : t("Not analyzed yet — click to analyze relationships")
        }
      >
        {analysis
          ? ja
            ? `AI: ${analyzedAt ? relative(analyzedAt, true) : "以前"}に分析${analysisStale ? " · 最新ではありません" : ""}`
            : `AI: analyzed ${analyzedAt ? relative(analyzedAt) : "earlier"}${
                analysisStale ? " · out of date" : ""
              }`
          : t("AI: not analyzed")}
      </button>
      {staleCount > 0 && (
        <span
          className={`${item} text-amber-600`}
          title={t("These paragraph summaries no longer match their text; they refresh automatically before the next AI action.")}
        >
          {ja ? `要約${staleCount}件が古い状態` : `${staleCount} stale summar${staleCount === 1 ? "y" : "ies"}`}
        </span>
      )}

      {/* Grant-application beachhead (開発.txt Stage 2, item 2-1), Part A:
          persistent warning badge for paragraphs over the configured
          character limit — never a toast-only notification (this project's
          rule for anything reporting a limit-exceeded condition). Nothing
          renders when the setting is unset (default), so users who never
          opted in see no extra clutter. */}
      {overLimitChunks.length > 0 && (
        <button
          onClick={() => setShowCharLimit((v) => !v)}
          className={`${item} rounded text-amber-600 hover:bg-gray-200/70`}
          title={`${overLimitChunks.length} paragraph${
            overLimitChunks.length === 1 ? "" : "s"
          } over the ${settings?.charLimitWarning}-character limit set in Settings — click to list them`}
        >
          {ja
            ? `${overLimitChunks.length}段落が文字数超過`
            : `${overLimitChunks.length} paragraph${overLimitChunks.length === 1 ? "" : "s"} over limit`}
        </button>
      )}
      {showCharLimit && overLimitChunks.length > 0 && (
        <div className="absolute bottom-8 left-2 z-40 w-80 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ink">
            <span>
              {ja
                ? `${settings?.charLimitWarning}文字の上限を超過`
                : `Over the ${settings?.charLimitWarning}-character limit`}
            </span>
            <button
              onClick={() => setShowCharLimit(false)}
              className="text-ink-faint hover:text-ink"
              aria-label={t("Close over-limit paragraph list")}
            >
              ×
            </button>
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {overLimitChunks.map((oc) => {
              const c = chunks.find((x) => x.id === oc.id);
              const preview = (c?.content.trim().replace(/\s+/g, " ") || "(empty)").slice(0, 60);
              return (
                <li key={oc.id}>
                  <button
                    onClick={() => {
                      setFocused(oc.id);
                      flashChunk(oc.id);
                      setShowCharLimit(false);
                    }}
                    className="w-full rounded px-2 py-1 text-left text-xs text-ink-soft hover:bg-amber-50"
                    title={t("Jump to this paragraph")}
                  >
                    <span className="font-medium text-amber-600">{ja ? `${oc.count}文字` : `${oc.count} chars`}</span> —{" "}
                    {preview}
                    {(c?.content.trim().length ?? 0) > 60 ? "…" : ""}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* "Zero external transmission" visibility (開発.txt Stage 2, item 2-2):
          everything that left this machine this session, split into the two
          real chokepoints — actual LLM calls vs. reference/image fetches —
          so a user can tell them apart instead of one blended number. */}
      {netStats && (
        <span
          className={item}
          title={t("Network calls made this session: LLM requests (ai.rs) and reference/image fetches (net.rs's guarded safe_fetch) are counted separately. Nothing else leaves this machine.")}
        >
          {ja
            ? `外部通信: AI ${netStats.aiCalls}件 · 取得 ${netStats.fetchCalls}件`
            : `External calls: ${netStats.aiCalls} AI · ${netStats.fetchCalls} fetch`}
        </span>
      )}

      <span className="flex-1" />

      {speaking && <span className={`${item} text-accent`}>{t("Reading aloud…")}</span>}
      {globalBusy && <span className={`${item} text-accent`}>{globalBusy}</span>}

      {diffPanelOpen && (
        <div className="absolute bottom-8 right-2 z-40">
          <DiffPanel onClose={() => toggleDiffPanel(false)} />
        </div>
      )}

      {/* Last export report (ズレ① visibility): keep omission warnings around. */}
      {lastExportReport && (
        <button
          onClick={() => setShowWarnings((v) => !v)}
          className={`${item} rounded hover:bg-gray-200/70 ${
            lastExportReport.warnings.length ? "text-amber-600" : ""
          }`}
          title={t("Details of the most recent export")}
        >
          {t("Export")} ({lastExportReport.format.toUpperCase()}):{" "}
          {lastExportReport.warnings.length
            ? ja
              ? `警告${lastExportReport.warnings.length}件`
              : `${lastExportReport.warnings.length} warning${
                  lastExportReport.warnings.length === 1 ? "" : "s"
                }`
            : t("clean")}
        </button>
      )}
      {showWarnings && lastExportReport && (
        <div className="absolute bottom-8 right-2 z-40 w-96 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ink">
            <span>
              {t("Last export")} — {lastExportReport.format.toUpperCase()} (
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
            <p className="text-xs text-ink-soft">{t("No warnings — nothing was omitted.")}</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
              {lastExportReport.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Review-criteria coverage panel (開発.txt Stage 2, item 2-1, Part B):
          opened via the command palette; this is its only mount point (it's
          `fixed`-positioned and self-hides when closed via its own store),
          since App.tsx's docked-panel layout is outside this feature's owned
          files. */}
      <CriteriaPanel />
      {/* Personal RAG library panel (開発.txt Stage 3, item 3-1): same
          self-contained, fixed-positioned, self-hiding pattern as
          CriteriaPanel above — opened via the command palette. */}
      <PersonalLibraryPanel />
      {/* Citation management panel (開発.txt Stage 3, item 3-2): same
          self-contained, fixed-positioned, self-hiding pattern as
          CriteriaPanel above — opened via the command palette. */}
      <CitationsPanel />
    </div>
  );
}
