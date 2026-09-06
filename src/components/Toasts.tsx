// Transient notifications (errors, confirmations). Auto-dismiss after a delay.

import { useEffect } from "react";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { Toast } from "../store";
import { CloseIcon } from "./icons";

function ToastItem({ toast }: { toast: Toast }) {
  const t = useT();
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const ms = toast.kind === "error" ? 7000 : 3500;
    const t = setTimeout(() => dismiss(toast.id), ms);
    return () => clearTimeout(t);
  }, [toast.id, toast.kind, dismiss]);

  const color =
    toast.kind === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : toast.kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-gray-200 bg-white text-ink-soft";

  return (
    <div
      className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-md ${color}`}
    >
      <span className="flex-1 whitespace-pre-wrap">{toast.message}</span>
      <button
        onClick={() => dismiss(toast.id)}
        className="mt-0.5 opacity-60 hover:opacity-100"
        aria-label={t("Dismiss")}
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
