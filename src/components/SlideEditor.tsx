// Slide-mode authoring surface: a thumbnail rail + a 16:9 canvas with an
// Edit / Preview / Present switch. A slide-mode document is the same chunk model
// as the editor, presented as slides — each HEADING starts a new slide and the
// chunks under it are that slide's body. Editing reuses ChunkView, so every
// per-chunk AI action, image/diagram generation and version history works inside
// slides unchanged; "Export ▸ .pptx" turns this deck into a file.
//
// WYSIWYG: thumbnails, the Preview canvas, and Present all render the SAME slide
// content at a fixed 1280×720 design size, CSS-scaled to fit. The slide-derivation
// helpers live in ../slides and MIRROR the Rust deck.rs/pptx.rs rules, so what you
// see matches the exported layout (the bug report's ROOT alignment) — including
// the multi-image grid (ImageRegionGrid + splitImageRegion mirror the pptx.rs
// grid contract: same visuals ordering, cell split and gap). The toolbar's
// Editor/Slides toggle can switch a tab into and out of this view at any
// time — App.tsx keys the view by tab+mode so state resets cleanly either way.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { suggestSlideLayout, summarizeSlide } from "../aiActions";
import {
  groupSlides,
  hasLayoutOverride,
  headingOf,
  isSlideDetached,
  layoutHost,
  MAX_SLIDE_IMAGES,
  resolveLayout,
  slideBullets,
  slideDiagrams,
  slideImages,
  slideMoveBounds,
  slideOverflows,
  slideSubtitle,
  slideTitle,
  splitImageRegion,
  type SlideGroup,
} from "../slides";
import { useStore } from "../store";
import type { Chunk, SlideLayout } from "../types";
import ChunkView from "./ChunkView";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  FlowIcon,
  ImageIcon,
  PlusIcon,
  PresentIcon,
  ScissorsIcon,
  SlidesIcon,
  SparklesIcon,
  TrashIcon,
} from "./icons";

const DESIGN_W = 1280;
const DESIGN_H = 720;

// Layout choices offered by the picker (Auto, which clears the override, is
// handled separately). Each entry pairs the value the deck.rs/pptx.rs export
// understands with a human label and a plain-language description of when to
// use it — the raw enum strings ("title-image" etc.) were confusing on their
// own.
const LAYOUT_META: { value: SlideLayout; label: string; hint: string }[] = [
  { value: "section", label: "Section", hint: "A big centred title (+ subtitle) with no bullets — for a divider or opening slide." },
  { value: "title-content", label: "Title + Bullets", hint: "The standard content slide: a title with full-width bullet points." },
  { value: "title-image", label: "Image right", hint: "Bullets on the left, one image on the right." },
  { value: "title-image-left", label: "Image left", hint: "One image on the left, bullets on the right." },
  { value: "image-top", label: "Image top", hint: "One image spanning the top, bullets below." },
];

function layoutLabel(layout: SlideLayout): string {
  return LAYOUT_META.find((l) => l.value === layout)?.label ?? layout;
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export default function SlideEditor() {
  const title = useStore((s) => s.doc.title);
  const setTitle = useStore((s) => s.setTitle);
  const chunks = useStore((s) => s.doc.chunks);
  const globalBusy = useStore((s) => s.globalBusy);
  const focusedChunkId = useStore((s) => s.focusedChunkId);
  const addChunkAfter = useStore((s) => s.addChunkAfter);
  const setChunkOrder = useStore((s) => s.setChunkOrder);
  const deleteChunks = useStore((s) => s.deleteChunks);
  const duplicateChunksAfter = useStore((s) => s.duplicateChunksAfter);
  const setChunkLayout = useStore((s) => s.setChunkLayout);
  const setSlideBody = useStore((s) => s.setSlideBody);
  const moveChunk = useStore((s) => s.moveChunk);
  const setFocused = useStore((s) => s.setFocused);
  const splitSlideBefore = useStore((s) => s.splitSlideBefore);
  const mergeSlideIntoPrevious = useStore((s) => s.mergeSlideIntoPrevious);

  const [view, setView] = useState<"edit" | "preview">("edit");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);

  // D6: re-derive slides only when the chunk list changes — not on every store
  // update (focus/busy/toasts also re-render this component).
  const slides = useMemo(() => groupSlides(chunks), [chunks]);

  // UI4: select the slide that contains the focused chunk first (so keyboard nav
  // keeps the right slide on screen), else the last-clicked thumbnail (anchor),
  // else the first — instead of tracking the current slide via two systems that
  // drift apart.
  let selected = slides.findIndex((s) => s.items.some((c) => c.id === focusedChunkId));
  if (selected < 0) selected = slides.findIndex((s) => s.items[0]?.id === anchor);
  if (selected < 0) selected = 0;
  const current: SlideGroup | undefined = slides[selected];
  const slideIdLists = slides.map((s) => s.items.map((c) => c.id));

  // Keep the rail's selected thumbnail in view — matters both for keyboard/
  // click navigation within Slides and for entering Slide mode from the
  // Editor (whose focused paragraph may land on a slide scrolled out of view).
  useEffect(() => {
    thumbRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pIdx = Math.max(0, Math.min(presentIdx, slides.length - 1));
  // B6: re-clamp the REAL present index when the deck shrinks (e.g. an undo during
  // a presentation), so Prev/← aren't "dead" for a few presses while only the
  // displayed index was clamped.
  useEffect(() => {
    setPresentIdx((i) => Math.min(i, Math.max(0, slides.length - 1)));
  }, [slides.length]);

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        setPresentIdx((i) => Math.min(slides.length - 1, i + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setPresentIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Escape") {
        setPresenting(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, slides.length]);

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= slides.length) return;
    setChunkOrder(arrayMove(slideIdLists, from, to).flat());
  };
  const addSlide = () => {
    const lastId = chunks.length ? chunks[chunks.length - 1].id : null;
    setAnchor(addChunkAfter(lastId, "heading"));
  };
  const duplicateSlide = (s: SlideGroup) => {
    // UI5: a heading-less (leading) slide has no delimiter, so a plain clone would
    // be re-absorbed into the same slide and silently double its paragraphs. Only
    // slides with a heading can be duplicated; the rail button is disabled
    // otherwise with an explanatory tooltip.
    if (!headingOf(s)) return;
    const ids = duplicateChunksAfter(s.items.map((c) => c.id));
    if (ids[0]) setAnchor(ids[0]);
  };
  const deleteSlide = (idx: number) => {
    const neighbour = slides[idx - 1] ?? slides[idx + 1];
    setAnchor(neighbour?.items[0]?.id ?? null);
    deleteChunks(slides[idx].items.map((c) => c.id));
  };
  const startPresent = () => {
    setPresentIdx(selected);
    setPresenting(true);
  };

  // The chunk that holds this slide's layout override — heading, else the first
  // chunk — so even a heading-less slide can have a layout applied (Req 1).
  const layoutTarget = current ? layoutHost(current) : undefined;
  const leadId = layoutTarget?.id;
  const detached = current ? isSlideDetached(current) : false; // Req 2
  const currentTextIds = current
    ? current.items.filter((c) => c.metadata.chunkType === "text").map((c) => c.id)
    : [];

  return (
    <div className="flex h-full min-h-0">
      {/* ---- thumbnail rail ---- */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-gray-50/60">
        <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-ink-soft">
          <span className="flex items-center gap-1.5">
            <SlidesIcon className="h-3.5 w-3.5" /> Slides
          </span>
          <span className="text-ink-faint">{slides.length}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {slides.map((s, i) => {
            const isSel = i === selected;
            const hasHeading = !!headingOf(s);
            const diagramCount = slideDiagrams(s).length;
            const overflows = slideOverflows(s); // A7: pptx.rs heuristic, ported
            return (
              <div
                key={s.items[0]?.id ?? `s${i}`}
                ref={(el) => {
                  thumbRefs.current[i] = el;
                }}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragFrom.current !== null) reorder(dragFrom.current, i);
                  dragFrom.current = null;
                }}
                className="group/thumb relative"
              >
                <button
                  onClick={() => {
                    // Move BOTH the anchor and the focus to this slide. Because
                    // slide selection follows the focused chunk first, updating
                    // only the anchor would leave selection pinned to whatever
                    // slide currently holds the cursor — so the rail looked dead
                    // once any chunk was focused.
                    const id = s.items[0]?.id ?? null;
                    setAnchor(id);
                    setFocused(id);
                  }}
                  className={`flex w-full items-stretch gap-1.5 rounded-md border p-1 text-left ${
                    isSel
                      ? "border-accent ring-1 ring-accent"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <span className="w-4 shrink-0 pt-0.5 text-[10px] tabular-nums text-ink-faint">
                    {i + 1}
                  </span>
                  <span className="relative min-w-0 flex-1 overflow-hidden rounded-sm border border-gray-200">
                    <SlideStage slide={s} layout={resolveLayout(s)} docTitle={title} placeholders />
                    {diagramCount > 0 && (
                      <span
                        className="absolute bottom-0.5 right-0.5 flex items-center gap-0.5 rounded bg-amber-100/90 px-1 text-[9px] font-medium text-amber-700"
                        title={`${diagramCount} diagram(s) on this slide are not yet exported to .pptx`}
                      >
                        <FlowIcon className="h-2.5 w-2.5" /> {diagramCount}
                      </span>
                    )}
                    {overflows && (
                      <span
                        className="absolute bottom-0.5 left-0.5 rounded bg-amber-100/90 px-1 text-[9px] font-medium text-amber-700"
                        title="May overflow — this slide has more text than fits the exported slide. Consider splitting it (Edit view: “Split slide here”)."
                      >
                        long
                      </span>
                    )}
                  </span>
                </button>
                <div
                  className={`absolute right-1 top-1 flex gap-0.5 rounded bg-white/90 p-0.5 shadow-sm transition-opacity ${
                    isSel ? "opacity-100" : "opacity-0 group-hover/thumb:opacity-100"
                  }`}
                >
                  <RailBtn title="Move up" disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                    <ArrowUpIcon className="h-3 w-3" />
                  </RailBtn>
                  <RailBtn
                    title="Move down"
                    disabled={i === slides.length - 1}
                    onClick={() => reorder(i, i + 1)}
                  >
                    <ArrowDownIcon className="h-3 w-3" />
                  </RailBtn>
                  <RailBtn
                    title={
                      hasHeading
                        ? "Duplicate slide"
                        : "Add a heading to duplicate this slide"
                    }
                    disabled={!hasHeading}
                    onClick={() => duplicateSlide(s)}
                  >
                    <CopyIcon className="h-3 w-3" />
                  </RailBtn>
                  <RailBtn
                    title="Delete slide"
                    disabled={slides.length <= 1}
                    onClick={() => deleteSlide(i)}
                  >
                    <TrashIcon className="h-3 w-3" />
                  </RailBtn>
                </div>
              </div>
            );
          })}
        </div>
        <button
          onClick={addSlide}
          className="m-3 mt-0 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 py-2 text-sm text-ink-faint hover:border-accent/40 hover:text-accent"
        >
          <PlusIcon className="h-4 w-4" /> Add slide
        </button>
      </aside>

      {/* ---- canvas ---- */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-6 py-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled Deck"
            className="min-w-[8rem] flex-1 bg-transparent text-lg font-bold text-ink outline-none placeholder:text-ink-faint/40"
          />
          {/* Slide design group: layout (manual) + AI content (safe, non-destructive). */}
          <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50/60 p-1">
            <LayoutPicker
              current={current ? resolveLayout(current) : "title-content"}
              hasOverride={current ? hasLayoutOverride(current) : false}
              disabled={!layoutTarget}
              onPick={(l) => {
                if (!layoutTarget) return;
                setChunkLayout(layoutTarget.id, l);
                // The edit view shows raw chunks, not the layout — jump to
                // Preview so the pick is visible immediately at full size (the
                // v1.2 "layout not applied" report).
                if (view === "edit") setView("preview");
              }}
            />
            <button
              onClick={() => layoutTarget && void suggestSlideLayout(layoutTarget.id)}
              disabled={!!globalBusy || !layoutTarget}
              title="Ask the AI to pick the best layout for this slide's content. The text is untouched — only the layout changes (pick Auto to clear it)."
              className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100 disabled:opacity-40"
            >
              <SparklesIcon className="h-4 w-4" /> AI layout
            </button>
            {/* Req 2: detach a slide (its own AI summary) vs re-link it to the prose.
                A rewrite that edits the shared document text ("Bulletize") lives as a
                per-paragraph action in ChunkAiMenu instead — this is the only slide-level
                AI action, so it can't be confused with a second, overlapping one. */}
            {detached ? (
              <>
                <span
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
                  title="This slide shows its own summary, independent of the document text"
                >
                  ✂ Detached
                </span>
                <button
                  onClick={() => leadId && setSlideBody(leadId, null)}
                  title="Re-link this slide to the document text (discards the summary)"
                  className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100"
                >
                  Re-link
                </button>
              </>
            ) : (
              <button
                onClick={() => leadId && void summarizeSlide(currentTextIds, leadId)}
                disabled={!!globalBusy || currentTextIds.length === 0 || !leadId}
                title="Summarize this slide's text into its own bullets (AI). Non-destructive — the document text is unchanged; layout stays on Auto unless you pin one above."
                className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100 disabled:opacity-40"
              >
                <SparklesIcon className="h-4 w-4" /> Summarize → slide
              </button>
            )}
          </div>
          <button
            onClick={() => {
              const h = current && headingOf(current);
              if (h) mergeSlideIntoPrevious(h.id);
            }}
            // The first slide has nothing before it; a heading-less (leading)
            // slide has no delimiter to demote — only ever true for slide 1.
            disabled={selected === 0 || !current || !headingOf(current)}
            title="Merge this slide into the previous one — its title becomes a paragraph (⌘/Ctrl+Z to undo)"
            className="rounded-md border border-gray-300 px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100 disabled:opacity-40"
          >
            Merge into previous
          </button>
          <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-200 text-sm">
            {(["edit", "preview"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setView(m)}
                className={`px-3 py-1 ${
                  view === m ? "bg-accent text-white" : "bg-white text-ink-soft hover:bg-gray-100"
                }`}
              >
                {m === "edit" ? "Edit" : "Preview"}
              </button>
            ))}
          </div>
          <button
            onClick={startPresent}
            title="Present full screen"
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100"
          >
            <PresentIcon className="h-4 w-4" /> Present
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-100 p-6">
          <div className="mx-auto w-full max-w-[900px]">
            <div className="mb-2 flex items-center justify-between text-xs text-ink-faint">
              <span>
                Slide {slides.length ? selected + 1 : 0} / {slides.length}
              </span>
              {current && (
                <span className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
                  {layoutLabel(resolveLayout(current))}
                </span>
              )}
            </div>
            {!current ? (
              <div className="flex aspect-[16/9] items-center justify-center rounded-lg border border-gray-300 bg-white text-sm text-ink-faint">
                No slides yet — click “Add slide”.
              </div>
            ) : view === "edit" ? (
              <div className="aspect-[16/9] w-full overflow-auto rounded-lg border border-gray-300 bg-white shadow-md">
                {detached ? (
                  // Req 2: a detached slide edits its OWN summary, not the prose.
                  <DetachedSlideBody slide={current} />
                ) : (
                  <div className="space-y-3 px-12 py-8">
                    {current.items.map((c, k) => {
                      const bounds = slideMoveBounds(current.items, k);
                      return (
                        <div key={c.id} className="group/row">
                          {/* Split affordance on body rows: a heading inserted
                              BEFORE this chunk starts a new slide here. */}
                          {c.metadata.chunkType !== "heading" && (
                            <button
                              onClick={() => {
                                const id = splitSlideBefore(c.id);
                                if (id) setAnchor(id);
                              }}
                              title="Start a new slide here — this paragraph and everything below it move to a new slide (⌘/Ctrl+Z to undo)"
                              className="mb-1 flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-transparent px-2 py-0.5 text-[11px] text-ink-faint opacity-0 transition-opacity hover:border-gray-300 hover:bg-gray-50 hover:text-ink-soft group-hover/row:opacity-100"
                            >
                              <ScissorsIcon className="h-3 w-3" /> Split slide here
                            </button>
                          )}
                          <ChunkView
                            chunkId={c.id}
                            index={current.indices[k]}
                            total={chunks.length}
                            // B2/UI4/D4: keep editing inside the slide — move within the
                            // slide only, navigate/merge within its chunks, and don't let
                            // typing "# " or demoting a heading silently re-cut slides.
                            slideScope={{
                              ids: current.items.map((x) => x.id),
                              canMoveUp: bounds.canUp,
                              canMoveDown: bounds.canDown,
                              moveUp: () => moveChunk(c.id, -1),
                              moveDown: () => moveChunk(c.id, 1),
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-300 shadow-md">
                <SlideStage slide={current} layout={resolveLayout(current)} docTitle={title} placeholders />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- present overlay ---- */}
      {presenting && slides[pIdx] && (
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-black"
          onClick={() => setPresenting(false)}
        >
          <div
            className="flex flex-1 items-center justify-center p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-[1280px] shadow-2xl">
              <SlideStage slide={slides[pIdx]} layout={resolveLayout(slides[pIdx])} docTitle={title} />
            </div>
          </div>
          <div
            className="flex items-center justify-center gap-5 pb-6 text-sm text-white/70"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPresentIdx((i) => Math.max(0, i - 1))}
              disabled={pIdx === 0}
              className="hover:text-white disabled:opacity-30"
            >
              ‹ Prev
            </button>
            <span className="tabular-nums">
              {pIdx + 1} / {slides.length}
            </span>
            <button
              onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}
              disabled={pIdx === slides.length - 1}
              className="hover:text-white disabled:opacity-30"
            >
              Next ›
            </button>
            <button onClick={() => setPresenting(false)} className="hover:text-white">
              Esc to exit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RailBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-0.5 text-ink-faint hover:bg-gray-100 hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * A visual layout picker: a button showing the slide's current layout by name,
 * opening a popover of small wireframe swatches (Auto + each LAYOUT_META
 * entry) instead of a bare `<select>` of enum strings — the raw values
 * ("section"/"title-content"/"title-image") gave no hint what they actually
 * did. "Auto" clears the override so the layout goes back to tracking the
 * slide's content (an image → an image layout, no body → section); it's the
 * only way back once a concrete layout has been picked.
 */
function LayoutPicker({
  current,
  hasOverride,
  disabled,
  onPick,
}: {
  current: SlideLayout;
  hasOverride: boolean;
  disabled: boolean;
  onPick: (layout: SlideLayout | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (layout: SlideLayout | null) => {
    onPick(layout);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Slide layout — where the title, bullets and image sit"
        className={`flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-ink-soft hover:bg-gray-100 disabled:opacity-40 ${
          open ? "border-accent/50" : ""
        }`}
      >
        <SlidesIcon className="h-4 w-4" /> Layout: {hasOverride ? layoutLabel(current) : "Auto"}
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[22rem] rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => pick(null)}
              title="Pick automatically from this slide's content: an image → an image layout, no body text → section, otherwise bullets."
              className={`flex flex-col items-center gap-1 rounded-md border p-1.5 hover:border-accent/50 ${
                !hasOverride ? "border-accent ring-1 ring-accent" : "border-transparent"
              }`}
            >
              <LayoutGlyph kind="auto" />
              <span className="text-[11px] text-ink-soft">Auto</span>
            </button>
            {LAYOUT_META.map((l) => (
              <button
                key={l.value}
                onClick={() => pick(l.value)}
                title={l.hint}
                className={`flex flex-col items-center gap-1 rounded-md border p-1.5 hover:border-accent/50 ${
                  hasOverride && current === l.value ? "border-accent ring-1 ring-accent" : "border-transparent"
                }`}
              >
                <LayoutGlyph kind={l.value} />
                <span className="text-[11px] text-ink-soft">{l.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A small wireframe preview of a layout — title bar, bullet lines, image block. */
function LayoutGlyph({ kind }: { kind: SlideLayout | "auto" }) {
  const frame =
    "relative flex h-9 w-16 shrink-0 flex-col gap-1 overflow-hidden rounded border border-gray-300 bg-white p-1";
  const bar = "shrink-0 rounded-sm bg-gray-300";
  const img = "rounded-sm bg-accent/40";
  const lines = (n: number) => (
    <div className="flex flex-1 flex-col justify-center gap-0.5">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={`${bar} h-0.5 ${i === n - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );

  if (kind === "auto") {
    return (
      <div className={`${frame} items-center justify-center border-dashed`}>
        <span className="text-[9px] font-medium text-ink-faint">Auto</span>
      </div>
    );
  }
  if (kind === "section") {
    return (
      <div className={`${frame} items-center justify-center`}>
        <div className={`${bar} h-1 w-7`} />
        <div className={`${bar} h-0.5 w-5 opacity-70`} />
      </div>
    );
  }
  const titleBar = <div className={`${bar} h-1 w-full`} />;
  if (kind === "title-content") {
    return (
      <div className={frame}>
        {titleBar}
        {lines(3)}
      </div>
    );
  }
  if (kind === "title-image") {
    return (
      <div className={frame}>
        {titleBar}
        <div className="flex flex-1 gap-1">
          {lines(2)}
          <div className={`${img} flex-1`} />
        </div>
      </div>
    );
  }
  if (kind === "title-image-left") {
    return (
      <div className={frame}>
        {titleBar}
        <div className="flex flex-1 gap-1">
          <div className={`${img} flex-1`} />
          {lines(2)}
        </div>
      </div>
    );
  }
  // image-top
  return (
    <div className={frame}>
      {titleBar}
      <div className={`${img} flex-[1.4]`} />
      {lines(1)}
    </div>
  );
}

/**
 * Editor for a "detached" slide (Req 2): its title plus its own summary bullets,
 * edited independently of the document prose. The bullet textarea is uncommitted
 * while typing and saved on blur (so it doesn't spam undo history); its `key`
 * is the current body so a re-summarize replaces the text.
 */
function DetachedSlideBody({ slide }: { slide: SlideGroup }) {
  const setSlideBody = useStore((s) => s.setSlideBody);
  const updateChunkContent = useStore((s) => s.updateChunkContent);
  const heading = headingOf(slide);
  const lead = heading ?? slide.items[0];
  const leadId = lead?.id;
  const body = lead?.metadata.slideBody ?? [];
  if (!leadId) return null;
  return (
    <div className="flex h-full flex-col gap-3 px-12 py-8">
      {heading ? (
        <input
          value={heading.content}
          onChange={(e) => updateChunkContent(heading.id, e.target.value)}
          placeholder="Slide title"
          className="w-full bg-transparent text-2xl font-bold text-ink outline-none placeholder:text-ink-faint/40"
        />
      ) : (
        <div className="text-2xl font-bold text-ink-faint">Untitled slide</div>
      )}
      <textarea
        key={body.join("|")}
        defaultValue={body.join("\n")}
        onBlur={(e) =>
          setSlideBody(
            leadId,
            e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
          )
        }
        placeholder="One bullet per line…"
        className="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 bg-gray-50/60 p-3 font-serif text-[1.05rem] leading-8 text-ink-soft outline-none focus:border-accent/40"
      />
      <div className="shrink-0 text-xs text-ink-faint">
        Detached slide — shows this summary instead of the document text. Edit here (one bullet per
        line); click “Re-link” above to reconnect to the text.
      </div>
    </div>
  );
}

interface StageProps {
  slide: SlideGroup;
  layout: SlideLayout;
  docTitle: string;
  // Edit/Preview surfaces only: render an image layout's EMPTY image region as
  // a dashed placeholder so picking one is immediately visible. Present leaves
  // it unset and keeps the full-width fallback — parity with pptx.rs, which has
  // no placeholder concept (see SlideContent).
  placeholders?: boolean;
}

/** Skip re-rendering a slide whose rendered content/layout/title didn't change (D6). */
function stageEqual(a: StageProps, b: StageProps): boolean {
  if (
    a.layout !== b.layout ||
    a.docTitle !== b.docTitle ||
    a.placeholders !== b.placeholders
  ) {
    return false;
  }
  if (a.slide.items.length !== b.slide.items.length) return false;
  return a.slide.items.every((c, i) => {
    const d = b.slide.items[i];
    return (
      c.id === d.id &&
      c.content === d.content &&
      c.metadata.chunkType === d.metadata.chunkType &&
      c.metadata.layout === d.metadata.layout &&
      c.metadata.subtitle === d.metadata.subtitle &&
      c.metadata.slideBody === d.metadata.slideBody &&
      // The multi-image grid derives from type+content+slot, so comparing slot
      // here keeps the visuals list (order included) covered too.
      c.metadata.slot === d.metadata.slot
    );
  });
}

/**
 * A slide rendered at the fixed 1280×720 design size and CSS-scaled to fill its
 * container — gives true-to-export WYSIWYG at any size (thumbnail/preview/present).
 * Memoised so editing one slide doesn't re-render (or re-observe) the others (D6).
 */
const SlideStage = memo(function SlideStage({ slide, layout, docTitle, placeholders }: StageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / DESIGN_W);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative aspect-[16/9] w-full overflow-hidden bg-white">
      {scale > 0 && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: DESIGN_W,
            height: DESIGN_H,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <SlideContent slide={slide} layout={layout} docTitle={docTitle} placeholders={placeholders} />
        </div>
      )}
    </div>
  );
}, stageEqual);

/** The slide content at design size (1280×720). Mirrors the PPTX layouts. */
function SlideContent({ slide, layout, docTitle, placeholders }: StageProps) {
  const title = slideTitle(slide, docTitle) || "Untitled slide";
  const bullets = slideBullets(slide);
  const visuals = slideImages(slide); // ordered visuals (multi-image grid)
  const diagramCount = slideDiagrams(slide).length;
  const subtitle = slideSubtitle(slide); // explicit subtitle chunk (Req 3)
  const ink = "#1f2933";
  const soft = "#3e4c59";
  const accent = "#2563eb";

  // D3: diagrams aren't rendered into the slide canvas (or .pptx) yet — show a
  // note so they don't silently vanish from Preview/Present.
  const diagramNote =
    diagramCount > 0 ? (
      <div style={{ marginTop: 20, fontSize: 18, color: soft, fontStyle: "italic" }}>
        {diagramCount} diagram{diagramCount > 1 ? "s" : ""} in the editor — not yet shown on
        slides or exported to .pptx.
      </div>
    ) : null;

  if (layout === "section") {
    // D1: mirror the PPTX section layout — a big centred title plus a subtitle:
    // an explicit subtitle chunk (Req 3), else the first bullet (positional
    // fallback, matching AI Draft).
    const sectionSubtitle = subtitle ?? bullets[0];
    return (
      <div
        style={{ width: DESIGN_W, height: DESIGN_H, padding: 96 }}
        className="flex flex-col items-center justify-center text-center"
      >
        <div style={{ fontSize: 64, fontWeight: 700, color: ink, lineHeight: 1.15 }}>
          {title}
        </div>
        {sectionSubtitle && (
          <div style={{ marginTop: 28, fontSize: 30, color: soft, lineHeight: 1.3 }}>
            {sectionSubtitle}
          </div>
        )}
        {diagramNote}
      </div>
    );
  }

  const titleEl = (
    <div style={{ fontSize: 48, fontWeight: 700, color: ink, marginBottom: subtitle ? 8 : 36, lineHeight: 1.2 }}>
      {title}
    </div>
  );
  // An explicit subtitle (Req 3) shows just under the title on content layouts.
  const subtitleEl = subtitle ? (
    <div style={{ fontSize: 28, color: soft, marginBottom: 28, lineHeight: 1.3 }}>{subtitle}</div>
  ) : null;
  const bulletsEl = (
    <ul style={{ display: "flex", flexDirection: "column", gap: 18, margin: 0, padding: 0 }}>
      {bullets.map((b, i) => (
        <li key={i} style={{ display: "flex", gap: 14, fontSize: 30, lineHeight: 1.35, color: soft }}>
          <span style={{ color: accent }}>•</span>
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );

  // Image-capable layouts reserve their image column/band when a visual really
  // shows (mirrors pptx.rs's build_slide) OR, on the edit/preview surfaces
  // (`placeholders`), when the layout was chosen but no image exists yet — a
  // dashed stand-in makes the pick immediately visible (the v1.2 "layout not
  // applied" fix). Present and the export keep the full-width fallback below,
  // so what you PRESENT/export never shows a blank column pptx.rs doesn't.
  const showImageRegion = visuals.length > 0 || !!placeholders;

  if ((layout === "title-image" || layout === "title-image-left") && showImageRegion) {
    // The layout's EXISTING image region: the 45% column (right, or left for
    // the "-left" variant), subdivided by the multi-image grid.
    const regionEl = (
      <div style={{ position: "relative", flex: "0 0 45%", minHeight: 0 }}>
        {visuals.length > 0 ? (
          <ImageRegionGrid layout={layout} visuals={visuals} />
        ) : (
          <ImagePlaceholder />
        )}
      </div>
    );
    const bodyEl = (
      <div style={{ flex: "1 1 0", overflow: "hidden" }}>
        {bulletsEl}
        {diagramNote}
      </div>
    );
    return (
      <div style={{ width: DESIGN_W, height: DESIGN_H, padding: 80 }} className="flex flex-col">
        {titleEl}
        {subtitleEl}
        <div style={{ display: "flex", gap: 48, flex: 1, minHeight: 0 }}>
          {layout === "title-image-left" ? (
            <>
              {regionEl}
              {bodyEl}
            </>
          ) : (
            <>
              {bodyEl}
              {regionEl}
            </>
          )}
        </div>
      </div>
    );
  }

  if (layout === "image-top" && showImageRegion) {
    return (
      <div style={{ width: DESIGN_W, height: DESIGN_H, padding: 80 }} className="flex flex-col">
        {titleEl}
        {subtitleEl}
        <div style={{ display: "flex", flexDirection: "column", gap: 24, flex: 1, minHeight: 0 }}>
          {/* The layout's EXISTING image region: the top 48% band. */}
          <div style={{ position: "relative", height: "48%", flexShrink: 0 }}>
            {visuals.length > 0 ? (
              <ImageRegionGrid layout={layout} visuals={visuals} />
            ) : (
              <ImagePlaceholder />
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {bulletsEl}
            {diagramNote}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: DESIGN_W, height: DESIGN_H, padding: 80 }} className="flex flex-col">
      {titleEl}
      {subtitleEl}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {bulletsEl}
        {diagramNote}
      </div>
    </div>
  );
}

// Multi-image grid cell gap at design size (1280×720) — pptx.rs uses 114300 EMU.
const IMAGE_CELL_GAP = 12;

/**
 * The visuals inside a layout's image region: up to MAX_SLIDE_IMAGES images
 * placed on the `splitImageRegion` grid, each aspect-fit and centred in its
 * cell, plus a "+N more" pill when the slide carries extras. The gap mapping —
 * pos = f·(100% + gap), extent = f·(100% + gap) − gap over the gapless fraction
 * rects — reproduces pptx.rs's even columns×rows split with a fixed gap between
 * cells; keep the two sides of that contract in sync.
 */
function ImageRegionGrid({ layout, visuals }: { layout: SlideLayout; visuals: Chunk[] }) {
  const shown = visuals.slice(0, MAX_SLIDE_IMAGES);
  const cells = splitImageRegion(layout, shown.length);
  const extra = visuals.length - shown.length;
  const pos = (f: number) => `calc(${f} * (100% + ${IMAGE_CELL_GAP}px))`;
  const size = (f: number) => `calc(${f} * (100% + ${IMAGE_CELL_GAP}px) - ${IMAGE_CELL_GAP}px)`;
  return (
    <>
      {shown.map((c, i) => (
        <div
          key={c.id}
          style={{
            position: "absolute",
            left: pos(cells[i].x),
            top: pos(cells[i].y),
            width: size(cells[i].w),
            height: size(cells[i].h),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={c.content}
            alt=""
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }}
          />
        </div>
      ))}
      {extra > 0 && (
        <div
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            borderRadius: 999,
            background: "rgba(31, 41, 51, 0.75)",
            color: "#fff",
            fontSize: 18,
            padding: "4px 14px",
          }}
          title={`${extra} more image${extra > 1 ? "s" : ""} on this slide — only the first ${MAX_SLIDE_IMAGES} are shown and exported`}
        >
          +{extra} more
        </div>
      )}
    </>
  );
}

/**
 * Dashed stand-in for an image layout's EMPTY image region — edit/preview only
 * (see StageProps.placeholders): the layout pick becomes visible immediately
 * even before an image exists, while Present/export keep the full-width
 * fallback for pptx.rs parity.
 */
function ImagePlaceholder() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        border: "3px dashed #cbd2d9",
        borderRadius: 12,
        color: "#9aa5b1",
        fontSize: 26,
      }}
    >
      <ImageIcon width={32} height={32} /> Image
    </div>
  );
}
