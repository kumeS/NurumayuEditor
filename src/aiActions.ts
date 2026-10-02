// High-level AI orchestration shared by the toolbar and per-chunk menus.
// Each function manages busy state, gathers surrounding-chunk context, calls the
// Rust command, applies the result to the store, and surfaces errors as toasts.
//
// Invariants (BUG-001b / MISS-01 / UX-errors-en / BUG-013c):
// - Every action captures an `OpTicket` (captureOp) when invoked and commits
//   ONLY while `ownsOp(op)` holds — same tab AND same document load. Chunk ids
//   are persisted UUIDs, so id existence alone cannot tell a reopened copy
//   apart. Actions that overwrite paragraph text (runChunkAction, bulletize,
//   the context-summary refresh) also require the text to equal what was sent.
// - Busy/stream flags keep routing to the originating tab (routeTabPatch).
// - Each op that reaches the backend logs exactly one `start` and one `commit`
//   or `discard` (with a machine-readable reason) to the store's aiOpLog: ids
//   and reason codes only, never content. The context-summary refresh inside
//   an action is not logged separately.
// - Backend errors are shown through localizeAiError (UI language); only the
//   "model-unavailable" kind flags `aiModelIssue`.
// - Busy labels are stored ALREADY TRANSLATED (tNow/tf) in `globalBusy`, so
//   every surface renders the string as-is. A language switch mid-operation
//   keeps the old label until the op ends.

import { api } from "./api";
import { localizeAiError } from "./aiErrors";
import { validateMermaid } from "./mermaidRender";
import { groupSlides, slideBullets, slideImages, slideTitle } from "./slides";
import { tf, tNow, uiLangFor } from "./i18n";
import {
  captureOp,
  ownsOp,
  staleSummaryChunkIds,
  useStore,
  type AiOpLogEntry,
  type OpTicket,
} from "./store";
import type { AiAction, Chunk, Document, RagSearchHit, SlideLayout } from "./types";

// T1 — whole-document context assembly.
const LINKED_MAX_CHARS = 2500;
// Chunks with no summary contribute this many leading content chars to the doc
// map instead, so the outline covers EVERY chunk (nothing silently omitted).
const MAP_SNIPPET_CHARS = 120;

// Personal RAG (開発.txt Stage 3, item 3-1) grounding.
const RAG_TOP_K = 3;

/**
 * Assemble the context an AI action gets for a chunk. Beyond the immediate
 * preceding/following prose (spec §3.1), this now makes the model
 * document-aware (T1): the SECTION the chunk lives under, a compact outline of
 * the whole document (headings + per-chunk summaries), and the full text of any
 * graph-linked chunks. This turns the latent summary/linkedChunks data — until
 * now computed and saved but never fed back into editing — into editing context.
 */
function gatherContext(chunkId: string): {
  chunk: Chunk | undefined;
  before?: string;
  after?: string;
  sectionHeading?: string;
  documentMap?: string;
  linkedContent?: string;
} {
  const chunks = useStore.getState().doc.chunks;
  const idx = chunks.findIndex((c) => c.id === chunkId);
  const chunk = chunks[idx];
  if (!chunk) return { chunk };

  // Nearest preceding/following *text* chunk supplies immediate context (§3.1).
  let before: string | undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (chunks[i].metadata.chunkType === "text" && chunks[i].content.trim()) {
      before = chunks[i].content;
      break;
    }
  }
  let after: string | undefined;
  for (let i = idx + 1; i < chunks.length; i++) {
    if (chunks[i].metadata.chunkType === "text" && chunks[i].content.trim()) {
      after = chunks[i].content;
      break;
    }
  }

  // The section: nearest preceding heading.
  let sectionHeading: string | undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (chunks[i].metadata.chunkType === "heading" && chunks[i].content.trim()) {
      sectionHeading = chunks[i].content.trim();
      break;
    }
  }

  // A whole-document outline covering EVERY chunk (live context): headings as
  // #/##/### lines, summarized chunks as their summary, and chunks WITHOUT a
  // summary as their first ~120 content chars — so nothing is silently missing
  // from the map the model sees.
  const lines: string[] = [];
  let hasContext = false;
  for (let i = 0; i < chunks.length; i++) {
    if (i === idx) {
      lines.push("- «the paragraph you are editing»");
      continue;
    }
    const c = chunks[i];
    let line: string | null = null;
    if (c.metadata.chunkType === "heading" && c.content.trim()) {
      const lvl = "#".repeat(Math.min(3, Math.max(1, c.metadata.level ?? 1)));
      line = `${lvl} ${c.content.trim()}`;
    } else if (c.metadata.summary && c.metadata.summary.trim()) {
      line = `- ${c.metadata.summary.trim()}`;
    } else {
      const text = c.content.trim().replace(/\s+/g, " ");
      if (text) {
        line = `- ${
          text.length > MAP_SNIPPET_CHARS
            ? `${text.slice(0, MAP_SNIPPET_CHARS)}…`
            : text
        }`;
      }
    }
    if (line) {
      lines.push(line);
      hasContext = true;
    }
  }
  const documentMap = hasContext ? lines.join("\n") : undefined;

  // Full content of graph-linked chunks (the supporting/related material).
  let linkedContent: string | undefined;
  const linked = chunk.metadata.linkedChunks ?? [];
  if (linked.length) {
    const byId = new Map(chunks.map((c) => [c.id, c]));
    const parts: string[] = [];
    let chars = 0;
    for (const id of linked) {
      const lc = byId.get(id);
      if (!lc || lc.id === chunkId || !lc.content.trim()) continue;
      const snippet = lc.content.trim().slice(0, 800);
      if (chars + snippet.length > LINKED_MAX_CHARS) break;
      parts.push(snippet);
      chars += snippet.length;
    }
    if (parts.length) linkedContent = parts.join("\n\n---\n\n");
  }

  return { chunk, before, after, sectionHeading, documentMap, linkedContent };
}

/**
 * Personal RAG (開発.txt Stage 3, item 3-1) — companion to `gatherContext`,
 * called separately (and only conditionally) so a disabled/unused personal
 * library adds ZERO overhead: when `personalRagEnabled` is off, this returns
 * `[]` WITHOUT attempting any query at all (no `rag_search` invoke, no
 * `rag_list_sources` invoke either — the setting check short-circuits first).
 *
 * Query text is the chunk's own current content when non-empty, falling back
 * to the nearest section heading (e.g. for an empty paragraph the user is
 * about to draft into) — simple and fast, per the task's guidance, rather
 * than a fancier query-rewrite step.
 *
 * Returns the top few matches (source file path + matched snippet) for the
 * caller to attach as grounding context and to later surface as "grounded by"
 * citations near the result (see the per-action UI that applies the AI
 * result).
 */
export async function gatherRagSnippets(
  chunkId: string,
  sectionHeading?: string
): Promise<RagSearchHit[]> {
  const s = useStore.getState();
  if (!s.settings?.personalRagEnabled) return [];

  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  const query = (chunk?.content.trim() || sectionHeading?.trim()) ?? "";
  if (!query) return [];

  try {
    // An empty personal library must not even attempt a search — checking the
    // source list first (rather than only catching a search error) keeps this
    // an explicit no-op rather than relying on `rag_search`'s own empty-index
    // short-circuit (rag.rs's `index_exists` guard) as the ONLY signal.
    const sources = await api.ragListSources();
    if (sources.length === 0) return [];
    return await api.ragSearch(query, RAG_TOP_K);
  } catch {
    // Grounding is a best-effort enhancement, never a blocker: any failure
    // (feature toggled off mid-flight, index error, etc.) just means no
    // snippets are attached — the AI action proceeds without RAG context
    // rather than failing the whole action over an optional enhancement.
    return [];
  }
}

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * Show an AI/provider failure in the UI language (aiErrors.ts). Flags the
 * configured model as unusable ONLY for the "model-unavailable" kind. Returns
 * the machine-readable discard reason for the op log (never the message: the
 * provider detail can echo content).
 */
function notifyAiError(e: unknown): string {
  const s = useStore.getState();
  const err = localizeAiError(message(e), uiLangFor(s.settings?.defaultTargetLanguage));
  if (err.kind === "model-unavailable" && err.model) s.setAiModelIssue({ model: err.model });
  s.notify(err.text, "error");
  return `error:${err.kind}`;
}

// ---- Op ownership + correlation log (BUG-001b, MISS-01) --------------------

type OpPhase = AiOpLogEntry["phase"];

function logOp(op: OpTicket, phase: OpPhase, action: string, chunkId?: string, reason?: string): void {
  useStore.getState().logAiOp({
    opId: op.opId,
    phase,
    action,
    tabId: op.tabId,
    docNonce: op.docNonce,
    ...(chunkId !== undefined ? { chunkId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

/** Why `op` may no longer commit: null while it still owns the active load. */
function staleReason(op: OpTicket): "tab-changed" | "doc-changed" | null {
  if (ownsOp(op)) return null;
  return useStore.getState().activeTabId !== op.tabId ? "tab-changed" : "doc-changed";
}

/** Current content of `chunkId` in the active document (undefined if gone). */
function chunkContent(chunkId: string): string | undefined {
  return useStore.getState().doc.chunks.find((c) => c.id === chunkId)?.content;
}

/**
 * The op log as JSON lines (oldest first), for the NetworkPanel Copy button —
 * a QA report attachment. Entries hold ids and reason codes only.
 */
export function aiOpLogToJsonLines(entries: readonly AiOpLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

/**
 * Whether Analyze has anything to send: some text/heading chunk with non-blank
 * content. Conservative w.r.t. ai.rs `analysis_listing` (which also skips a
 * chunk whose first 800 chars are blank): when this is false the backend would
 * return an empty result without a network call anyway (aiActionsWiring.test).
 */
export function hasAnalyzableContent(doc: Document): boolean {
  return doc.chunks.some(
    (c) =>
      (c.metadata.chunkType === "text" || c.metadata.chunkType === "heading") &&
      c.content.trim() !== ""
  );
}

/** Last path segment (works for both '/' and '\' separators), for a compact
 * "Grounded from: x, y" notice rather than full absolute paths. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Personal RAG (開発.txt Stage 3, item 3-1), Part B: after an AI action that
 * attached personal-library grounding completes, tell the user which source
 * file(s) it came from — grounding is otherwise invisible once folded into the
 * prompt. A no-op when `hits` is empty (nothing was attached), so ungrounded
 * actions are unaffected. Deduplicates by source path (a chunk's top-K matches
 * can include multiple passages from the same file) and keeps the notice
 * short (basenames only, via the same "info" toast every other transient
 * status uses — see `runChunkAction`'s own notify calls).
 */
export function notifyRagSources(hits: RagSearchHit[]): void {
  if (hits.length === 0) return;
  const names = Array.from(new Set(hits.map((h) => baseName(h.sourcePath))));
  useStore.getState().notify(tf("Grounded from: {names}", { names: names.join(", ") }), "info");
}

/** Endpoints served from the local machine (e.g. Ollama) don't need an API key. */
function isLocalEndpoint(endpoint: string | undefined): boolean {
  const e = (endpoint ?? "").toLowerCase();
  return (
    e.includes("localhost") ||
    e.includes("127.0.0.1") ||
    e.includes("0.0.0.0") ||
    e.includes("[::1]")
  );
}

/**
 * Whether AI calls can proceed: a key is set, OR the endpoint is a local
 * (keyless) provider such as Ollama. Used to gate every AI action.
 */
export function aiReady(): boolean {
  const s = useStore.getState();
  return s.hasApiKey || isLocalEndpoint(s.settings?.endpoint);
}

// ---- Frontend cancel (item 22) --------------------------------------------
// Cancellation and busy/stream ownership are keyed by OP (state-async-2), not
// by chunk id. NOTE: the HTTP request itself is NOT aborted backend-side
// (v2.x) — the Rust command runs to completion; cancelling stops painting
// stream deltas and discards the final result when it arrives.
//   - `chunkOwner` maps (tab, chunk) → the opId of the NEWEST action started on
//     that chunk. A newer action supersedes an older one: the older op is then
//     treated as canceled (never commits, never paints).
//   - `canceledOps` holds the opIds the user stopped. A new action never clears
//     another op's mark, so Stop → new action can't revive the stopped result.
//   - Only the owning op clears the chunk's busy/stream UI in its `finally`,
//     so a late stopped op can't wipe a newer op's spinner and stream.
const chunkOwner = new Map<string, number>();
const canceledOps = new Set<number>();
const ownerKey = (tabId: string, chunkId: string) => `${tabId}\u0000${chunkId}`;

/** Record `op` as the newest action on `chunkId` (supersedes any older op). */
function claimChunk(op: OpTicket, chunkId: string): void {
  chunkOwner.set(ownerKey(op.tabId, chunkId), op.opId);
}

/** Why `op` must not commit/paint on `chunkId`: the user stopped it, or a
 *  newer action on the same chunk superseded it. Null while it may proceed. */
function chunkOpCanceled(op: OpTicket, chunkId: string): "canceled" | "superseded" | null {
  if (canceledOps.has(op.opId)) return "canceled";
  return chunkOwner.get(ownerKey(op.tabId, chunkId)) !== op.opId ? "superseded" : null;
}

/** End `op`'s claim. True when it still owned the chunk, i.e. it may clear
 *  the chunk's busy/stream UI. */
function releaseChunk(op: OpTicket, chunkId: string): boolean {
  canceledOps.delete(op.opId);
  const key = ownerKey(op.tabId, chunkId);
  if (chunkOwner.get(key) !== op.opId) return false;
  chunkOwner.delete(key);
  return true;
}

/** Stop the in-flight AI action on a chunk and clear its busy/streaming UI. */
export function cancelChunkAction(chunkId: string): void {
  const st = useStore.getState();
  const owner = chunkOwner.get(ownerKey(st.activeTabId, chunkId));
  if (owner !== undefined) canceledOps.add(owner);
  // The Stop affordance only renders on the ACTIVE tab's chunk, so clearing
  // the active tab's in-flight state here is safe.
  if (st.streamingChunkId === chunkId) st.endChunkStream();
  st.setBusyChunk(chunkId, false);
}

/**
 * Parse an LLM reply into bullet strings, tolerantly: strips code fences,
 * drops preamble/postamble lines (blank or ending with ':'), and accepts '-',
 * '•', '*', '–' and numbered ("1." / "1)") markers. If NOTHING in the reply is
 * bullet-shaped, every remaining non-empty line is used instead — a model that
 * answered without markers still yields usable bullets.
 */
export function parseBulletLines(raw: string): string[] {
  const lines = raw
    .split("\n")
    .filter((l) => !/^\s*```/.test(l)) // drop code-fence delimiters
    .map((l) => l.trim());
  const bullets: string[] = [];
  for (const line of lines) {
    const m = /^(?:[-•*–]\s*|\d+[.)]\s+)(.+)$/.exec(line);
    if (m && m[1].trim()) bullets.push(m[1].trim());
  }
  if (bullets.length) return bullets;
  // Fallback: no bullet markers at all — keep the content lines, still
  // dropping blanks and lead-in/lead-out lines like "Here are the bullets:".
  return lines.filter((l) => l && !l.endsWith(":"));
}

/**
 * Tolerantly extract the first JSON object from an LLM reply (mirrors the Rust
 * extractor): strip code-fence lines, find the first '{', then scan to its
 * balanced closing '}' — string-aware, so braces inside JSON strings (and
 * escaped quotes) don't fool the depth counter. Returns the parsed value, or
 * null when no parseable object is present.
 */
export function extractJsonObject(raw: string): unknown {
  const text = raw
    .split("\n")
    .filter((l) => !/^\s*```/.test(l)) // drop code-fence delimiters
    .join("\n");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Live context (T2): re-summarize chunks whose `metadata.summary` no longer
 * matches their content (hash mismatch — see `staleSummaryChunkIds`), so the
 * doc map fed to the next AI action reflects the CURRENT text. Sequential, via
 * the same non-streaming call the per-chunk Summarize action uses (deliberately
 * NOT recursing through runChunkAction). Unchanged chunks are never touched —
 * the hash equality short-circuits them. A failed chunk keeps its stale
 * summary; one info toast covers all failures. Stops as soon as `op` no longer
 * owns the active load, and never stamps a summary onto text that changed
 * while it was being summarized (BUG-001b).
 */
async function refreshStaleSummaries(
  excludeId: string | null,
  op: OpTicket
): Promise<void> {
  const tab = op.tabId;
  const st = useStore.getState();
  if (!aiReady()) return;
  const staleIds = staleSummaryChunkIds(st.doc).filter((id) => id !== excludeId);
  if (staleIds.length === 0) return;
  let failed = false;
  try {
    for (let i = 0; i < staleIds.length; i++) {
      const cur = useStore.getState();
      if (!ownsOp(op)) break; // switched tabs / reloaded — stop refreshing
      const c = cur.doc.chunks.find((x) => x.id === staleIds[i]);
      if (!c || !c.content.trim()) continue;
      cur.setGlobalBusy(
        tf("Refreshing AI context ({i}/{n})…", { i: i + 1, n: staleIds.length }),
        tab
      );
      try {
        const summary = await api.aiProcess({
          action: "summarize",
          text: c.content,
          outputLanguage: cur.settings?.defaultTargetLanguage,
          tone: cur.settings?.writingTone || undefined,
        });
        if (!ownsOp(op)) break;
        // setChunkSummary re-stamps summaryHash, marking the chunk fresh — so
        // only for the text that was actually summarized.
        if (chunkContent(staleIds[i]) !== c.content) continue;
        useStore.getState().setChunkSummary(staleIds[i], summary);
      } catch {
        failed = true; // continue with the stale summary
      }
    }
  } finally {
    useStore.getState().setGlobalBusy(null, tab);
  }
  if (failed) {
    useStore
      .getState()
      .notify(tNow("Some context summaries could not be refreshed"), "info");
  }
}

/**
 * Rewrite one or more paragraphs' prose into concise bullet points, IN PLACE —
 * replaces the given chunks with one text chunk per bullet (each bullet = its
 * own paragraph/slide line). Unlike `summarizeSlide`, this edits the shared
 * document text itself (also visible in Editor mode for a slide-mode doc), so
 * it's a per-paragraph action (ChunkAiMenu) rather than a slide-toolbar one —
 * keeping it separate from the non-destructive "Summarize → slide" avoids the
 * two reading as one confusingly-overlapping feature.
 */
export async function bulletizeChunks(ids: string[]): Promise<void> {
  const s = useStore.getState();
  if (!ids.length) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const op = captureOp();
  const tab = op.tabId;
  const idSet = new Set(ids);
  // Exactly what is sent — re-read at commit to detect edits made meanwhile.
  const sentTexts = () =>
    useStore
      .getState()
      .doc.chunks.filter((c) => idSet.has(c.id) && c.metadata.chunkType === "text" && c.content.trim())
      .map((c) => c.content.trim());
  const texts = sentTexts();
  if (!texts.length) {
    s.notify(tNow("Nothing to bulletize."), "info");
    return;
  }

  s.setGlobalBusy(tNow("Bulletizing…"), tab);
  logOp(op, "start", "bulletize");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const result = await api.aiProcess({
      action: "custom",
      text: texts.join("\n\n"),
      instruction:
        "Rewrite the text as concise presentation bullet points. Output ONLY the bullets, " +
        "one per line, each starting with '- '. Use 3 to 6 bullets, each a short phrase " +
        "(not a full sentence). Keep the meaning faithful; do not invent facts. No title, no preamble.",
      outputLanguage: s.settings?.defaultTargetLanguage,
      tone: s.settings?.writingTone || undefined,
    });
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — bulletize discarded."), "info");
      return;
    }
    if (sentTexts().join("\n\n") !== texts.join("\n\n")) {
      outcome = { phase: "discard", reason: "text-changed" };
      s.notify(tNow("The paragraph changed while AI was working — result discarded."), "info");
      return;
    }
    const lines = parseBulletLines(result);
    if (!lines.length) {
      s.notify(tNow("The model returned no bullets."), "info");
      return;
    }
    useStore.getState().replaceChunksWithTexts(ids, lines);
    outcome = { phase: "commit" };
    s.notify(tf("Bulletized into {n} points (⌘/Ctrl+Z to undo).", { n: lines.length }), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "bulletize", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

/**
 * Slide AI (Req 2): summarise a slide's linked text into concise bullets and
 * store them as the slide's `slideBody` — "detaching" it from the prose. The
 * editor text is left untouched; the slide now shows this custom summary until
 * re-linked. `leadId` is the slide's lead chunk (heading, else first chunk).
 */
export async function summarizeSlide(textIds: string[], leadId: string): Promise<void> {
  const s = useStore.getState();
  if (!leadId) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const idSet = new Set(textIds);
  const texts = s.doc.chunks
    .filter((c) => idSet.has(c.id) && c.metadata.chunkType === "text" && c.content.trim())
    .map((c) => c.content.trim());
  if (!texts.length) {
    s.notify(tNow("This slide has no text to summarize."), "info");
    return;
  }
  const op = captureOp();
  const tab = op.tabId;
  s.setGlobalBusy(tNow("Summarizing slide…"), tab);
  logOp(op, "start", "summarize-slide", leadId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const result = await api.aiProcess({
      action: "custom",
      text: texts.join("\n\n"),
      // Item 25: presentation-MEANING bullets, not prose compression — a slide
      // states its message first, then what backs it up.
      instruction:
        "Turn the text into presentation slide bullets that carry the slide's meaning. " +
        "The FIRST bullet states the slide's key claim or message; the following bullets give " +
        "the supporting points. Use 3 to 6 bullets. Each bullet is a short parallel phrase of " +
        "at most about 8 words — not a full sentence, no trailing period. Stay faithful to the " +
        "text; do not invent facts. Output ONLY the bullets, one per line, each starting with " +
        "'- '. No title, no preamble.",
      outputLanguage: s.settings?.defaultTargetLanguage,
      tone: s.settings?.writingTone || undefined,
    });
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — summary discarded."), "info");
      return;
    }
    const lines = parseBulletLines(result);
    if (!lines.length) {
      s.notify(tNow("The model returned no summary."), "info");
      return;
    }
    useStore.getState().setSlideBody(leadId, lines);
    outcome = { phase: "commit" };
    s.notify(tf("Slide summarized into {n} points — detached from the text.", { n: lines.length }), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "summarize-slide", leadId, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

/**
 * Slide AI (v1.2): ask the model to pick the best LAYOUT for a slide — the text
 * is never touched; only the layout changes. Sends the slide's title, bullets
 * and image count, asks for exactly one layout token, parses tolerantly (first
 * known layout name in the reply), and applies it via `setChunkLayout` on the
 * slide's layout host (`hostChunkId`) — so it behaves exactly like a manual
 * pick, including undo and the picker's override/"Auto" state.
 */
export async function suggestSlideLayout(hostChunkId: string): Promise<void> {
  const s = useStore.getState();
  if (!hostChunkId) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const slide = groupSlides(s.doc.chunks).find((g) =>
    g.items.some((c) => c.id === hostChunkId)
  );
  if (!slide) return;
  const bullets = slideBullets(slide);
  const text = [
    `Title: ${slideTitle(slide, s.doc.title) || "(none)"}`,
    `Images on the slide: ${slideImages(slide).length}`,
    `Bullets (${bullets.length}):`,
    ...bullets.map((b) => `- ${b}`),
  ].join("\n");
  const op = captureOp();
  const tab = op.tabId;
  s.setGlobalBusy(tNow("Suggesting layout…"), tab);
  logOp(op, "start", "suggest-layout", hostChunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    // No outputLanguage/tone: the reply must be a bare layout token, not prose.
    const result = await api.aiProcess({
      action: "custom",
      text,
      instruction:
        "Choose the best presentation slide layout for the slide described by the text " +
        "(its title, image count and bullet points). Respond with exactly one token: " +
        "section | title-content | title-image | title-image-left | image-top",
    });
    const stale = staleReason(op) ?? (chunkContent(hostChunkId) === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away — layout suggestion discarded."), "info");
      return;
    }
    // Tolerant parse: the FIRST known layout name in the reply. Longest names
    // are probed first so "title-image-left" isn't read as "title-image" (the
    // strict `<` keeps the longer match at the same position).
    const known: SlideLayout[] = [
      "title-image-left",
      "title-image",
      "image-top",
      "title-content",
      "section",
    ];
    const lower = result.toLowerCase();
    let layout: SlideLayout | null = null;
    let at = Infinity;
    for (const l of known) {
      const idx = lower.indexOf(l);
      if (idx >= 0 && idx < at) {
        layout = l;
        at = idx;
      }
    }
    if (!layout) {
      s.notify(tNow("The model didn't name a layout — nothing changed."), "info");
      return;
    }
    useStore.getState().setChunkLayout(hostChunkId, layout);
    outcome = { phase: "commit" };
    s.notify(tf("Layout set to {layout} (pick Auto to clear it).", { layout }), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "suggest-layout", hostChunkId, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

/**
 * Translate / proofread / summarize / custom on a single chunk. Resolves true
 * only when the result was committed; a result is discarded (with a notice and
 * an op-log reason) when the user stopped it, the tab or document load
 * changed, the paragraph was deleted, or its text changed since it was sent.
 */
export async function runChunkAction(
  chunkId: string,
  action: AiAction,
  opts: {
    targetLanguage?: string;
    instruction?: string;
    style?: string;
    /** Internal: editSelection refreshes context ONCE up front, not per chunk. */
    skipContextRefresh?: boolean;
  } = {}
): Promise<boolean> {
  const s = useStore.getState();
  // BUG-001b: the op owns this tab AND this document load; B3: busy/stream
  // mutations are scoped to the originating tab.
  const op = captureOp();
  const tab = op.tabId;
  const target = s.doc.chunks.find((c) => c.id === chunkId);
  if (!target) return false;
  if (!target.content.trim() && action !== "custom") {
    s.notify(tNow("This paragraph is empty."), "info");
    return false;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return false;
  }
  claimChunk(op, chunkId); // a new action supersedes an older in-flight one

  // Live context: bring out-of-date summaries up to date BEFORE building the
  // doc map, so the outline reflects the current text. The target chunk is
  // excluded (its map line is the «editing» marker, not its summary), and the
  // summarize action skips this — it's about to write the summary itself.
  if (action !== "summarize" && !opts.skipContextRefresh) {
    await refreshStaleSummaries(chunkId, op);
  }
  if (!ownsOp(op) || chunkOpCanceled(op, chunkId)) {
    releaseChunk(op, chunkId); // switched away / stopped during the refresh — nothing sent
    return false;
  }

  const { chunk, before, after, sectionHeading, documentMap, linkedContent } =
    gatherContext(chunkId);
  if (!chunk) {
    releaseChunk(op, chunkId);
    return false;
  }

  // Personal RAG (開発.txt Stage 3, item 3-1): attach the top few personal-
  // library matches as grounding context, but ONLY when the setting is on and
  // at least one source is indexed — `gatherRagSnippets` itself is the
  // zero-overhead-when-disabled guard (no query attempted otherwise). The
  // Rust `AiRequest` (ai.rs) reads this field: `context_block` folds every
  // non-empty snippet into a "[From your personal library]" prompt section
  // labeled with its source path, so the model actually sees this grounding
  // text. After the action completes, `notifyRagSources` below tells the user
  // which source file(s) were attached, so grounding is never silent.
  const ragSnippets = await gatherRagSnippets(chunkId, sectionHeading);

  // The exact paragraph text the model rewrites; the commit requires the
  // paragraph to still hold it (never overwrite an edit made meanwhile).
  const sentText = chunk.content;
  const request = {
    action,
    text: sentText,
    contextBefore: before,
    contextAfter: after,
    targetLanguage: opts.targetLanguage,
    style: opts.style,
    instruction: opts.instruction,
    // Pin every non-translate action's output to the configured default
    // language (so e.g. proofreading Japanese text never drifts to English)
    // and apply the global writing tone.
    outputLanguage: s.settings?.defaultTargetLanguage,
    tone: s.settings?.writingTone || undefined,
    // T1: document-wide awareness.
    sectionHeading,
    documentMap,
    linkedContent,
    ragSnippets,
  };

  // Stream every action except "summarize" (which writes metadata, not content).
  const streaming = action !== "summarize";
  s.setBusyChunk(chunkId, true, tab);
  if (streaming) useStore.getState().beginChunkStream(chunkId, tab);
  logOp(op, "start", action, chunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const result = streaming
      ? await api.aiProcessStream(request, (text) => {
          // Only paint while this op still owns the active tab + load AND this
          // is the chunk being streamed — so a backgrounded op can't hijack
          // another tab's live streaming UI (B3), nor a reloaded copy's
          // same-id chunk (BUG-001b) — and the user hasn't hit Stop.
          const st = useStore.getState();
          if (
            ownsOp(op) &&
            st.streamingChunkId === chunkId &&
            !chunkOpCanceled(op, chunkId)
          ) {
            st.updateChunkStream(text);
          }
        })
      : await api.aiProcess(request);
    const canceled = chunkOpCanceled(op, chunkId);
    if (canceled) {
      outcome = { phase: "discard", reason: canceled };
      // A superseded op is silent: the newer action is the one the user wants.
      if (canceled === "canceled") s.notify(tNow("Stopped — result discarded."), "info");
      return false;
    }
    const current = chunkContent(chunkId);
    const stale = staleReason(op) ?? (current === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away from that paragraph — result discarded."), "info");
      return false;
    }
    if (current !== sentText) {
      outcome = { phase: "discard", reason: "text-changed" };
      s.notify(tNow("The paragraph changed while AI was working — result discarded."), "info");
      return false;
    }
    if (action === "summarize") {
      useStore.getState().setChunkSummary(chunkId, result);
      s.notify(tNow("Summary added to paragraph metadata."), "success");
    } else {
      useStore.getState().replaceChunkContent(chunkId, result);
      s.notify(
        action === "translate"
          ? tNow("Translated (⌘/Ctrl+Z to undo).")
          : tNow("Updated (⌘/Ctrl+Z to undo)."),
        "success"
      );
    }
    outcome = { phase: "commit" };
    // Part B: name the source(s) this result was actually grounded against, so
    // personal-library grounding is never silent once folded into the prompt.
    notifyRagSources(ragSnippets);
    return true;
  } catch (e) {
    // A stopped action's late failure isn't news the user needs.
    outcome = { phase: "discard", reason: chunkOpCanceled(op, chunkId) ?? notifyAiError(e) };
    return false;
  } finally {
    logOp(op, outcome.phase, action, chunkId, outcome.reason);
    // B3: clear the stream + busy state on the tab that OWNED this op, whatever
    // tab is active now — routeTabPatch updates the originating tab's snapshot
    // when it's backgrounded, so neither a stuck spinner nor a cleared
    // foreground stream can result. state-async-2: only while this op still
    // owns the chunk — a newer action's UI is never cleared by an older op.
    if (releaseChunk(op, chunkId)) {
      if (streaming) useStore.getState().endChunkStream(tab);
      useStore.getState().setBusyChunk(chunkId, false, tab);
    }
  }
}

/** Generate a Mermaid diagram from a chunk and insert it as a new diagram chunk. */
export async function generateDiagramFromChunk(
  chunkId: string,
  instruction?: string
): Promise<void> {
  const s = useStore.getState();
  const op = captureOp(); // BUG-001b: commit only into this tab + load
  const tab = op.tabId; // B3: keep the chunk's busy state on its own tab
  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk || !chunk.content.trim()) {
    s.notify(tNow("This paragraph is empty."), "info");
    return;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }

  claimChunk(op, chunkId);
  s.setBusyChunk(chunkId, true, tab);
  logOp(op, "start", "diagram", chunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "invalid-result" };
  try {
    let code = await api.aiGenerateDiagram(chunk.content, instruction);
    // Items 27/53: validate the Mermaid BEFORE inserting; one corrective retry
    // that feeds the parse error back to the model.
    let parseError = await validateMermaid(code);
    if (parseError && !chunkOpCanceled(op, chunkId)) {
      const corrective =
        `${instruction ? `${instruction}\n\n` : ""}` +
        `The previous attempt failed to parse with: ${parseError}. ` +
        "Return corrected, valid Mermaid only.";
      code = await api.aiGenerateDiagram(chunk.content, corrective);
      parseError = await validateMermaid(code);
    }
    const canceled = chunkOpCanceled(op, chunkId);
    if (canceled) {
      outcome = { phase: "discard", reason: canceled };
      // A superseded op is silent: the newer action is the one the user wants.
      if (canceled === "canceled") s.notify(tNow("Stopped — diagram discarded."), "info");
      return;
    }
    const stale = staleReason(op) ?? (chunkContent(chunkId) === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away from that paragraph — diagram discarded."), "info");
      return;
    }
    if (parseError) {
      // Behaviour change: previously the broken code was inserted anyway and
      // could only ever render as an error box — now nothing is inserted and
      // the parse error is surfaced instead.
      s.notify(tf("The generated diagram is not valid Mermaid: {error}", { error: parseError }), "error");
      return;
    }
    useStore.getState().insertDiagramAfter(chunkId, code);
    outcome = { phase: "commit" };
    s.notify(tNow("Diagram generated below the paragraph."), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: chunkOpCanceled(op, chunkId) ?? notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "diagram", chunkId, outcome.reason);
    if (releaseChunk(op, chunkId)) useStore.getState().setBusyChunk(chunkId, false, tab);
  }
}

/** Generate an image from one paragraph and insert it as an image chunk below. */
export async function generateImageFromChunk(chunkId: string): Promise<void> {
  const s = useStore.getState();
  const op = captureOp(); // BUG-001b: commit only into this tab + load
  const tab = op.tabId; // B3: keep the chunk's busy state on its own tab
  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk || !chunk.content.trim()) {
    s.notify(tNow("This paragraph is empty."), "info");
    return;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  claimChunk(op, chunkId);
  s.setBusyChunk(chunkId, true, tab);
  logOp(op, "start", "image", chunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const url = await api.aiGenerateImage(chunk.content);
    const canceled = chunkOpCanceled(op, chunkId);
    if (canceled) {
      outcome = { phase: "discard", reason: canceled };
      // A superseded op is silent: the newer action is the one the user wants.
      if (canceled === "canceled") s.notify(tNow("Stopped — image discarded."), "info");
      return;
    }
    const stale = staleReason(op) ?? (chunkContent(chunkId) === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away from that paragraph — image discarded."), "info");
      return;
    }
    useStore.getState().insertImageAfter(chunkId, url, chunk.content);
    outcome = { phase: "commit" };
    s.notify(tNow("Image generated below the paragraph."), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: chunkOpCanceled(op, chunkId) ?? notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "image", chunkId, outcome.reason);
    if (releaseChunk(op, chunkId)) useStore.getState().setBusyChunk(chunkId, false, tab);
  }
}

/** Generate one image from all currently selected paragraphs (combined prompt). */
export async function generateImageFromSelection(): Promise<void> {
  const s = useStore.getState();
  const ids = s.selectedChunkIds;
  if (ids.length === 0) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const selectedInOrder = s.doc.chunks.filter((c) => ids.includes(c.id));
  const prompt = selectedInOrder
    .filter(
      (c) =>
        c.metadata.chunkType === "text" || c.metadata.chunkType === "heading"
    )
    .map((c) => c.content)
    .join("\n\n")
    .trim();
  if (!prompt) {
    s.notify(tNow("Select one or more text paragraphs first."), "info");
    return;
  }
  const insertAfterId = selectedInOrder[selectedInOrder.length - 1]?.id ?? null;
  const op = captureOp(); // BUG-001b: commit only into this tab + load
  const tab = op.tabId;
  s.setGlobalBusy(tNow("Generating image…"), tab);
  logOp(op, "start", "image-selection");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const url = await api.aiGenerateImage(prompt);
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — image discarded."), "info");
      return;
    }
    useStore.getState().insertImageAfter(insertAfterId, url, prompt);
    useStore.getState().clearSelection();
    outcome = { phase: "commit" };
    s.notify(tNow("Image generated from selection."), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "image-selection", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

/** A presentation-style prompt wrapper: ask the image model for a clean diagram. */
function presentationPrompt(text: string): string {
  return (
    "A clean, minimal presentation slide diagram that visually explains the following content. " +
    "Use a simple flat design with clear labels, boxes and arrows, generous white space, a " +
    "restrained professional colour palette, and NO photorealism. Content to illustrate:\n\n" +
    text.trim()
  );
}

/**
 * Generate a simple presentation-style figure (a diagram-like image) from a
 * paragraph and insert it as an image chunk below. Distinct from a literal
 * image: it asks the model for an explanatory slide graphic.
 */
export async function generatePresentationFromChunk(chunkId: string): Promise<void> {
  const s = useStore.getState();
  const op = captureOp(); // BUG-001b: commit only into this tab + load
  const tab = op.tabId; // B3: keep the chunk's busy state on its own tab
  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk || !chunk.content.trim()) {
    s.notify(tNow("This paragraph is empty."), "info");
    return;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const prompt = presentationPrompt(chunk.content);
  claimChunk(op, chunkId);
  s.setBusyChunk(chunkId, true, tab);
  logOp(op, "start", "presentation-figure", chunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const url = await api.aiGenerateImage(prompt);
    const canceled = chunkOpCanceled(op, chunkId);
    if (canceled) {
      outcome = { phase: "discard", reason: canceled };
      // A superseded op is silent: the newer action is the one the user wants.
      if (canceled === "canceled") s.notify(tNow("Stopped — figure discarded."), "info");
      return;
    }
    const stale = staleReason(op) ?? (chunkContent(chunkId) === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away from that paragraph — figure discarded."), "info");
      return;
    }
    useStore.getState().insertImageAfter(chunkId, url, prompt);
    outcome = { phase: "commit" };
    s.notify(tNow("Presentation figure generated below the paragraph."), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: chunkOpCanceled(op, chunkId) ?? notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "presentation-figure", chunkId, outcome.reason);
    if (releaseChunk(op, chunkId)) useStore.getState().setBusyChunk(chunkId, false, tab);
  }
}

/**
 * Regenerate an image chunk from its stored prompt and save the result as a new
 * version in the chunk's history (the user can swap between alternatives).
 */
export async function regenerateImageChunk(chunkId: string): Promise<void> {
  const s = useStore.getState();
  const op = captureOp(); // BUG-001b: commit only into this tab + load
  const tab = op.tabId; // B3: keep the chunk's busy state on its own tab
  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk || chunk.metadata.chunkType !== "image") return;
  const prompt = chunk.metadata.imagePrompt || chunk.metadata.summary || "";
  if (!prompt.trim()) {
    s.notify(tNow("No source prompt is stored for this image."), "info");
    return;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  claimChunk(op, chunkId);
  s.setBusyChunk(chunkId, true, tab);
  logOp(op, "start", "regenerate-image", chunkId);
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const url = await api.aiGenerateImage(prompt);
    const canceled = chunkOpCanceled(op, chunkId);
    if (canceled) {
      outcome = { phase: "discard", reason: canceled };
      // A superseded op is silent: the newer action is the one the user wants.
      if (canceled === "canceled") s.notify(tNow("Stopped — regenerated image discarded."), "info");
      return;
    }
    const stale = staleReason(op) ?? (chunkContent(chunkId) === undefined ? "chunk-missing" : null);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched away — regenerated image discarded."), "info");
      return;
    }
    // replaceChunkContent stores the previous URL in history, so every
    // alternative stays selectable.
    useStore.getState().replaceChunkContent(chunkId, url);
    outcome = { phase: "commit" };
    s.notify(tNow("New image version generated."), "success");
  } catch (e) {
    outcome = { phase: "discard", reason: chunkOpCanceled(op, chunkId) ?? notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "regenerate-image", chunkId, outcome.reason);
    if (releaseChunk(op, chunkId)) useStore.getState().setBusyChunk(chunkId, false, tab);
  }
}

/**
 * Apply one instruction to every selected text/heading chunk at once (multi-
 * paragraph editing). Each paragraph keeps its surrounding context and its prior
 * version in history. Runs sequentially to respect provider rate limits. Each
 * paragraph is its own runChunkAction op (own ownership/text check and log
 * pair); the pass stops once its tab or document load is gone, and the final
 * toast counts only the paragraphs actually rewritten.
 */
export async function editSelection(instruction: string): Promise<void> {
  const s = useStore.getState();
  const ids = s.selectedChunkIds;
  if (ids.length === 0) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const text = instruction.trim();
  if (!text) return;
  // Process selected chunks in document order; skip non-text chunks.
  const ordered = s.doc.chunks.filter(
    (c) =>
      ids.includes(c.id) &&
      (c.metadata.chunkType === "text" || c.metadata.chunkType === "heading") &&
      c.content.trim()
  );
  if (ordered.length === 0) {
    s.notify(tNow("Select one or more non-empty text paragraphs first."), "info");
    return;
  }
  const op = captureOp(); // the pass as a whole belongs to this tab + load
  const tab = op.tabId;
  // Live context: refresh out-of-date summaries ONCE up front (not per chunk) —
  // every paragraph edited in this pass shares the same refreshed doc map.
  await refreshStaleSummaries(null, op);
  s.setGlobalBusy(tf("Editing {n} paragraphs…", { n: ordered.length }), tab);
  let processed = 0;
  let edited = 0;
  try {
    for (const c of ordered) {
      if (!ownsOp(op)) break;
      const committed = await runChunkAction(c.id, "custom", {
        instruction: text,
        skipContextRefresh: true,
      });
      processed += 1;
      if (committed) edited += 1;
      useStore
        .getState()
        .setGlobalBusy(tf("Editing {done}/{n}…", { done: processed, n: ordered.length }), tab);
    }
    if (ownsOp(op)) {
      useStore.getState().clearSelection();
      s.notify(
        edited === 1 ? tNow("Edited 1 paragraph.") : tf("Edited {n} paragraphs.", { n: edited }),
        edited > 0 ? "success" : "info"
      );
    }
  } finally {
    useStore.getState().setGlobalBusy(null, tab);
  }
}

/**
 * Pick the voice for read-aloud. The user's default output language wins (item
 * 36 — a deliberate setting beats per-paragraph guessing); script detection is
 * the fallback for unset/unmapped languages so e.g. Japanese isn't read with an
 * English voice. Returns undefined (system default) for Latin text. Rust
 * verifies the voice is installed and falls back if not.
 */
const LANGUAGE_VOICES: Record<string, string | undefined> = {
  Japanese: "Kyoko",
  Korean: "Yuna",
  Chinese: "Tingting",
  English: undefined, // system default reads English well
};

function voiceForText(text: string): string | undefined {
  const language = useStore.getState().settings?.defaultTargetLanguage;
  if (language && language in LANGUAGE_VOICES) return LANGUAGE_VOICES[language];
  if (/[぀-ヿ]/.test(text)) return "Kyoko"; // hiragana/katakana → Japanese
  if (/[가-힣]/.test(text)) return "Yuna"; // hangul → Korean
  if (/[一-鿿]/.test(text)) return "Tingting"; // Han (no kana) → Chinese
  return undefined;
}

/**
 * Read a paragraph aloud via the OS speech synthesizer. A direct call (chunk
 * gutter button) replaces any in-flight multi-chunk queue — a new read intent
 * supersedes the old one; queue-driven calls pass `fromQueue` to keep theirs.
 */
export async function speakChunk(
  chunkId: string,
  opts?: { fromQueue?: boolean }
): Promise<void> {
  const s = useStore.getState();
  if (!opts?.fromQueue) s.setSpeechQueue([]);
  const chunk = s.doc.chunks.find((c) => c.id === chunkId);
  if (!chunk || !chunk.content.trim()) {
    s.notify(tNow("Nothing to read here."), "info");
    return;
  }
  try {
    // The backend returns an utterance id and emits `speech-done` with that id
    // when playback ends; record it so exactly this chunk's button clears (UI3).
    const utterance = await api.speakText(chunk.content, voiceForText(chunk.content));
    useStore.getState().beginSpeaking(chunkId, utterance);
  } catch (e) {
    s.notify(message(e), "error");
  }
}

/**
 * Read several chunks in sequence (item 14 — multi-paragraph / whole-document
 * read-aloud). Only text/heading chunks with content are queued. The backend
 * speaks ONE utterance at a time (a new speak_text kills the previous one), so
 * the queue advances strictly on `speech-done` — see advanceSpeechQueue, called
 * from App's event listener.
 */
export async function speakChunks(ids: string[]): Promise<void> {
  const s = useStore.getState();
  const speakable = ids.filter((id) => {
    const c = s.doc.chunks.find((x) => x.id === id);
    if (!c || !c.content.trim()) return false;
    const t = c.metadata.chunkType;
    return t === "text" || t === "heading";
  });
  if (speakable.length === 0) {
    s.notify(tNow("Nothing to read."), "info");
    return;
  }
  s.setSpeechQueue(speakable.slice(1));
  await speakChunk(speakable[0], { fromQueue: true });
}

/**
 * Speak the next queued chunk, if any. Must only be called after the previous
 * utterance's `speech-done` arrived (killall-say semantics on the backend).
 */
export async function advanceSpeechQueue(): Promise<void> {
  const s = useStore.getState();
  // Skip queue entries whose chunk vanished while an earlier one was speaking.
  for (;;) {
    const next = s.shiftSpeechQueue();
    if (next === null) return;
    const chunk = useStore.getState().doc.chunks.find((c) => c.id === next);
    if (chunk && chunk.content.trim()) {
      await speakChunk(next, { fromQueue: true });
      return;
    }
  }
}

export async function stopSpeaking(): Promise<void> {
  const s = useStore.getState();
  s.setSpeechQueue([]); // stop means stop — don't advance to the next chunk
  s.endSpeaking(); // clear the speaking indicator immediately
  try {
    await api.stopSpeaking();
  } catch {
    /* best-effort */
  }
}

/**
 * Analyze the whole document and open the relationship network panel. A
 * document with no non-blank text/heading paragraph is a no-op with an info
 * notice (BUG-015a): no IPC call, no store change, no Settings prompt.
 */
export async function analyzeDocument(): Promise<void> {
  const s = useStore.getState();
  // UI2: guard against concurrent Analyze runs. This covers EVERY entry point
  // (toolbar, native menu, NetworkPanel refresh, shortcut) so rapid clicks can't
  // start parallel analyses that waste tokens and flicker the graph.
  if (s.globalBusy) return;
  if (!hasAnalyzableContent(s.doc)) {
    s.notify(tNow("Nothing to analyze yet — write some text first."), "info");
    return;
  }
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const op = captureOp(); // BUG-001b: apply only to this tab + load
  const tab = op.tabId;
  s.setGlobalBusy(tNow("Analyzing document…"), tab);
  logOp(op, "start", "analyze");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "empty-result" };
  try {
    const sent = s.doc; // state-async-4: what the analysis describes
    const result = await api.aiAnalyzeDocument(sent);
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — analysis discarded."), "info");
      return;
    }
    // applyAnalysis persists the relationships into the document (spec §5) so
    // the graph survives a save/reopen and the document is marked dirty.
    useStore.getState().applyAnalysis(result, sent);
    useStore.getState().toggleNetwork(true);
    outcome = { phase: "commit" };
    if (result.nodes.length === 0) {
      s.notify(tNow("No relationships were found."), "info");
    } else {
      s.notify(
        tf("Found {nodes} nodes and {edges} relations.", {
          nodes: result.nodes.length,
          edges: result.edges.length,
        }),
        "success"
      );
    }
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "analyze", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

// ---- Review comments (mismatch report §2 / report ch.7 Task 4) -------------

// How much of each paragraph the reviewer/integrity prompts see.
const REVIEW_SNIPPET_CHARS = 400;

/** Compact `[id] text…` listing of the document's text + heading chunks. */
function reviewListing(chunks: Chunk[]): { ids: Set<string>; listing: string } {
  const items = chunks.filter(
    (c) =>
      (c.metadata.chunkType === "text" || c.metadata.chunkType === "heading") &&
      c.content.trim()
  );
  const listing = items
    .map((c) => {
      const text = c.content.trim().replace(/\s+/g, " ");
      const cut =
        text.length > REVIEW_SNIPPET_CHARS
          ? `${text.slice(0, REVIEW_SNIPPET_CHARS)}…`
          : text;
      return `[${c.id}] ${cut}`;
    })
    .join("\n\n");
  return { ids: new Set(items.map((c) => c.id)), listing };
}

/** First few words of a chunk's content — labels "related" paragraphs. */
function chunkHeadWords(chunks: Chunk[], id: string): string {
  const c = chunks.find((x) => x.id === id);
  return c ? c.content.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 40) : "";
}

/**
 * AI document reviewer: one non-streaming pass over every paragraph, returning
 * at most one concise, actionable comment per paragraph that genuinely needs
 * one. Findings land as AI review comments (kind "review") in the review
 * panel; the previous review's comments are cleared first so re-running never
 * stacks duplicates. A mid-flight tab switch discards the result.
 */
export async function reviewDocument(): Promise<void> {
  const s = useStore.getState();
  if (s.globalBusy) return; // one global AI pass at a time (UI2 pattern)
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const op = captureOp(); // BUG-001b: comments land only in this tab + load
  const tab = op.tabId;
  // Fresh summaries first so the reviewer sees current context (T2).
  await refreshStaleSummaries(null, op);
  if (!ownsOp(op)) return;

  const { ids, listing } = reviewListing(useStore.getState().doc.chunks);
  if (!listing) {
    s.notify(tNow("Nothing to review yet — write something first."), "info");
    return;
  }
  const language = s.settings?.defaultTargetLanguage;
  s.setGlobalBusy(tNow("Reviewing document…"), tab);
  logOp(op, "start", "review");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "invalid-result" };
  try {
    // No outputLanguage: the reply must be strict JSON, not prose — the
    // comment-text language is pinned inside the instruction instead.
    const raw = await api.aiProcess({
      action: "custom",
      text: listing,
      instruction:
        "Act as a rigorous academic reviewer. The text lists a document's paragraphs, each " +
        "prefixed with its id in [brackets]. Review every paragraph for weak arguments, unclear " +
        "claims, missing transitions, and factual vagueness. Return STRICT JSON only — no prose, " +
        'no code fences — shaped exactly as {"comments":[{"chunkId":"...","text":"..."}]}. ' +
        "Give at most ONE concise, actionable comment per paragraph, and ONLY for paragraphs " +
        'that genuinely need one; return {"comments":[]} when there is nothing worth saying. ' +
        "Copy each chunkId exactly from the [brackets]." +
        (language ? ` Write each comment's text in ${language}.` : ""),
    });
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — review discarded."), "info");
      return;
    }
    const parsed = extractJsonObject(raw) as {
      comments?: { chunkId?: unknown; text?: unknown }[];
    } | null;
    if (!parsed || !Array.isArray(parsed.comments)) {
      s.notify(tNow("The model returned no readable review."), "error");
      return;
    }
    const findings = parsed.comments.filter(
      (f): f is { chunkId: string; text: string } =>
        typeof f?.chunkId === "string" &&
        ids.has(f.chunkId) &&
        typeof f?.text === "string" &&
        !!f.text.trim()
    );
    const store = useStore.getState();
    store.clearAiComments("review"); // regenerate, don't stack
    // addComment returns null for a paragraph deleted mid-flight — count only
    // the comments that actually landed so the toast can't overstate.
    let added = 0;
    for (const f of findings) {
      if (store.addComment(f.chunkId, f.text.trim(), "ai", "review")) added += 1;
    }
    outcome = { phase: "commit" };
    if (added) {
      store.toggleReviewPanel(true);
      s.notify(
        added === 1 ? tNow("AI review: 1 comment.") : tf("AI review: {n} comments.", { n: added }),
        "success"
      );
    } else {
      s.notify(tNow("AI review: no issues found."), "success");
    }
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "review", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

// The comment kinds the integrity lens writes (cleared before re-running).
const INTEGRITY_KINDS = ["integrity", "unsupported-claim", "contradiction"];

/**
 * Shared context assembly for anything that reasons over the whole document's
 * RELATIONSHIP GRAPH plus its paragraph texts — currently `checkIntegrity`
 * (unsupported claims / contradictions) and `checkAgainstCriteria` (review-
 * criteria coverage). Both need the exact same "graph + paragraph listing"
 * block, so it's built once here rather than duplicated. Returns `null` when
 * there's nothing to check (no analysis yet, stale analysis, or an empty
 * document) — callers surface their own action-specific message for each case.
 */
function buildGraphAndParagraphContext():
  | { ids: Set<string>; text: string }
  | null {
  const s = useStore.getState();
  const analysis = s.doc.analysis;
  if (!analysis || s.analysisStale) return null;
  const { ids, listing } = reviewListing(s.doc.chunks);
  if (!listing) return null;
  const nodeLines = analysis.nodes.map(
    (n) =>
      `- [${n.id}] (${n.kind ?? "paragraph"}) ${n.label}${
        n.summary ? ` — ${n.summary}` : ""
      }`
  );
  const edgeLines = analysis.edges.map(
    (e) => `- [${e.source}] -${e.relation || "related"}-> [${e.target}]`
  );
  const text = [
    "RELATIONSHIP GRAPH — NODES:",
    ...nodeLines,
    "",
    "RELATIONSHIP GRAPH — EDGES:",
    ...(edgeLines.length ? edgeLines : ["(none)"]),
    "",
    "PARAGRAPHS:",
    listing,
  ].join("\n");
  return { ids, text };
}

/**
 * "Map logic" (report ch.7 Task 4): feed the RELATIONSHIP GRAPH plus the
 * paragraph texts to the model and ask for (a) claims with no supporting
 * evidence edge AND no evidential text in the document, (b) pairs of
 * statements that contradict each other. This is the model's OPINION, not a
 * verified audit — an optional, occasional-use tool, not a weekly-loop
 * essential (project.md Q8). Requires a fresh analysis — the graph IS the
 * input, so a stale/missing one would produce junk findings. Findings land
 * as AI comments (kind = "unsupported-claim" | "contradiction") and open the
 * review panel.
 */
export async function checkIntegrity(): Promise<void> {
  const s = useStore.getState();
  if (s.globalBusy) return;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return;
  }
  const analysis = s.doc.analysis;
  if (!analysis || s.analysisStale) {
    s.notify(tNow("Run Analyze first so logic-mapping has a fresh relationship graph."),
      "info"
    );
    return;
  }
  const op = captureOp(); // BUG-001b: findings land only in this tab + load
  const tab = op.tabId;
  const ctx = buildGraphAndParagraphContext();
  if (!ctx) {
    s.notify(tNow("Nothing to check yet — write something first."), "info");
    return;
  }
  const { ids, text } = ctx;
  const language = s.settings?.defaultTargetLanguage;
  s.setGlobalBusy(tNow("Mapping logic…"), tab);
  logOp(op, "start", "integrity");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "invalid-result" };
  try {
    const raw = await api.aiProcess({
      action: "custom",
      text,
      instruction:
        "You are checking a document's logical integrity using its relationship graph. The text " +
        "contains the graph (nodes and edges) and the document's paragraphs, each prefixed with " +
        'its id in [brackets]. Find: (a) CLAIMS that have no supporting evidence edge in the ' +
        'graph AND no evidential text anywhere in the document — kind "unsupported-claim"; ' +
        '(b) pairs of statements that CONTRADICT each other — kind "contradiction", reported ' +
        "on one chunk with the other chunk's id in relatedChunkIds. Return STRICT JSON only — " +
        "no prose, no code fences — shaped exactly as " +
        '{"findings":[{"chunkId":"...","kind":"unsupported-claim","note":"...",' +
        '"relatedChunkIds":["..."]}]} where kind is "unsupported-claim" or "contradiction". ' +
        'Return {"findings":[]} when the document holds together. Copy every id exactly from ' +
        "the [brackets]." +
        (language ? ` Write each note in ${language}.` : ""),
    });
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — integrity check discarded."), "info");
      return;
    }
    const parsed = extractJsonObject(raw) as {
      findings?: {
        chunkId?: unknown;
        kind?: unknown;
        note?: unknown;
        relatedChunkIds?: unknown;
      }[];
    } | null;
    if (!parsed || !Array.isArray(parsed.findings)) {
      s.notify(tNow("The model returned no readable findings."), "error");
      return;
    }
    const knownKinds = new Set(INTEGRITY_KINDS);
    const findings = parsed.findings.filter(
      (
        f
      ): f is { chunkId: string; kind: string; note: string; relatedChunkIds?: unknown } =>
        typeof f?.chunkId === "string" &&
        ids.has(f.chunkId) &&
        typeof f?.kind === "string" &&
        knownKinds.has(f.kind) &&
        typeof f?.note === "string" &&
        !!f.note.trim()
    );
    const store = useStore.getState();
    for (const kind of INTEGRITY_KINDS) store.clearAiComments(kind);
    const chunks = useStore.getState().doc.chunks;
    let added = 0;
    for (const f of findings) {
      // Suffix the head-words of resolvable related paragraphs so the comment
      // reads standalone ("… — related: “The 2019 survey…”").
      const related = (Array.isArray(f.relatedChunkIds) ? f.relatedChunkIds : [])
        .filter(
          (id): id is string =>
            typeof id === "string" && ids.has(id) && id !== f.chunkId
        )
        .map((id) => chunkHeadWords(chunks, id))
        .filter(Boolean);
      const body = related.length
        ? `${f.note.trim()} — related: ${related.map((h) => `“${h}…”`).join(", ")}`
        : f.note.trim();
      if (store.addComment(f.chunkId, body, "ai", f.kind)) added += 1;
    }
    outcome = { phase: "commit" };
    if (added) {
      store.toggleReviewPanel(true);
      s.notify(
        added === 1
          ? tNow("Map logic: 1 finding (AI opinion, not a verified audit).")
          : tf("Map logic: {n} findings (AI opinion, not a verified audit).", { n: added }),
        "success"
      );
    } else {
      s.notify(tNow("Map logic: no issues found."), "success");
    }
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
  } finally {
    logOp(op, outcome.phase, "integrity", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}

// ---- Review-criteria ↔ body-text mapping (開発.txt Stage 2, item 2-1, Part B) --

/**
 * One review-criterion's coverage result: whether ANY paragraph in the
 * document supports it, and which paragraph(s) do. The criteria themselves
 * are entirely user-supplied free text (e.g. grant-review phrases the user
 * types in) — this module has no built-in list and no knowledge of any real
 * institution's actual review criteria (see 開発.txt §9 — bundling official
 * form content is an explicitly unresolved decision, out of scope here).
 */
export interface CriteriaCheckResult {
  criterion: string;
  covered: boolean;
  supportingChunkIds: string[];
}

/**
 * Parse the model's reply into `CriteriaCheckResult[]`, tolerantly (mirrors
 * `checkIntegrity`'s JSON handling): extract the first balanced JSON object,
 * expect `{"results":[{"criterion","covered","supportingChunkIds"}]}`, and
 * keep only well-shaped entries whose `supportingChunkIds` are restricted to
 * ids that actually exist in `validIds` (a hallucinated id is dropped rather
 * than surfaced as if it were real). Any criterion the model dropped entirely
 * (missing from its reply) is re-added as not-covered with no supporting
 * chunks — a gap in the model's answer must never silently disappear the
 * criterion from the result, since "criterion missing" and "criterion not
 * covered" would otherwise be indistinguishable to the user. Exported for
 * adversarial-input testing (malformed/partial LLM output).
 */
export function parseCriteriaResults(
  raw: string,
  criteria: string[],
  validIds: Set<string>
): CriteriaCheckResult[] {
  const parsed = extractJsonObject(raw) as {
    results?: {
      criterion?: unknown;
      covered?: unknown;
      supportingChunkIds?: unknown;
    }[];
  } | null;

  const byCriterion = new Map<string, CriteriaCheckResult>();
  const rawResults = Array.isArray(parsed?.results) ? parsed!.results : [];
  for (const r of rawResults) {
    const modelCriterion = r?.criterion;
    if (typeof modelCriterion !== "string") continue;
    // Match against the user's ORIGINAL phrase, not whatever the model echoed
    // back, in case of trivial rewording/whitespace differences.
    const match = criteria.find((c) => c.trim() === modelCriterion.trim());
    if (!match) continue;
    const supportingChunkIds = (
      Array.isArray(r.supportingChunkIds) ? r.supportingChunkIds : []
    ).filter((id): id is string => typeof id === "string" && validIds.has(id));
    // A criterion is only "covered" if the model said so AND named at least
    // one real supporting paragraph — a "covered:true" with zero valid ids
    // (e.g. all hallucinated) is not real coverage.
    const covered = r.covered === true && supportingChunkIds.length > 0;
    byCriterion.set(match, { criterion: match, covered, supportingChunkIds });
  }
  // Anything the model's reply omitted entirely is reported as an explicit
  // not-covered gap, never silently dropped from the result list.
  return criteria.map(
    (c) => byCriterion.get(c) ?? { criterion: c, covered: false, supportingChunkIds: [] }
  );
}

/**
 * Ask the LLM which of the user-supplied `criteria` phrases have NO
 * supporting paragraph anywhere in the document. Reuses the exact same
 * graph+paragraph-listing context `checkIntegrity` builds (via
 * `buildGraphAndParagraphContext`) rather than reinventing it — same
 * "requires a fresh analysis" precondition, for the same reason (the graph is
 * part of the input). Returns `null` (with a toast already shown) on any
 * failure — precondition not met, empty criteria, or a request/parse error —
 * so the caller (`CriteriaPanel`) only has to render the busy/error/result
 * states, not re-derive them.
 */
export async function checkAgainstCriteria(
  criteria: string[]
): Promise<CriteriaCheckResult[] | null> {
  const s = useStore.getState();
  if (s.globalBusy) return null;
  if (!aiReady()) {
    s.notify(tNow("Set your OpenRouter API key in Settings first."), "error");
    s.openSettings();
    return null;
  }
  const cleaned = criteria.map((c) => c.trim()).filter(Boolean);
  if (!cleaned.length) {
    s.notify(tNow("Add at least one review criterion first."), "info");
    return null;
  }
  const analysis = s.doc.analysis;
  if (!analysis || s.analysisStale) {
    s.notify(tNow("Run Analyze first so criteria checking has a fresh relationship graph."),
      "info"
    );
    return null;
  }
  const op = captureOp(); // BUG-001b: results belong to this tab + load
  const tab = op.tabId;
  const ctx = buildGraphAndParagraphContext();
  if (!ctx) {
    s.notify(tNow("Nothing to check yet — write something first."), "info");
    return null;
  }
  const { ids, text } = ctx;
  const criteriaListing = cleaned.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const fullText = [text, "", "REVIEW CRITERIA:", criteriaListing].join("\n");
  s.setGlobalBusy(tNow("Checking against review criteria…"), tab);
  logOp(op, "start", "criteria");
  let outcome: { phase: OpPhase; reason?: string } = { phase: "discard", reason: "invalid-result" };
  try {
    const raw = await api.aiProcess({
      action: "custom",
      text: fullText,
      instruction:
        "You are checking document coverage against a list of user-supplied review criteria. The " +
        "text contains the document's relationship graph, its paragraphs (each prefixed with its " +
        "id in [brackets]), and a numbered REVIEW CRITERIA list. For EVERY criterion, decide " +
        "whether the document contains a paragraph that genuinely supports/addresses it, and if " +
        "so which paragraph id(s). Return STRICT JSON only — no prose, no code fences — shaped " +
        'exactly as {"results":[{"criterion":"...","covered":true|false,' +
        '"supportingChunkIds":["..."]}]}, with exactly one entry per criterion, copying each ' +
        "criterion's text EXACTLY as given and copying every id exactly from the [brackets]. " +
        'A criterion with no genuinely supporting paragraph MUST be reported as "covered":false ' +
        'with "supportingChunkIds":[].',
    });
    const stale = staleReason(op);
    if (stale) {
      outcome = { phase: "discard", reason: stale };
      s.notify(tNow("Switched tabs — criteria check discarded."), "info");
      return null;
    }
    const results = parseCriteriaResults(raw, cleaned, ids);
    outcome = { phase: "commit" };
    const uncovered = results.filter((r) => !r.covered).length;
    if (uncovered) {
      s.notify(
        tf("Criteria check: {n} of {total} not covered.", { n: uncovered, total: results.length }),
        "info"
      );
    } else {
      s.notify(tNow("Criteria check: every criterion is covered."), "success");
    }
    return results;
  } catch (e) {
    outcome = { phase: "discard", reason: notifyAiError(e) };
    return null;
  } finally {
    logOp(op, outcome.phase, "criteria", undefined, outcome.reason);
    useStore.getState().setGlobalBusy(null, tab);
  }
}
