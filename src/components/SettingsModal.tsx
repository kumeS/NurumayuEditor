// Settings dialog: OpenRouter endpoint, model, default translation language,
// temperature, and the API key (stored in the OS keychain via Rust — never
// echoed back to the frontend).

import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import { FONT_STACKS } from "../fonts";
import { useStore } from "../store";
import type { Settings } from "../types";
import { CloseIcon } from "./icons";

const DEFAULTS: Settings = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "deepseek/deepseek-v4-flash",
  models: [
    "deepseek/deepseek-v4-flash",
    "qwen/qwen3.6-flash",
    "meta-llama/llama-4-maverick",
    "moonshotai/kimi-k2.5",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-r1:free",
  ],
  imageModel: "google/gemini-2.5-flash-image",
  imageModels: [
    "google/gemini-2.5-flash-image",
    "x-ai/grok-imagine-image-quality",
    "recraft/recraft-v4-pro",
    "openai/gpt-5.4-image-2",
    "black-forest-labs/flux.2-klein-4b",
    "google/gemini-3-pro-image-preview",
  ],
  defaultTargetLanguage: "English",
  writingTone: "",
  temperature: 0.3,
  editorFontFamily: "serif",
  editorFontSize: 17,
  removedModels: [],
};

// Common languages for the default-language picker.
const LANGUAGES = [
  "English",
  "日本語",
  "中文",
  "한국어",
  "Español",
  "Français",
  "Deutsch",
  "Português",
  "Italiano",
  "Русский",
  "العربية",
];

// Writing-tone presets. The value is the phrase sent to the model and applied
// to every writing action (proofread/expand/… and drafts) for a consistent
// voice; an empty value keeps the model's neutral academic default.
const WRITING_TONES: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "Blog", value: "engaging, conversational blog" },
  { label: "Memo", value: "concise, plain note/memo" },
  { label: "Report", value: "structured, factual business report" },
  { label: "Scientific", value: "objective, precise scientific" },
  { label: "Academic paper", value: "formal scholarly academic-paper" },
];

/** Ensure each active model always appears in its selectable list. */
function withActiveModels(s: Settings): Settings {
  const models = s.models?.length ? s.models : DEFAULTS.models;
  const imageModels = s.imageModels?.length ? s.imageModels : DEFAULTS.imageModels;
  return {
    ...s,
    models: models.includes(s.model) ? models : [s.model, ...models],
    imageModels: imageModels.includes(s.imageModel)
      ? imageModels
      : [s.imageModel, ...imageModels],
  };
}

export default function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const closeSettings = useStore((s) => s.closeSettings);
  const storedSettings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const setHasApiKey = useStore((s) => s.setHasApiKey);
  const notify = useStore((s) => s.notify);

  const [form, setForm] = useState<Settings>(withActiveModels(storedSettings ?? DEFAULTS));
  const [apiKey, setApiKey] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newImageModel, setNewImageModel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(withActiveModels(storedSettings ?? DEFAULTS));
      setApiKey("");
      setNewModel("");
      setNewImageModel("");
    }
  }, [open, storedSettings]);

  if (!open) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Generic add/remove that works on either model list (text or image).
  type ListKey = "models" | "imageModels";
  type ActiveKey = "model" | "imageModel";
  const addModelTo = (listKey: ListKey, activeKey: ActiveKey, raw: string) => {
    const id = raw.trim();
    if (!id) return;
    setForm((f) => ({
      ...f,
      [listKey]: f[listKey].includes(id) ? f[listKey] : [...f[listKey], id],
      [activeKey]: id, // select the newly added model
      // Re-adding a model lifts its tombstone (item 69).
      removedModels: (f.removedModels ?? []).filter((m) => m !== id),
    }));
  };
  const removeModelFrom = (listKey: ListKey, activeKey: ActiveKey, id: string) => {
    setForm((f) => {
      const list = f[listKey].filter((m) => m !== id);
      const safe = list.length ? list : [f[activeKey]];
      // Tombstone the removed id (item 69): the backend re-merges its built-in
      // defaults on every load, so without this a deleted built-in model would
      // silently reappear next launch. Harmless for custom ids.
      const removedModels = (f.removedModels ?? []).includes(id)
        ? f.removedModels ?? []
        : [...(f.removedModels ?? []), id];
      return {
        ...f,
        [listKey]: safe,
        [activeKey]: f[activeKey] === id ? safe[0] : f[activeKey],
        removedModels,
      };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(form);
      setSettings(form);
      if (apiKey.trim()) {
        await api.setApiKey(apiKey.trim());
        setHasApiKey(true);
      }
      notify("Settings saved.", "success");
      closeSettings();
    } catch (e) {
      notify(typeof e === "string" ? e : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    try {
      await api.deleteApiKey();
      setHasApiKey(false);
      setApiKey("");
      notify("API key removed from keychain.", "success");
    } catch (e) {
      notify(typeof e === "string" ? e : String(e), "error");
    }
  };

  const field = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-accent";
  const labelCls = "mb-1 block text-sm font-medium text-ink-soft";

  // Shared renderer for a selectable, editable model list (text or image).
  const renderModelList = (
    listKey: ListKey,
    activeKey: ActiveKey,
    addValue: string,
    setAddValue: (v: string) => void,
    placeholder: string,
    help: ReactNode
  ) => {
    const list = form[listKey];
    const active = form[activeKey];
    const add = () => {
      addModelTo(listKey, activeKey, addValue);
      setAddValue("");
    };
    return (
      <>
        <div className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-gray-300 p-1">
          {list.map((m) => {
            const isActive = active === m;
            return (
              <div key={m} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => update(activeKey, m)}
                  className={`flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
                    isActive
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-ink-soft hover:bg-gray-100"
                  }`}
                  title={m}
                >
                  <span className="mr-1 inline-block w-3">{isActive ? "✓" : ""}</span>
                  {m}
                </button>
                <button
                  type="button"
                  onClick={() => removeModelFrom(listKey, activeKey, m)}
                  disabled={list.length <= 1}
                  className="shrink-0 rounded px-1.5 text-ink-faint hover:text-red-500 disabled:opacity-30 disabled:hover:text-ink-faint"
                  title="Remove from list"
                  aria-label={`Remove ${m}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            className={field}
          />
          <button
            type="button"
            onClick={add}
            disabled={!addValue.trim()}
            className="shrink-0 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
          >
            Add
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">{help}</p>
      </>
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={closeSettings}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 pb-3 pt-6">
          <h2 className="text-lg font-semibold text-ink">Settings</h2>
          <button
            onClick={closeSettings}
            className="text-ink-faint hover:text-ink"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <label className={labelCls}>Default language</label>
            <select
              value={form.defaultTargetLanguage}
              onChange={(e) => update("defaultTargetLanguage", e.target.value)}
              className={field}
            >
              {/* Keep a custom stored value selectable if it isn't in the list. */}
              {!LANGUAGES.includes(form.defaultTargetLanguage) &&
                form.defaultTargetLanguage && (
                  <option value={form.defaultTargetLanguage}>
                    {form.defaultTargetLanguage}
                  </option>
                )}
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">
              The output language for <strong>all</strong> AI actions — translation
              target plus the language every result (proofread, expand, summarize,
              draft…) is written in. Set this and your text stays in this language;
              e.g. proofreading Japanese keeps it Japanese.
            </p>
          </div>

          <div>
            <label className={labelCls}>OpenRouter API key</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasApiKey ? "•••••••••• (saved in keychain)" : "sk-or-..."}
              className={field}
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-ink-faint">
                {hasApiKey
                  ? "A key is stored securely in your OS keychain."
                  : "Stored in your OS keychain — never written to disk in plaintext."}
              </span>
              {hasApiKey && (
                <button
                  onClick={clearKey}
                  className="text-xs text-red-500 hover:underline"
                >
                  Remove key
                </button>
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>Endpoint URL</label>
            <input
              value={form.endpoint}
              onChange={(e) => update("endpoint", e.target.value)}
              className={field}
              placeholder={DEFAULTS.endpoint}
            />
            <p className="mt-1 text-xs text-ink-faint">
              <strong>Recommended:</strong> keep the OpenRouter default{" "}
              <code>{DEFAULTS.endpoint}</code>. Any OpenAI-compatible
              chat-completions endpoint also works — e.g. a local Ollama bridge at{" "}
              <code>http://localhost:11434/v1/chat/completions</code> (leave the API
              key blank for local endpoints). Image generation requires an
              OpenRouter image model.
            </p>
          </div>

          <div>
            <label className={labelCls}>Model (text)</label>
            {renderModelList(
              "models",
              "model",
              newModel,
              setNewModel,
              "Add model ID, e.g. anthropic/claude-3.5-sonnet",
              <>
                Click a model to use it for writing/AI actions. Add any OpenRouter
                text model — free (e.g. <code>google/gemma-4-31b-it:free</code>) or
                paid (e.g. <code>anthropic/claude-3.5-sonnet</code>).
              </>
            )}
          </div>

          <div>
            <label className={labelCls}>Model (image generation)</label>
            {renderModelList(
              "imageModels",
              "imageModel",
              newImageModel,
              setNewImageModel,
              "Add image model ID, e.g. google/gemini-2.5-flash-image",
              <>
                Used for paragraph image generation. e.g.{" "}
                <code>google/gemini-2.5-flash-image</code> (Nano Banana) or
                Nano Banana Pro. <strong>Verify exact ids on
                openrouter.ai/models</strong> — image model ids change often.
              </>
            )}
          </div>

          <div>
            <label className={labelCls}>Editor font</label>
            <div className="flex items-center gap-4">
              <select
                value={form.editorFontFamily ?? "serif"}
                onChange={(e) =>
                  update(
                    "editorFontFamily",
                    e.target.value as Settings["editorFontFamily"]
                  )
                }
                className={`${field} w-40`}
              >
                <option value="serif">Serif</option>
                <option value="sans">Sans</option>
                <option value="mono">Mono</option>
              </select>
              <div className="w-44">
                <label className="block text-xs text-ink-faint">
                  Size: {form.editorFontSize ?? 17}px
                </label>
                <input
                  type="range"
                  min={12}
                  max={28}
                  step={1}
                  value={form.editorFontSize ?? 17}
                  onChange={(e) => update("editorFontSize", Number(e.target.value))}
                  className="w-full accent-accent"
                />
              </div>
            </div>
            <p
              className="mt-1 truncate rounded-md border border-gray-200 bg-gray-50/60 px-3 py-1.5 text-ink-soft"
              style={{
                fontFamily: FONT_STACKS[form.editorFontFamily ?? "serif"],
                fontSize: `${form.editorFontSize ?? 17}px`,
              }}
            >
              Aa — The quick brown fox / 素早い茶色の狐
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              Applies to body paragraphs in the editor (提案5 accessibility).
              Larger sizes help low-vision readers; Sans/Mono can be easier for
              dyslexic readers.
            </p>
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className={labelCls}>Writing tone</label>
              <select
                value={form.writingTone}
                onChange={(e) => update("writingTone", e.target.value)}
                className={field}
              >
                {/* Keep a custom stored tone selectable if it isn't a preset. */}
                {!WRITING_TONES.some((t) => t.value === form.writingTone) && (
                  <option value={form.writingTone}>{form.writingTone}</option>
                )}
                {WRITING_TONES.map((t) => (
                  <option key={t.label} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-faint">
                Applied to every writing action (proofread, expand, draft…).
              </p>
            </div>
            <div className="w-40">
              <label className={labelCls}>
                Temperature: {form.temperature.toFixed(1)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={form.temperature}
                onChange={(e) => update("temperature", Number(e.target.value))}
                className="mt-3 w-full accent-accent"
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={closeSettings}
            className="rounded-md px-4 py-2 text-sm text-ink-soft hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
