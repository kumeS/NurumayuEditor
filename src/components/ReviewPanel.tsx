// Review comments panel (mismatch report §2): a right-docked list of the
// per-paragraph comments, grouped by chunk in document order. Group headers
// jump to (and flash) their paragraph; resolved comments collapse into a
// dimmed section at the bottom. Also hosts the two AI generators — the
// document reviewer and "Map logic" (an optional, occasional-use tool that
// surfaces the model's opinion on possibly-unsupported claims/contradictions
// via the relationship graph — not a verified audit; see project.md Q8).

import { useState } from "react";
import { checkIntegrity, reviewDocument } from "../aiActions";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { Chunk, ReviewComment } from "../types";
import { CloseIcon, CommentIcon, PlusIcon, TrashIcon } from "./icons";
import Tooltip from "./Tooltip";

/** "2 min ago" style timestamp (same buckets as NetworkPanel's). */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d <= 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** A chunk's display title: its first ~60 chars (headings read as-is). */
function chunkTitle(chunk: Chunk): string {
  const text = chunk.content.trim().replace(/\s+/g, " ");
  if (!text) return "(empty paragraph)";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Author chip label: "You" for user comments, "AI · kind" for AI ones. */
function authorLabel(cm: ReviewComment): string {
  if (cm.author === "ai") return cm.kind ? `AI · ${cm.kind}` : "AI";
  return "You";
}

function AuthorChip({ comment }: { comment: ReviewComment }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        comment.author === "ai"
          ? "bg-violet-100 text-violet-700"
          : "bg-accent/10 text-accent"
      }`}
    >
      {authorLabel(comment)}
    </span>
  );
}

/** One comment row: chip + time + text, with edit / resolve / delete actions. */
function CommentRow({ chunkId, comment }: { chunkId: string; comment: ReviewComment }) {
  const t = useT();
  const updateComment = useStore((s) => s.updateComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const toggleCommentResolved = useStore((s) => s.toggleCommentResolved);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== comment.text) updateComment(chunkId, comment.id, text);
    setEditing(false);
  };

  return (
    <div
      className={`rounded-md border border-gray-100 bg-gray-50/60 px-2 py-1.5 ${
        comment.resolved ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-1.5">
        <AuthorChip comment={comment} />
        <span
          className="text-[10px] text-ink-faint"
          title={new Date(comment.createdAt).toLocaleString()}
        >
          {relativeTime(comment.createdAt)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {comment.author !== "ai" && !comment.resolved && (
            <button
              className="text-[11px] text-ink-faint hover:text-ink"
              onClick={() => {
                setDraft(comment.text);
                setEditing((v) => !v);
              }}
            >
              {t("Edit")}
            </button>
          )}
          <button
            className="text-[11px] text-ink-faint hover:text-ink"
            onClick={() => toggleCommentResolved(chunkId, comment.id)}
          >
            {comment.resolved ? t("Unresolve") : t("Resolve")}
          </button>
          <Tooltip label="Delete comment">
            <button
              className="rounded p-0.5 text-ink-faint hover:bg-gray-100 hover:text-red-500"
              onClick={() => deleteComment(chunkId, comment.id)}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </span>
      </div>
      {editing ? (
        <div className="mt-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
            className="w-full resize-none rounded border border-gray-200 bg-white p-1.5 text-xs text-ink-soft outline-none focus:border-accent"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              className="text-[11px] text-ink-faint hover:text-ink"
              onClick={() => setEditing(false)}
            >
              {t("Cancel")}
            </button>
            <button
              className="text-[11px] font-medium text-accent hover:underline"
              onClick={saveEdit}
            >
              {t("Save")}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-soft">
          {comment.text}
        </p>
      )}
    </div>
  );
}

export default function ReviewPanel() {
  const t = useT();
  const chunks = useStore((s) => s.doc.chunks);
  const globalBusy = useStore((s) => s.globalBusy);
  const flashChunk = useStore((s) => s.flashChunk);
  const toggleReviewPanel = useStore((s) => s.toggleReviewPanel);
  const reviewTargetChunkId = useStore((s) => s.reviewTargetChunkId);
  const setReviewTarget = useStore((s) => s.setReviewTarget);
  const addComment = useStore((s) => s.addComment);

  const [composerText, setComposerText] = useState("");
  const [showResolved, setShowResolved] = useState(false);

  // Document-order groups of unresolved comments, plus a flat resolved list.
  const groups = chunks
    .map((c) => ({
      chunk: c,
      comments: (c.metadata.comments ?? []).filter((cm) => !cm.resolved),
    }))
    .filter((g) => g.comments.length > 0);
  const resolved = chunks.flatMap((c) =>
    (c.metadata.comments ?? [])
      .filter((cm) => cm.resolved)
      .map((cm) => ({ chunk: c, comment: cm }))
  );
  const isEmpty = groups.length === 0 && resolved.length === 0;

  const composerChunk = reviewTargetChunkId
    ? chunks.find((c) => c.id === reviewTargetChunkId)
    : undefined;

  const submitComment = () => {
    if (!composerChunk) return;
    const text = composerText.trim();
    if (!text) return;
    addComment(composerChunk.id, text);
    setComposerText("");
    setReviewTarget(null);
  };

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <CommentIcon />{t("Review")}</div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void reviewDocument()}
            className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!!globalBusy}
            title={t("AI reviews every paragraph and leaves actionable comments")}
          >
            {t("AI review")}
          </button>
          <button
            onClick={() => void checkIntegrity()}
            className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!!globalBusy}
            title="AI's opinion on possibly-unsupported claims and contradictions, using the relationship graph (run Analyze first) — not a verified audit"
          >
            {t("Map logic")}
          </button>
          <button
            onClick={() => toggleReviewPanel(false)}
            className="rounded p-1 text-ink-faint hover:bg-gray-100 hover:text-ink"
            aria-label={t("Close panel")}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {/* Composer — shown when the panel was opened for a specific chunk
            (gutter comment button) or via a group's + button. */}
        {composerChunk && (
          <div className="rounded-md border border-accent/40 bg-accent/5 p-2">
            <button
              className="block w-full truncate text-left text-xs font-medium text-ink hover:text-accent"
              onClick={() => flashChunk(composerChunk.id)}
              title={t("Jump to this paragraph")}
            >
              {chunkTitle(composerChunk)}
            </button>
            <textarea
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              rows={2}
              autoFocus
              placeholder={t("Add a comment…")}
              className="mt-1.5 w-full resize-none rounded border border-gray-200 bg-white p-1.5 text-xs text-ink-soft outline-none focus:border-accent"
            />
            <div className="mt-1 flex justify-end gap-2">
              <button
                className="text-[11px] text-ink-faint hover:text-ink"
                onClick={() => {
                  setComposerText("");
                  setReviewTarget(null);
                }}
              >
                {t("Cancel")}
              </button>
              <button
                className="text-[11px] font-medium text-accent hover:underline disabled:opacity-40"
                disabled={!composerText.trim()}
                onClick={submitComment}
              >
                {t("Add comment")}
              </button>
            </div>
          </div>
        )}

        {isEmpty && !composerChunk && (
          <div className="px-1 py-6 text-center text-xs leading-5 text-ink-faint">{t("No comments yet. Use a paragraph's")}<CommentIcon className="inline h-3.5 w-3.5" />{" "}
            button to add one, or run “AI review” / “Map logic” above.
          </div>
        )}

        {groups.map(({ chunk, comments }) => (
          <div key={chunk.id}>
            <div className="mb-1 flex items-center gap-1">
              <button
                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink hover:text-accent"
                onClick={() => flashChunk(chunk.id)}
                title={t("Jump to this paragraph")}
              >
                {chunkTitle(chunk)}
              </button>
              <Tooltip label="Add a comment on this paragraph">
                <button
                  className="rounded p-0.5 text-ink-faint hover:bg-gray-100 hover:text-ink"
                  onClick={() => setReviewTarget(chunk.id)}
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
            <div className="space-y-1.5">
              {comments.map((cm) => (
                <CommentRow key={cm.id} chunkId={chunk.id} comment={cm} />
              ))}
            </div>
          </div>
        ))}

        {resolved.length > 0 && (
          <div className="border-t border-gray-100 pt-2">
            <button
              className="text-xs font-medium text-ink-faint hover:text-ink"
              onClick={() => setShowResolved((v) => !v)}
            >
              {showResolved ? "▾" : "▸"} Resolved ({resolved.length})
            </button>
            {showResolved && (
              <div className="mt-1.5 space-y-1.5">
                {resolved.map(({ chunk, comment }) => (
                  <div key={comment.id}>
                    <button
                      className="mb-0.5 block w-full truncate text-left text-[11px] text-ink-faint line-through hover:text-ink"
                      onClick={() => flashChunk(chunk.id)}
                      title={t("Jump to this paragraph")}
                    >
                      {chunkTitle(chunk)}
                    </button>
                    <CommentRow chunkId={chunk.id} comment={comment} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 px-3 py-2 text-xs text-ink-faint">
        {t("Click a paragraph title to jump to it in the editor.")}
      </div>
    </aside>
  );
}
