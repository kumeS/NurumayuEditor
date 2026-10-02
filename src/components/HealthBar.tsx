// Document health bar (提案2): a persistent, one-line status strip. The
// warnings it surfaces — stale AI understanding, export omissions — used to
// exist only as 3.5-second toasts or deep inside the graph panel; here they
// stay visible and clickable.

import { useEffect, useMemo, useState } from "react";
import { analyzeDocument, hasAnalyzableContent } from "../aiActions";
import { api } from "../api";
import { chunksOverCharLimit } from "../charLimitWarnings";
import { changeSummary } from "../diff";
import { localizeExportWarning } from "../exportWarnings";
import { changesLabel, reportLabels } from "../healthLabels";
import { sameNetworkStats } from "../healthBarStats";
import { translateWith, useLang, useT } from "../i18n";
import { staleSummaryChunkIds, useStore } from "../store";
import { documentTextStats, formatLengthDetail, formatLengthLabel } from "../textStats";
import type { NetworkStats } from "../types";
import CitationsPanel from "./CitationsPanel";
import CriteriaPanel from "./CriteriaPanel";
import DiffPanel from "./DiffPanel";
import { HistoryIcon } from "./icons";
import PersonalLibraryPanel from "./PersonalLibraryPanel";

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
  const lang = useLang();
  const ja = lang === "ja";
  const lastExportReport = useStore((s) => s.lastExportReport);
  const doc = useStore((s) => s.doc);
  const savedDoc = useStore((s) => s.savedDoc);
  const diffPanelOpen = useStore((s) => s.diffPanelOpen);
  const toggleDiffPanel = useStore((s) => s.toggleDiffPanel);
  const settings = useStore((s) => s.settings);
  const setFocused = useStore((s) => s.setFocused);
  const flashChunk = useStore((s) => s.flashChunk);
  const aiModelIssue = useStore((s) => s.aiModelIssue);
  const openSettings = useStore((s) => s.openSettings);
  const analyzable = useStore((s) => hasAnalyzableContent(s.doc));
  const [showWarnings, setShowWarnings] = useState(false);
  const [showCharLimit, setShowCharLimit] = useState(false);

  // The changes panel and the export report open at the same anchor: opening
  // the changes panel from anywhere (this bar, toolbar, palette) closes the
  // report, and the report's button closes the changes panel.
  useEffect(() => {
    if (diffPanelOpen) setShowWarnings(false);
  }, [diffPanelOpen]);

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
        // Keep the previous object when nothing changed (BUG-006 step 2), so an
        // idle poll does not re-render the bar.
        if (!cancelled) setNetStats((prev) => (sameNetworkStats(prev, stats) ? prev : stats));
      });
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const { textStats, staleCount, changes } = useMemo(
    () => ({
      // Text/heading chunks only; the unit (文字 vs 語) follows the CJK share.
      textStats: documentTextStats(chunks),
      staleCount: staleSummaryChunkIds(doc).length,
      // Item 1-2 / BUG-015b: what kind of change is unsaved (paragraphs,
      // title, order/analysis/metadata), memoized like the counts above — the
      // word-level diff is only computed inside DiffPanel when it's open.
      changes: changeSummary(savedDoc, doc),
    }),
    [chunks, doc, savedDoc]
  );
  const hasChanges = changes.paragraphs > 0 || changes.titleChanged || changes.otherChanged;
  const report = lastExportReport ? reportLabels(lastExportReport.format, lang) : null;

  // Grant-application beachhead (開発.txt Stage 2, item 2-1), Part A: which
  // paragraphs currently exceed the user-configured character limit. []
  // (nothing rendered) whenever the setting is unset — opt-in, no clutter for
  // users who never configured a limit.
  const overLimitChunks = useMemo(
    () => chunksOverCharLimit(chunks, settings?.charLimitWarning),
    [chunks, settings?.charLimitWarning]
  );

  const analyzedAt = analysis?.analyzedAt;
  // One line, never wrapped: squeezed CJK labels would otherwise break per
  // character inside the 28px strip. Status items hold their width; the two
  // informational counts (length, network) give way with an ellipsis and keep
  // their full text in the tooltip.
  const item = "flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2";
  const shrinkItem = "flex min-w-0 items-center gap-1.5 whitespace-nowrap px-2";

  return (
    <div className="relative flex h-7 shrink-0 items-center border-t border-chrome-line bg-chrome/80 px-2 text-[11px] text-ink-faint">
      {/* Save state */}
      <span className={item} title={dirty ? t("Unsaved changes (⌘S to save)") : t("All changes saved")}>
        <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-warn-dot" : "bg-ok"}`} />
        {dirty ? t("Unsaved") : t("Saved")}
      </span>

      <span
        className={shrinkItem}
        title={`${formatLengthDetail(textStats, lang)} — ${t("Characters exclude spaces; diagrams and images are not counted.")}`}
      >
        <span className="truncate">{formatLengthLabel(textStats, chunks.length, lang)}</span>
      </span>

      {/* "Changes since last save" (item 1-2): the at-a-glance weekly-progress
          view — click opens DiffPanel. The label comes from changeSummary +
          changesLabel, so it never says "no changes" while dirty (BUG-015b). */}
      <button
        onClick={() => toggleDiffPanel()}
        aria-expanded={diffPanelOpen}
        className={`${item} rounded hover:bg-chrome-line/70 ${hasChanges ? "text-warn" : ""}`}
        title={t("Show paragraphs added, removed, or changed since the document was last saved")}
      >
        <HistoryIcon className="h-3 w-3" />
        {changesLabel(changes, dirty, lang)}
      </button>

      {/* AI understanding freshness (ズレ②): when was Analyze last run, is the
          graph stale, and how many summaries will refresh on the next AI run.
          Disabled, with the reason as its tooltip, while the document has no
          text to analyze (BUG-015a). */}
      <button
        onClick={() => void analyzeDocument()}
        disabled={!analyzable}
        className={`${item} rounded hover:bg-chrome-line/70 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${
          analysisStale ? "text-warn" : ""
        }`}
        title={
          !analyzable
            ? t("Nothing to analyze yet — write some text first.")
            : analysis
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
      {/* The configured model was reported unusable by the provider (BUG-013c):
          persistent until a different model is saved (store.setSettings
          clears aiModelIssue), with a one-click path to Settings. */}
      {aiModelIssue && (
        <span
          className={`${item} text-danger`}
          title={t("The provider could not serve this model in the last AI request. Choose another model.")}
        >
          {translateWith("Model unavailable: {model}", lang, { model: aiModelIssue.model })}
          <button
            onClick={openSettings}
            className="rounded px-1 font-medium underline hover:bg-chrome-line/70"
          >
            {t("Open Settings")}
          </button>
        </span>
      )}
      {staleCount > 0 && (
        <span
          className={`${item} text-warn`}
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
          aria-expanded={showCharLimit}
          className={`${item} rounded text-warn hover:bg-chrome-line/70`}
          title={translateWith(
            "{n} paragraph(s) over the {limit}-character limit set in Settings — click to list them",
            lang,
            { n: overLimitChunks.length, limit: settings?.charLimitWarning ?? "" }
          )}
        >
          {ja
            ? `${overLimitChunks.length}段落が文字数超過`
            : `${overLimitChunks.length} paragraph${overLimitChunks.length === 1 ? "" : "s"} over limit`}
        </button>
      )}
      {showCharLimit && overLimitChunks.length > 0 && (
        <div className="absolute bottom-8 left-2 z-40 w-80 rounded-lg border border-chrome-line bg-white p-3 shadow-xl">
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
              title={t("Close")}
            >
              ×
            </button>
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {overLimitChunks.map((oc) => {
              const c = chunks.find((x) => x.id === oc.id);
              const preview = (c?.content.trim().replace(/\s+/g, " ") || t("(empty)")).slice(0, 60);
              return (
                <li key={oc.id}>
                  <button
                    onClick={() => {
                      setFocused(oc.id);
                      flashChunk(oc.id);
                      setShowCharLimit(false);
                    }}
                    className="w-full rounded px-2 py-1 text-left text-xs text-ink-soft hover:bg-warn-wash"
                    title={t("Jump to this paragraph")}
                  >
                    <span className="font-medium text-warn">{ja ? `${oc.count}文字` : `${oc.count} chars`}</span> —{" "}
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
          the two counted chokepoints — LLM calls (ai.rs) vs. net.rs safe_fetch
          (reference pages, images, citation lookups, the OpenRouter model
          list) — shown apart. The tooltip names known uncounted traffic
          (webview-loaded remote images, the embedding-model download) instead
          of claiming nothing else leaves the machine. */}
      {netStats && (
        <span
          className={shrinkItem}
          title={t("Network calls this session, counted separately: LLM requests (ai.rs), and fetches through net.rs's guarded safe_fetch — reference pages, images, citation lookups and the OpenRouter model list. Not counted, for example: images shown straight from a web address, and the one-time download of the personal library's embedding model.")}
        >
          <span className="truncate">
            {ja
              ? `外部通信: AI ${netStats.aiCalls}件 · 取得 ${netStats.fetchCalls}件`
              : `External calls: ${netStats.aiCalls} AI · ${netStats.fetchCalls} fetch`}
          </span>
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

      {/* Last export report (ズレ① visibility): keep omission warnings around.
          A draft report (format "draft") shares the slot and gets its own label;
          Rust's English warnings are localized at render time. */}
      {lastExportReport && report && (
        <button
          onClick={() => {
            toggleDiffPanel(false);
            setShowWarnings((v) => !v);
          }}
          aria-expanded={showWarnings}
          className={`${item} rounded hover:bg-chrome-line/70 ${
            lastExportReport.warnings.length ? "text-warn" : ""
          }`}
          title={t("Details of the most recent export")}
        >
          {report.button}:{" "}
          {lastExportReport.warnings.length
            ? ja
              ? `警告${lastExportReport.warnings.length}件`
              : `${lastExportReport.warnings.length} warning${
                  lastExportReport.warnings.length === 1 ? "" : "s"
                }`
            : t("clean")}
        </button>
      )}
      {showWarnings && lastExportReport && report && (
        <div className="absolute bottom-8 right-2 z-40 w-96 rounded-lg border border-chrome-line bg-white p-3 shadow-xl">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-ink">
            <span>
              {report.heading} ({relative(lastExportReport.at, ja)})
            </span>
            <button
              onClick={() => setShowWarnings(false)}
              className="text-ink-faint hover:text-ink"
              aria-label={t("Close")}
              title={t("Close")}
            >
              ×
            </button>
          </div>
          {lastExportReport.warnings.length === 0 ? (
            <p className="text-xs text-ink-soft">{t("No warnings — nothing was omitted.")}</p>
          ) : (
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
              {lastExportReport.warnings.map((w, i) => (
                <li key={i}>{localizeExportWarning(w, lang)}</li>
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
