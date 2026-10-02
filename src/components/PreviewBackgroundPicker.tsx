// Markdown preview background picker: a labelled toolbar button opening a small
// popover of swatches. The tones are shown as colour swatches (not a list of
// names) and every swatch carries a visible label and an accessible name.

import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { PREVIEW_SCOPE_NOTE } from "../markdownSurfaceHelp";
import {
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  previewBackgroundOf,
  setPreviewBackground,
} from "../previewBackground";
import { useStore } from "../store";

export default function PreviewBackgroundPicker() {
  const t = useT();
  const current = useStore((s) => previewBackgroundOf(s.settings));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title={`${t("Preview background")}: ${t(PREVIEW_BACKGROUND_LABELS[current])}\n${t(PREVIEW_SCOPE_NOTE)}`}
        className="flex items-center gap-1.5 rounded-md border border-ink-faint/30 px-2 py-1.5 text-xs text-ink-soft shadow-sm hover:bg-accent/5"
      >
        <span
          data-preview-bg={current}
          aria-hidden="true"
          className="h-3 w-3 rounded-full border border-ink-faint/40"
        />
        {t("Background")}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("Preview background")}
          className="absolute right-0 top-9 z-30 w-44 rounded-lg border border-ink-faint/30 bg-white p-1 shadow-lg"
        >
          {PREVIEW_BACKGROUNDS.map((tone) => (
            <button
              key={tone}
              type="button"
              role="menuitemradio"
              aria-checked={tone === current}
              onClick={() => {
                setOpen(false);
                void setPreviewBackground(tone);
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-accent/5 ${
                tone === current ? "font-medium text-ink" : ""
              }`}
            >
              <span
                data-preview-bg={tone}
                aria-hidden="true"
                className={`h-5 w-7 shrink-0 rounded border ${
                  tone === current ? "border-accent ring-1 ring-accent" : "border-ink-faint/40"
                }`}
              />
              {t(PREVIEW_BACKGROUND_LABELS[tone])}
              {tone === current && <span className="ml-auto text-accent" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
