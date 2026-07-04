// The per-chunk "✨" AI menu shown in the left gutter (spec §3.2 one-click
// actions). Opens a small popover with context-aware actions.

import { useEffect, useRef, useState } from "react";
import {
  runChunkAction,
  bulletizeChunks,
  generateDiagramFromChunk,
  generatePresentationFromChunk,
} from "../aiActions";
import { staleSummaryChunkIds, useStore } from "../store";
import type { ChunkType } from "../types";
import { promptDialog } from "./PromptModal";
import Tooltip from "./Tooltip";
import {
  BulletListIcon,
  ConcentrateIcon,
  DetailIcon,
  ExpandIcon,
  FlowIcon,
  FocusIcon,
  ImageIcon,
  LanguagesIcon,
  SparklesIcon,
  SpinnerIcon,
  SummaryIcon,
  WandIcon,
} from "./icons";

// Quick-pick proofreading styles. The value is the phrase sent to the model;
// leaving the field blank falls back to a scholarly/academic tone (ai.rs).
const PROOFREAD_STYLES = [
  { label: "Academic", value: "scholarly and academic" },
  { label: "Formal", value: "formal and professional" },
  { label: "Concise", value: "concise and direct" },
  { label: "Plain", value: "plain and easy to read for a general audience" },
  { label: "Persuasive", value: "persuasive and compelling" },
];

/** Compact relative time for the freshness footer ("analyzed 5 min ago"). */
function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

interface Props {
  chunkId: string;
  chunkType: ChunkType;
  busy: boolean;
}

export default function ChunkAiMenu({ chunkId, chunkType, busy }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const defaultLang = useStore((s) => s.settings?.defaultTargetLanguage ?? "English");
  // Bulletize replaces this chunk (a structural edit), so it runs under the
  // document-wide busy flag rather than this chunk's own — block it whenever
  // ANY AI op is in flight rather than risk two structural edits racing.
  const globalBusy = useStore((s) => s.globalBusy);
  // Freshness footer: when the graph was computed + whether it's out of date.
  const analyzedAt = useStore((s) => s.doc.analysis?.analyzedAt);
  const analysisStale = useStore((s) => s.analysisStale);
  // Computed only while the popover is open (it hashes every summarized
  // chunk); excludes this chunk to mirror what runChunkAction will refresh.
  const staleCount = open
    ? staleSummaryChunkIds(useStore.getState().doc).filter((id) => id !== chunkId)
        .length
    : 0;
  const isText = chunkType === "text";
  const isHeading = chunkType === "heading";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => setOpen(false);

  const onTranslate = async () => {
    close();
    const lang = await promptDialog({
      title: "Translate paragraph",
      label: "Target language",
      defaultValue: defaultLang,
      placeholder: "e.g. English, Japanese, French",
      submitLabel: "Translate",
    });
    if (lang === null) return;
    await runChunkAction(chunkId, "translate", { targetLanguage: lang });
  };

  const onProofread = async () => {
    close();
    const style = await promptDialog({
      title: "Proofread",
      label: "Pick a style to rewrite toward (or type your own):",
      presets: PROOFREAD_STYLES,
      defaultValue: "",
      placeholder: "e.g. concise and formal",
      submitLabel: "Proofread",
    });
    if (style === null) return;
    // Blank → backend default (scholarly/academic).
    await runChunkAction(chunkId, "proofread", { style: style || undefined });
  };

  const onSummarize = async () => {
    close();
    await runChunkAction(chunkId, "summarize");
  };

  const onBulletize = async () => {
    close();
    await bulletizeChunks([chunkId]);
  };

  const onExpand = async () => {
    close();
    await runChunkAction(chunkId, "expand");
  };

  const onDetail = async () => {
    close();
    await runChunkAction(chunkId, "detailed");
  };

  const onConcentrate = async () => {
    close();
    await runChunkAction(chunkId, "concentrate");
  };

  const onFocus = async () => {
    close();
    await runChunkAction(chunkId, "focus");
  };

  const onHarmonize = async () => {
    close();
    await runChunkAction(chunkId, "harmonize");
  };

  const onPresentation = async () => {
    close();
    await generatePresentationFromChunk(chunkId);
  };

  const onDiagram = async () => {
    close();
    const instruction = await promptDialog({
      title: "Generate diagram",
      label: "Optional guidance for the diagram (leave blank for automatic)",
      defaultValue: "",
      placeholder: "e.g. as a flowchart of the process",
      submitLabel: "Generate",
    });
    if (instruction === null) return;
    await generateDiagramFromChunk(chunkId, instruction || undefined);
  };

  const onCustom = async () => {
    close();
    const instruction = await promptDialog({
      title: "Custom AI instruction",
      label: "Describe what the AI should do with this paragraph",
      placeholder: "e.g. Rewrite this for a general audience",
      multiline: true,
      submitLabel: "Run",
    });
    if (!instruction) return;
    await runChunkAction(chunkId, "custom", { instruction });
  };

  const item =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink-soft hover:bg-accent/10 hover:text-accent disabled:opacity-40 disabled:hover:bg-transparent";
  // 提案4: the same boxed-cluster pattern as the SlideEditor design group — a
  // bordered rounded box with a tiny uppercase label per action family.
  const group = "rounded-md border border-gray-200 bg-gray-50/60 p-1";
  const groupLabel =
    "px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint";

  // Freshness/status footer (live-context visibility): when the document was
  // last analyzed + how many context summaries the next run will refresh.
  const footer = (isText || isHeading) &&
    (analyzedAt !== undefined || staleCount > 0) && (
      <div className="space-y-0.5 border-t border-gray-100 px-2.5 pb-1 pt-1.5 text-xs">
        {analyzedAt !== undefined && (
          <div className={analysisStale ? "text-amber-600" : "text-ink-faint"}>
            analyzed {relTime(analyzedAt)}
            {analysisStale ? " · graph out of date" : ""}
          </div>
        )}
        {staleCount > 0 && (
          <div className="text-ink-faint">
            {staleCount} context {staleCount === 1 ? "summary" : "summaries"} will
            refresh on run
          </div>
        )}
      </div>
    );

  return (
    <div ref={rootRef} className="relative">
      <Tooltip label={isHeading ? "AI actions for this heading" : "AI actions for this paragraph"}>
        <button
          aria-label="AI actions"
          onClick={() => setOpen((v) => !v)}
          className={`flex h-7 w-7 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent ${
            open ? "bg-accent/10 text-accent" : ""
          }`}
        >
          {busy ? <SpinnerIcon className="text-accent" /> : <SparklesIcon />}
        </button>
      </Tooltip>

      {open && (
        <div className="absolute left-0 top-8 z-30 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
          {isText && (
            <div className="space-y-1">
              <div className={group}>
                <div className={groupLabel}>Rewrite</div>
                <button className={item} onClick={onExpand}>
                  <ExpandIcon /> Expand
                </button>
                <button className={item} onClick={onDetail}>
                  <DetailIcon /> Add detail
                </button>
                <button className={item} onClick={onConcentrate}>
                  <ConcentrateIcon /> Concentrate
                </button>
                <button className={item} onClick={onFocus}>
                  <FocusIcon /> Focus
                </button>
                <button className={item} onClick={onHarmonize}>
                  <ConcentrateIcon /> Revise with context
                </button>
              </div>
              <div className={group}>
                <div className={groupLabel}>Language</div>
                <button className={item} onClick={onTranslate}>
                  <LanguagesIcon /> Translate…
                </button>
                <button className={item} onClick={onProofread}>
                  <WandIcon /> Proofread…
                </button>
              </div>
              <div className={group}>
                <div className={groupLabel}>Summarize</div>
                <button className={item} onClick={onSummarize}>
                  <SummaryIcon /> Summarize
                </button>
                <Tooltip label="Rewrites this paragraph in place as bullet points — replaces its text (⌘/Ctrl+Z to undo).">
                  <button className={item} onClick={onBulletize} disabled={!!globalBusy}>
                    <BulletListIcon /> Bulletize
                  </button>
                </Tooltip>
              </div>
              <div className={group}>
                <div className={groupLabel}>Generate</div>
                <button className={item} onClick={onDiagram}>
                  <FlowIcon /> Generate diagram…
                </button>
                <button className={item} onClick={onPresentation}>
                  <ImageIcon /> Presentation figure
                </button>
              </div>
              <div className={group}>
                <div className={groupLabel}>Custom</div>
                <button className={item} onClick={onCustom}>
                  <SparklesIcon /> Custom instruction…
                </button>
              </div>
              {footer}
            </div>
          )}
          {isHeading && (
            <div className="space-y-1">
              <div className={group}>
                <div className={groupLabel}>Language</div>
                <button className={item} onClick={onTranslate}>
                  <LanguagesIcon /> Translate…
                </button>
                <button className={item} onClick={onProofread}>
                  <WandIcon /> Proofread / rewrite…
                </button>
              </div>
              <div className={group}>
                <div className={groupLabel}>Generate</div>
                <button className={item} onClick={onPresentation}>
                  <ImageIcon /> Presentation figure
                </button>
              </div>
              <div className={group}>
                <div className={groupLabel}>Custom</div>
                <button className={item} onClick={onCustom}>
                  <SparklesIcon /> Custom instruction…
                </button>
              </div>
              {footer}
            </div>
          )}
          {!isText && !isHeading && (
            <div className="px-2.5 py-1.5 text-sm text-ink-faint">
              Edit the Mermaid code below to update this diagram.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
