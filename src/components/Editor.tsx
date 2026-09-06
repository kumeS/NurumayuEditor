// The writing surface: document title + the ordered list of chunks.
//
// This component only subscribes to the *list of chunk ids* (and the title), so
// it re-renders on structural changes (add/remove/reorder) — not on every
// keystroke. Each ChunkView subscribes to its own chunk.

import type { DragEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { tNow, useT } from "../i18n";
import ChunkView from "./ChunkView";
import { PlusIcon } from "./icons";

/** Read a dropped/pasted image File as a data URL (in-memory Blob from the
 * OS drop or clipboard — not a disk path, so this stays client-side; no Rust
 * round-trip needed, unlike the file-picker path in fileActions.ts). */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/** Id of the chunk whose rendered element contains `target`, or null when the
 * drop/paste landed on empty space (append at the end in that case). */
function chunkIdFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-chunk-id]")?.dataset.chunkId ?? null;
}

export default function Editor() {
  const title = useStore((s) => s.doc.title);
  const setTitle = useStore((s) => s.setTitle);
  const addChunkAfter = useStore((s) => s.addChunkAfter);
  const setChunkSubtitle = useStore((s) => s.setChunkSubtitle);
  const focusedChunkId = useStore((s) => s.focusedChunkId);
  const chunkIds = useStore(useShallow((s) => s.doc.chunks.map((c) => c.id)));
  const t = useT();

  // Insert after the focused chunk (else append). "Subtitle" is a text chunk
  // flagged as a subtitle, which maps to the slide's subtitle in Slide mode.
  const addSubtitle = () => {
    const id = addChunkAfter(focusedChunkId, "text");
    setChunkSubtitle(id, true);
  };

  // Drag-and-drop image insertion: drop an image file onto a chunk (insert
  // after it) or onto empty space below the list (append at the end).
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    const targetId = chunkIdFromEventTarget(e.target);
    const s = useStore.getState();
    void (async () => {
      let afterId = targetId ?? (chunkIds.length > 0 ? chunkIds[chunkIds.length - 1] : null);
      for (const file of files) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          afterId = s.insertLocalImageAfter(afterId, dataUrl, file.name);
        } catch {
          s.notify(`Could not read "${file.name}".`, "error");
        }
      }
      s.notify(files.length > 1 ? `${files.length} ${tNow("images inserted.")}` : tNow("Image inserted."), "success");
    })();
  };

  // Paste an image from the clipboard near the focused chunk (e.g. a
  // screenshot copied from elsewhere) — same client-side FileReader path as
  // drag-and-drop, since clipboard items also arrive as in-memory Blobs.
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(e.clipboardData.items).find((it) => it.type.startsWith("image/"));
    if (!imageItem) return; // let normal text paste proceed
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    void (async () => {
      const s = useStore.getState();
      try {
        const dataUrl = await readFileAsDataUrl(file);
        s.insertLocalImageAfter(s.focusedChunkId, dataUrl, file.name || "pasted-image");
        s.notify(tNow("Image inserted."), "success");
      } catch {
        s.notify(tNow("Could not read the pasted image."), "error");
      }
    })();
  };

  return (
    <div
      className="mx-auto w-full max-w-prose px-12 py-16"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("Untitled Document")}
        className="mb-10 w-full bg-transparent font-sans text-4xl font-bold text-ink outline-none placeholder:text-ink-faint/40"
      />

      <div className="space-y-5">
        {chunkIds.map((id, i) => (
          <ChunkView key={id} chunkId={id} index={i} total={chunkIds.length} />
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
        <button
          onClick={() => addChunkAfter(focusedChunkId, "text")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-gray-100 hover:text-accent"
        >
          <PlusIcon /> {t("Add paragraph")}
        </button>
        <button
          onClick={() => addChunkAfter(focusedChunkId, "heading")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-gray-100 hover:text-accent"
          title={t("A heading is a slide title in Slide mode")}
        >
          <PlusIcon /> {t("Add heading")}
        </button>
        <button
          onClick={addSubtitle}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-gray-100 hover:text-accent"
          title={t("A subtitle sits under the title / slide title")}
        >
          <PlusIcon /> {t("Add subtitle")}
        </button>
      </div>
    </div>
  );
}
