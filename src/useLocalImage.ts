// Loads an image reference for display, reading local files through Rust.
//
// Every surface that shows a document image (Markdown preview, Editor image
// chunks, Slides/Presentation) goes through `useImageSource`, so a relative
// `figures/fig1.png` renders the same way in all three projections of the one
// document model.
//
// Caching: a figure is read once per cache scope and reused across re-renders
// (typing in Split, zooming) — base64 payloads of several MB must not cross IPC
// on every keystroke. App.tsx scopes the cache to the active tab + view mode,
// so switching tabs/views or reopening the file re-reads from disk and a
// regenerated figure shows up. Known limit: a figure rewritten on disk while
// its document stays open keeps the cached bytes until one of those events (or
// "Try again" on a failed image).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { resolveImageSource } from "./localImages";
import { useStore } from "./store";

export interface LocalImageCache {
  /** In-flight reads, so one figure used twice is read once. */
  pending: Map<string, Promise<string>>;
  /** Settled data URLs, so a remounted image paints without a loading flash. */
  ready: Map<string, string>;
}

export function createLocalImageCache(): LocalImageCache {
  return { pending: new Map(), ready: new Map() };
}

export const LocalImageCacheContext = createContext<LocalImageCache | null>(null);

// Used only when a surface renders outside App's provider.
const fallbackCache = createLocalImageCache();

export type ImageState =
  | { status: "ready"; src: string }
  | { status: "loading"; path: string }
  /** `reason` is a dictionary key (translated by the caller) unless `raw`. */
  | { status: "error"; reason: string; raw?: boolean; path?: string };

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function useImageSource(src: string | undefined): {
  state: ImageState;
  /** Drop the cached result and read again (for a failed or stale image). */
  retry: () => void;
  /** Report that the browser couldn't decode what we handed it. */
  markBroken: () => void;
} {
  const docPath = useStore((s) => s.filePath);
  const cache = useContext(LocalImageCacheContext) ?? fallbackCache;
  const resolved = useMemo(() => resolveImageSource(src, docPath), [src, docPath]);
  const path = resolved.kind === "local" ? resolved.path : null;

  const [nonce, setNonce] = useState(0);
  const [broken, setBroken] = useState(false);
  // Tagged with the path it belongs to, so a changed `src` never paints the
  // previous figure while the new one loads.
  const [local, setLocal] = useState<{ path: string; state: ImageState } | null>(() =>
    path && cache.ready.has(path)
      ? { path, state: { status: "ready", src: cache.ready.get(path) as string } }
      : null
  );
  const setLocalState = useCallback((next: ImageState) => {
    if (path) setLocal({ path, state: next });
  }, [path]);

  useEffect(() => {
    setBroken(false);
    if (!path) return;
    const hit = cache.ready.get(path);
    if (hit) {
      setLocalState({ status: "ready", src: hit });
      return;
    }
    let cancelled = false;
    let pending = cache.pending.get(path);
    if (!pending) {
      pending = api.readLocalImage(path);
      cache.pending.set(path, pending);
      pending.then(
        (dataUrl) => {
          cache.ready.set(path, dataUrl);
          cache.pending.delete(path);
        },
        // A failure is never cached: the next attempt reads again.
        () => cache.pending.delete(path)
      );
    }
    setLocalState({ status: "loading", path });
    pending.then(
      (dataUrl) => {
        if (!cancelled) setLocalState({ status: "ready", src: dataUrl });
      },
      (e) => {
        if (!cancelled) setLocalState({ status: "error", reason: message(e), raw: true, path });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path, nonce, cache, setLocalState]);

  const retry = useCallback(() => {
    if (path) {
      cache.ready.delete(path);
      cache.pending.delete(path);
    }
    setBroken(false);
    setNonce((n) => n + 1);
  }, [path, cache]);

  const markBroken = useCallback(() => setBroken(true), []);

  let state: ImageState;
  if (broken) {
    state = { status: "error", reason: "The image file could not be decoded.", path: path ?? undefined };
  } else if (resolved.kind === "direct") {
    state = { status: "ready", src: resolved.src };
  } else if (resolved.kind === "missing") {
    state = { status: "error", reason: "No image source." };
  } else if (resolved.kind === "needs-document-folder") {
    state = { status: "error", reason: "Save the document to show images with relative paths." };
  } else {
    state = local && local.path === resolved.path ? local.state : { status: "loading", path: resolved.path };
  }
  return { state, retry, markBroken };
}
