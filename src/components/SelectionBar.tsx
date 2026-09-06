// Floating action bar shown when one or more chunks are selected: generate one
// combined image, apply a single edit instruction to every selected paragraph
// at once (multi-paragraph editing), merge adjacent paragraphs into one, or
// read the selection aloud.

import { editSelection, generateImageFromSelection, speakChunks } from "../aiActions";
import { useT } from "../i18n";
import { canMergeChunks, useStore } from "../store";
import { promptDialog } from "./PromptModal";
import { EditIcon, ImageIcon, MergeIcon, SpeakerIcon, SpinnerIcon } from "./icons";

export default function SelectionBar() {
  const t = useT();
  const count = useStore((s) => s.selectedChunkIds.length);
  const selectedChunkIds = useStore((s) => s.selectedChunkIds);
  const clearSelection = useStore((s) => s.clearSelection);
  const globalBusy = useStore((s) => s.globalBusy);
  const mergeChunks = useStore((s) => s.mergeChunks);
  const notify = useStore((s) => s.notify);
  // Merge needs ≥2 adjacent TEXT chunks (item 3/4) — same check the store
  // action enforces, surfaced here as button enablement.
  const mergeable = useStore((s) => canMergeChunks(s.doc, s.selectedChunkIds));

  if (count === 0) return null;

  const onEditAll = async () => {
    const instruction = await promptDialog({
      title: `Edit ${count} paragraphs`,
      label: t("Describe the change to apply to every selected paragraph"),
      placeholder: "e.g. Make each more concise and formal",
      multiline: true,
      submitLabel: t("Apply to all"),
    });
    if (instruction && instruction.trim()) void editSelection(instruction);
  };

  const onMerge = () => {
    const n = selectedChunkIds.length;
    const merged = mergeChunks(selectedChunkIds);
    if (merged) notify(`Merged ${n} paragraphs.`, "success");
  };

  const onReadSelection = () => {
    // Speak in document order, not click order.
    const s = useStore.getState();
    const inOrder = s.doc.chunks
      .filter((c) => s.selectedChunkIds.includes(c.id))
      .map((c) => c.id);
    void speakChunks(inOrder);
  };

  return (
    <div className="pointer-events-auto fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-gray-200 bg-white px-4 py-2 shadow-lg">
      <span className="text-sm text-ink-soft">{count} selected</span>
      <button
        onClick={() => void onEditAll()}
        disabled={!!globalBusy}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-gray-100 disabled:opacity-50"
      >
        <EditIcon className="h-4 w-4" />{t("Edit all")}</button>
      <button
        onClick={onMerge}
        disabled={!!globalBusy || !mergeable}
        title={
          mergeable
            ? "Merge the selected paragraphs into one"
            : "Select 2+ adjacent text paragraphs to merge"
        }
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-gray-100 disabled:opacity-50"
      >
        <MergeIcon className="h-4 w-4" />{t("Merge")}</button>
      <button
        onClick={onReadSelection}
        disabled={!!globalBusy}
        title={t("Read the selected paragraphs aloud (document order)")}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-gray-100 disabled:opacity-50"
      >
        <SpeakerIcon className="h-4 w-4" /> Read
      </button>
      <button
        onClick={() => void generateImageFromSelection()}
        disabled={!!globalBusy}
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
      >
        {globalBusy ? (
          <SpinnerIcon className="text-white" />
        ) : (
          <ImageIcon className="h-4 w-4" />
        )}
        {t("Generate image")}
      </button>
      <button
        onClick={clearSelection}
        className="text-sm text-ink-faint hover:text-ink"
      >
        {t("Clear")}
      </button>
    </div>
  );
}
