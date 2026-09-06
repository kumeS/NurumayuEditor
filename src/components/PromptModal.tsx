// A small promise-based text-prompt dialog. Call `promptDialog({...})` from
// anywhere and `await` the user's input (or null on cancel). `<PromptHost/>`
// must be mounted once near the app root.

import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "./icons";
import { useT } from "../i18n";

interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  submitLabel?: string;
  /** Optional quick-pick chips. Clicking one resolves immediately with its value. */
  presets?: { label: string; value: string }[];
}

type Resolver = (value: string | null) => void;

let openImpl: ((opts: PromptOptions) => Promise<string | null>) | null = null;

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  if (!openImpl) return Promise.resolve(null);
  return openImpl(opts);
}

export function PromptHost() {
  const t = useT();
  const [opts, setOpts] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolverRef = useRef<Resolver | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    openImpl = (o: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        resolverRef.current = resolve;
        setValue(o.defaultValue ?? "");
        setOpts(o);
      });
    return () => {
      openImpl = null;
    };
  }, []);

  useEffect(() => {
    if (opts) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [opts]);

  if (!opts) return null;

  const finish = (result: string | null) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOpts(null);
  };

  const submit = () => finish(value.trim().length ? value : opts.defaultValue ?? "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={() => finish(null)}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">{opts.title}</h2>
          <button
            className="text-ink-faint hover:text-ink"
            onClick={() => finish(null)}
            aria-label={t("Close")}
          >
            <CloseIcon />
          </button>
        </div>
        {opts.label && (
          <label className="mb-1 block text-sm text-ink-soft">{opts.label}</label>
        )}
        {opts.presets && opts.presets.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {opts.presets.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => finish(p.value)}
                className="rounded-full border border-gray-200 px-3 py-1 text-sm text-ink-soft transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
              >
                {t(p.label)}
              </button>
            ))}
          </div>
        )}
        {opts.multiline ? (
          <textarea
            ref={(el) => {
              inputRef.current = el;
            }}
            value={value}
            placeholder={opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              if (e.key === "Escape") finish(null);
            }}
            rows={4}
            className="w-full resize-y rounded-md border border-gray-300 p-2 text-sm outline-none focus:border-accent"
          />
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el;
            }}
            value={value}
            placeholder={opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") finish(null);
            }}
            className="w-full rounded-md border border-gray-300 p-2 text-sm outline-none focus:border-accent"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-gray-100"
            onClick={() => finish(null)}
          >
            {t("Cancel")}
          </button>
          <button
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft"
            onClick={submit}
          >
            {opts.submitLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
