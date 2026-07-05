// Fullscreen presentation overlay (item 1-3 — 開発.txt Stage 1): slide-by-slide
// presenting for a weekly lab-meeting talk, so it never needs a PPTX export
// step first. Opened from the Slide editor's "Present" button or the command
// palette ("Start presentation"); an ephemeral, UI-only overlay driven by the
// store's `presentationOpen` boolean — NOT a third `doc.mode` value (that's
// persisted per-document editor/slide state; see store.ts's comment on
// presentationOpen). Mounted as a SIBLING of the main view in App.tsx, wrapped
// in its own view-identity-keyed ErrorBoundary (App.tsx already keys its main
// boundary by tab+mode — this one is keyed "presentation:{activeTabId}" to
// match that rule).
//
// Rendering reuses SlideEditor's exported `SlideStage` directly — the SAME
// fixed 1280×720 design-size canvas, CSS-scaled to fit, that the thumbnail
// rail and Preview sub-view already use — so what's presented is guaranteed
// WYSIWYG-identical to Preview/export, not a second reimplementation.
//
// Keyboard: bare (unmodified) ArrowRight/Space advances, ArrowLeft goes back,
// Escape exits, lowercase "n" toggles a speaker-notes overlay for the CURRENT
// slide. These are intentionally NOT in the global useShortcuts.ts (which
// requires a modifier key on every binding) — they would collide with normal
// typing/navigation elsewhere in the app. Instead this component owns a
// window keydown listener scoped to its own mount lifecycle (added on mount,
// removed on unmount), active only while the overlay is open.
//
// Testing: this is a highly interactive, highly visual surface (fullscreen
// keyboard-driven slideshow) — full keyboard + rendering integration testing
// here is disproportionate to the value it adds over the existing SlideStage/
// slides.ts unit coverage, so it is deliberately not attempted. The PURE logic
// this component is built on (next/previous slide index math, clamped at the
// deck's bounds) is extracted into `clampPresentIndex` in store.ts and has a
// direct unit test in store.test.ts, since "arrow-key navigation never goes
// out of bounds" is exactly the kind of user-visible claim this project's
// testing rules require a guard for.

import { useEffect, useState } from "react";
import { clampPresentIndex, useStore } from "../store";
import { groupSlides, resolveLayout, slideNotes } from "../slides";
import { SlideStage } from "./SlideEditor";
import { CloseIcon } from "./icons";

export default function PresentationMode() {
  const chunks = useStore((s) => s.doc.chunks);
  const title = useStore((s) => s.doc.title);
  const focusedChunkId = useStore((s) => s.focusedChunkId);
  const closePresentation = useStore((s) => s.closePresentation);

  const slides = groupSlides(chunks);

  // Resume on whichever slide holds the currently-focused chunk (mirrors
  // SlideEditor's own "selected" derivation), else the first slide.
  const initialIdx = Math.max(
    0,
    slides.findIndex((s) => s.items.some((c) => c.id === focusedChunkId))
  );
  const [idx, setIdx] = useState(initialIdx);
  const [notesOpen, setNotesOpen] = useState(false);

  // B6-style re-clamp: if the deck shrinks while presenting (e.g. an undo),
  // don't leave the index pointing past the end.
  useEffect(() => {
    setIdx((i) => clampPresentIndex(i, 0, slides.length));
  }, [slides.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bare keys only — a modifier held down means this is some other
      // shortcut (e.g. ⌘/Ctrl+arrow), not presentation navigation.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setIdx((i) => clampPresentIndex(i, 1, slides.length));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx((i) => clampPresentIndex(i, -1, slides.length));
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePresentation();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setNotesOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, closePresentation]);

  const current = slides[idx];

  // Empty-deck state: a clear message plus a VISIBLE exit affordance (not just
  // the invisible Escape key) — every control needs a visible label, and an
  // empty state needs a visible way out too.
  if (!current) {
    return (
      <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-black text-white">
        <div className="text-lg font-medium">This deck has no slides yet</div>
        <div className="text-sm text-white/60">
          Add a slide in the Slides view, then present again.
        </div>
        <button
          onClick={closePresentation}
          title="Exit presentation"
          className="mt-2 rounded-md border border-white/30 px-4 py-1.5 text-sm text-white hover:bg-white/10"
        >
          Exit presentation
        </button>
      </div>
    );
  }

  const notes = slideNotes(current);

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-black">
      <button
        onClick={closePresentation}
        title="Exit presentation (Esc)"
        aria-label="Exit presentation"
        className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
      >
        <CloseIcon className="h-5 w-5" />
      </button>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[1280px] shadow-2xl">
          <SlideStage slide={current} layout={resolveLayout(current)} docTitle={title} />
        </div>
      </div>

      {notesOpen && (
        <div className="mx-auto mb-2 w-full max-w-[1280px] shrink-0 px-6">
          <div className="rounded-lg border border-white/15 bg-white/5 p-3 text-sm leading-6 text-white/80">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">
              Speaker notes
            </div>
            {notes ? notes : <span className="italic text-white/40">No notes for this slide.</span>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-5 pb-6 text-sm text-white/70">
        <button
          onClick={() => setIdx((i) => clampPresentIndex(i, -1, slides.length))}
          disabled={idx === 0}
          title="Previous slide (←)"
          className="hover:text-white disabled:opacity-30"
        >
          ‹ Prev
        </button>
        <span className="tabular-nums">
          {idx + 1} / {slides.length}
        </span>
        <button
          onClick={() => setIdx((i) => clampPresentIndex(i, 1, slides.length))}
          disabled={idx === slides.length - 1}
          title="Next slide (→ / Space)"
          className="hover:text-white disabled:opacity-30"
        >
          Next ›
        </button>
        <button
          onClick={() => setNotesOpen((v) => !v)}
          title="Toggle speaker notes (N)"
          className={`rounded px-2 py-0.5 hover:text-white ${notesOpen ? "text-white" : ""}`}
        >
          Notes (N)
        </button>
        <button onClick={closePresentation} title="Exit presentation" className="hover:text-white">
          Esc to exit
        </button>
      </div>
    </div>
  );
}
