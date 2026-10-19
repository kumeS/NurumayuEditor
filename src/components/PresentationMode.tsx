// Presentation overlay (item 1-3 — 開発.txt Stage 1): it fills the app window
// (fixed inset-0); switching the OS window to native full screen is planned,
// so no copy here promises "full screen". Slide-by-slide
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
// Layout: the slide is sized by the stage's height as well as its width
// (container query units), so in a short window — or with notes open — the
// slide shrinks instead of pushing the notes and the control bar off-screen.
// Notes keep their line breaks and scroll past 30vh.
//
// Start and exit (BUG-009, QA 20261003): Present starts on the focused chunk's
// slide (`currentSlideIndex`, the rail's rule), and every way out — Esc, the ×,
// "Esc to exit", the empty deck's button — goes through `exit`, which focuses
// the lead chunk of the slide on screen (`presentationExitFocus`). So the
// Slides editor shows that slide afterwards and the next Present resumes there.
// `exit` also hands DOM focus back to the focused chunk's field when one is
// mounted (review follow-up C16, QA 20261003), whichever slide it exits on.
//
// Testing: this is a highly interactive, highly visual surface (window-filling
// keyboard-driven slideshow) — full keyboard + rendering integration testing
// here is disproportionate to the value it adds over the existing SlideStage/
// slides.ts unit coverage, so it is deliberately not attempted. The PURE logic
// this component is built on is extracted and unit-tested: the next/previous
// index math, clamped at the deck's bounds (`clampPresentIndex`, store.test.ts
// — "arrow-key navigation never goes out of bounds" is exactly the kind of
// user-visible claim this project's testing rules require a guard for), and
// the start/exit slide rules (slideCommands.test.ts, store.test.ts). That
// every exit control uses `exit` is a source-contract guard
// (slidePresentPolish.test.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { clampPresentIndex, useStore } from "../store";
import { groupSlides, resolveLayout, slideNotes } from "../slides";
import { currentSlideIndex, presentationExitFocus } from "../slideCommands";
import { focusChunkRange } from "./ChunkView";
import { SlideStage } from "./SlideEditor";
import { CloseIcon } from "./icons";
import { useModalStack } from "./Modal";

export default function PresentationMode() {
  const t = useT();
  const chunks = useStore((s) => s.doc.chunks);
  const title = useStore((s) => s.doc.title);
  const focusedChunkId = useStore((s) => s.focusedChunkId);
  const closePresentation = useStore((s) => s.closePresentation);

  const slides = groupSlides(chunks);

  // Resume on whichever slide holds the currently-focused chunk (the rail's
  // own rule; the rail's local anchor is not visible here), else the first.
  const initialIdx = currentSlideIndex(slides, focusedChunkId, null);
  const [idx, setIdx] = useState(initialIdx);
  const [notesOpen, setNotesOpen] = useState(false);

  // BUG-009: leave on the slide on screen. The deck and focus are read at exit
  // time — the deck may have changed while presenting (presentationExitFocus
  // clamps `idx`). Every exit control and Esc call this, never
  // closePresentation directly.
  // Then hand the caret back (review follow-up C16, QA 20261003): the overlay
  // holds DOM focus, so without this an exit on the slide that already held
  // the focused chunk left focus on body. focusChunkRange runs the chunk's
  // registered focuser when it is mounted (even for an unchanged id); a lead
  // not mounted yet (another slide in the Slides editor) mounts after this
  // and its own focus effect places the caret. No caret in the Slides Preview
  // sub-view, on a detached slide or in the Markdown view (no chunk field is
  // mounted there).
  const exit = useCallback(() => {
    const st = useStore.getState();
    const id = presentationExitFocus(groupSlides(st.doc.chunks), idx, st.focusedChunkId);
    closePresentation(id);
    const target = id ?? st.focusedChunkId;
    if (target) focusChunkRange(target);
  }, [idx, closePresentation]);

  // Take keyboard focus when the overlay opens (review follow-up, QA
  // 20261003): started from the palette, focus otherwise returned to a hidden
  // editor field underneath, so typed keys edited the document behind the
  // overlay. Not while a modal is open: the overlay mounts in the same commit
  // that closes the palette, under an `inert` ancestor where focus() is a
  // no-op — the effect re-runs once the modal stack is empty (and Modal keeps
  // a focus placed since its close). Focus already inside the overlay is left
  // alone. The Tab order still reaches controls behind it (KI-34).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modalOpen = useModalStack((s) => s.stack.length > 0);
  const hasSlide = idx < slides.length;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || modalOpen) return;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [modalOpen, hasSlide]);

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
        exit();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setNotesOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, exit]);

  const current = slides[idx];

  // Empty-deck state: a clear message plus a VISIBLE exit affordance (not just
  // the invisible Escape key) — every control needs a visible label, and an
  // empty state needs a visible way out too.
  if (!current) {
    return (
      <div ref={rootRef} tabIndex={-1} className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-black text-white outline-none">
        <div className="text-lg font-medium">{t("This deck has no slides yet")}</div>
        <div className="text-sm text-white/60">
          {t("Add a slide in the Slides view, then present again.")}
        </div>
        <button
          onClick={exit}
          title={t("Exit presentation")}
          className="mt-2 rounded-md border border-white/30 px-4 py-1.5 text-sm text-white hover:bg-white/10"
        >
          {t("Exit presentation")}
        </button>
      </div>
    );
  }

  const notes = slideNotes(current);

  return (
    <div ref={rootRef} tabIndex={-1} className="fixed inset-0 z-[200] flex flex-col bg-black outline-none">
      <button
        onClick={exit}
        title={t("Exit presentation (Esc)")}
        aria-label={t("Exit presentation")}
        className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
      >
        <CloseIcon className="h-5 w-5" />
      </button>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 [container-type:size]">
        <div className="w-[min(100%,1280px,calc(100cqh*16/9))] shadow-2xl">
          <SlideStage slide={current} layout={resolveLayout(current)} docTitle={title} />
        </div>
      </div>

      {notesOpen && (
        <div className="mx-auto mb-2 w-full max-w-[1280px] shrink-0 px-6">
          <div className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/15 bg-white/5 p-3 text-sm leading-6 text-white/80">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">
              {t("Speaker notes")}
            </div>
            {notes ? notes : <span className="italic text-white/40">{t("No notes for this slide.")}</span>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-5 pb-6 text-sm text-white/70">
        <button
          onClick={() => setIdx((i) => clampPresentIndex(i, -1, slides.length))}
          disabled={idx === 0}
          title={t("Previous slide (←)")}
          className="hover:text-white disabled:opacity-30"
        >
          ‹ {t("Prev")}
        </button>
        <span className="tabular-nums">
          {idx + 1} / {slides.length}
        </span>
        <button
          onClick={() => setIdx((i) => clampPresentIndex(i, 1, slides.length))}
          disabled={idx === slides.length - 1}
          title={t("Next slide (→ / Space)")}
          className="hover:text-white disabled:opacity-30"
        >
          {t("Next")} ›
        </button>
        <button
          onClick={() => setNotesOpen((v) => !v)}
          title={t("Toggle speaker notes (N)")}
          aria-pressed={notesOpen}
          className={`rounded px-2 py-0.5 hover:text-white ${notesOpen ? "text-white" : ""}`}
        >
          {t("Notes (N)")}
        </button>
        <button onClick={exit} title={t("Exit presentation")} className="hover:text-white">
          {t("Esc to exit")}
        </button>
      </div>
    </div>
  );
}
