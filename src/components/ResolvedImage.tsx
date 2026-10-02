// A document image as every view shows it: local paths (relative to the
// document's folder, absolute, or file://) are read through Rust, remote and
// data URLs pass straight through. The Markdown preview, Editor image chunks
// and Slides/Presentation all render through this, so a figure that shows in
// one projection shows in all of them.
//
// Failures are specific and recoverable: the placeholder says WHY (unsaved
// document, file not found, unsupported type, too large), carries the resolved
// path in its tooltip, and offers "Try again" for local files.

import type { CSSProperties } from "react";
import { useLang, useT } from "../i18n";
import { localizeImageError } from "../imageErrors";
import { useImageSource } from "../useLocalImage";

export default function ResolvedImage({
  src,
  alt,
  className,
  style,
  placeholderClassName,
}: {
  src: string | undefined;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Styling for the loading/error box, so it fits the surface (prose vs slide cell). */
  placeholderClassName: string;
}) {
  const t = useT();
  const lang = useLang();
  const { state, retry, markBroken } = useImageSource(src);

  if (state.status === "ready") {
    return (
      <img
        src={state.src}
        alt={alt ?? ""}
        loading="lazy"
        className={className}
        style={style}
        onError={markBroken}
      />
    );
  }

  if (state.status === "loading") {
    return (
      <span className={placeholderClassName} role="img" aria-busy="true" aria-label={alt || t("Image")} title={state.path}>
        {t("Loading image…")}
      </span>
    );
  }

  const reason = state.raw ? localizeImageError(state.reason, lang) : t(state.reason);
  return (
    <span
      className={placeholderClassName}
      role="img"
      aria-label={`${alt || t("Image")}: ${reason}`}
      title={state.path ? `${state.path}\n${reason}` : reason}
    >
      <span className="block">
        {t("Image could not be displayed")}
        {alt ? `: ${alt}` : "."}
      </span>
      <span className="mt-1 block text-xs">{reason}</span>
      {state.path && (
        <button
          type="button"
          onClick={retry}
          className="mt-2 rounded border border-ink-faint/40 px-2 py-0.5 text-xs text-ink-soft hover:bg-accent/5"
        >
          {t("Try again")}
        </button>
      )}
    </span>
  );
}
