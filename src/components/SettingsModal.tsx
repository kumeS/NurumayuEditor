// Settings dialog: OpenRouter endpoint, model, default translation language,
// temperature, and the API key (stored in the OS keychain via Rust — never
// echoed back to the frontend).

import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import { FONT_STACKS } from "../fonts";
import { tNow, useLang, useT } from "../i18n";
import { useStore } from "../store";
import type { Settings } from "../types";
import { CloseIcon } from "./icons";
import { openPersonalLibraryPanel } from "./PersonalLibraryPanel";

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
  limitCompletionToLocalModel: false,
  charLimitWarning: undefined,
  personalRagEnabled: false,
  mcpWriteEnabled: false,
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
  const t = useT();
  const ja = useLang() === "ja";

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
      // The in-app chrome re-renders from the store, but the NATIVE menu bar was
      // built at startup — rebuild it so both halves speak the same language.
      await api.setMenuLanguage(form.defaultTargetLanguage).catch(() => {});
      if (apiKey.trim()) {
        await api.setApiKey(apiKey.trim());
        setHasApiKey(true);
      }
      notify(t("Settings saved."), "success");
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
      notify(tNow("API key removed from keychain."), "success");
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
                  title={t("Remove from list")}
                  aria-label={`${t("Remove")} ${m}`}
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
            {t("Add")}
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
          <h2 className="text-lg font-semibold text-ink">{t("Settings")}</h2>
          <button
            onClick={closeSettings}
            className="text-ink-faint hover:text-ink"
            aria-label={t("Close")}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <label className={labelCls}>{t("Default language")}</label>
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
              {ja ? (
                <>
                  <strong>すべての</strong>AI操作の出力言語です — 翻訳先の言語に加えて、
                  校正・加筆・要約・下書きなど、あらゆる結果がこの言語で書かれます。
                  ここを設定しておけば文章の言語は保たれます(日本語を校正しても日本語のまま)。
                  この設定はアプリの表示言語も切り替えます。
                </>
              ) : (
                <>
                  The output language for <strong>all</strong> AI actions — translation
                  target plus the language every result (proofread, expand, summarize,
                  draft…) is written in. It also switches this app's own interface
                  language. Set this and your text stays in this language; e.g.
                  proofreading Japanese keeps it Japanese.
                </>
              )}
            </p>
          </div>

          <div>
            <label className={labelCls}>{t("OpenRouter API key")}</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasApiKey ? t("•••••••••• (saved in keychain)") : "sk-or-..."}
              className={field}
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-ink-faint">
                {hasApiKey
                  ? t("A key is stored securely in your OS keychain.")
                  : t("Stored in your OS keychain — never written to disk in plaintext.")}
              </span>
              {hasApiKey && (
                <button
                  onClick={clearKey}
                  className="text-xs text-red-500 hover:underline"
                >
                  {t("Remove key")}
                </button>
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>{t("Endpoint URL")}</label>
            <input
              value={form.endpoint}
              onChange={(e) => update("endpoint", e.target.value)}
              className={field}
              placeholder={DEFAULTS.endpoint}
            />
            <p className="mt-1 text-xs text-ink-faint">
              {ja ? (
                <>
                  <strong>推奨:</strong> OpenRouterの既定値{" "}
                  <code>{DEFAULTS.endpoint}</code> のままご利用ください。OpenAI互換の
                  chat-completionsエンドポイントも利用できます — 例: ローカルのOllamaブリッジ{" "}
                  <code>http://localhost:11434/v1/chat/completions</code>
                  (ローカルの場合APIキーは空欄で構いません)。画像生成にはOpenRouterの画像モデルが必要です。
                </>
              ) : (
                <>
                  <strong>Recommended:</strong> keep the OpenRouter default{" "}
                  <code>{DEFAULTS.endpoint}</code>. Any OpenAI-compatible
                  chat-completions endpoint also works — e.g. a local Ollama bridge at{" "}
                  <code>http://localhost:11434/v1/chat/completions</code> (leave the API
                  key blank for local endpoints). Image generation requires an
                  OpenRouter image model.
                </>
              )}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
              <input
                type="checkbox"
                checked={form.limitCompletionToLocalModel ?? false}
                onChange={(e) => update("limitCompletionToLocalModel", e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("Limit ghost-text completion to a local model")}
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              {ja ? (
                <>
                  入力中に、続きの文章の候補が薄い文字で表示されます(Tabで確定、Escで却下)。
                  有効にすると、上のエンドポイントがローカル(例:{" "}
                  <code>localhost</code>/<code>127.0.0.1</code>)のときだけ動作します。
                  ローカルでない場合は、文章を外部に送らず候補を要求しません。既定はオフです。
                </>
              ) : (
                <>
                  While typing, a faint inline suggestion previews how the sentence
                  might continue (Tab to accept, Esc to dismiss). When enabled, this
                  only fires if the endpoint above is local (e.g.{" "}
                  <code>localhost</code>/<code>127.0.0.1</code>) — if it isn't, no
                  suggestion is requested rather than sending your text to a remote
                  endpoint. Off by default.
                </>
              )}
            </p>
          </div>

          <div>
            <label className={labelCls}>{t("Paragraph character-limit warning")}</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={form.charLimitWarning ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  update(
                    "charLimitWarning",
                    raw === "" ? undefined : Math.max(1, Math.round(Number(raw)))
                  );
                }}
                placeholder={t("Off")}
                className={`${field} w-32`}
              />
              <button
                type="button"
                onClick={() => update("charLimitWarning", undefined)}
                disabled={form.charLimitWarning === undefined}
                className="shrink-0 rounded-md px-3 py-2 text-sm text-ink-soft hover:bg-gray-100 disabled:opacity-40"
              >
                {t("Turn off")}
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              {ja
                ? "この文字数を超えた段落をヘルスバーで警告します — 字数制限のある文章(申請書・抄録・各種フォーム)に便利です。日本語などの全角文字も1文字として数えます。既定はオフ(未設定)、空欄で無効になります。"
                : "Flags any paragraph longer than this many characters in the health bar — useful for any length-constrained writing (grant applications, abstracts, forms). CJK characters count as one character each. Off (unset) by default; leave blank to disable."}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
              <input
                type="checkbox"
                checked={form.personalRagEnabled ?? false}
                onChange={(e) => update("personalRagEnabled", e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("Personal knowledge base (RAG)")}
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              {ja
                ? "AI操作が、あなた自身の過去の論文やノートから関連する箇所を根拠として参照できるようになります。埋め込み・索引作成・検索はすべて端末内で完結します(有効化後、最初にソースを追加または検索したときだけ埋め込みモデルを1回ダウンロードします。それ以外の通信はありません)。既定はオフ。索引済みファイルの管理は"
                : "Let AI actions optionally pull in relevant snippets from your own past papers/notes as grounding context. Fully on-device: embedding, indexing, and search all run locally (a one-time embedding-model download happens the first time you add a source or search, after enabling this — no other network traffic). Off by default. Manage indexed files from"}{" "}
              <button
                type="button"
                onClick={() => openPersonalLibraryPanel()}
                className="text-accent underline decoration-dotted hover:text-accent-soft"
              >
                {t("the personal library panel")}
              </button>{" "}
              {ja ? "から行えます(コマンドパレットからも開けます)。" : "(also in the command palette)."}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-ink-soft">
              <input
                type="checkbox"
                checked={form.mcpWriteEnabled ?? false}
                onChange={(e) => update("mcpWriteEnabled", e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              {t("Allow AI agent to write into documents (MCP)")}
            </label>
            <p className="mt-1 text-xs text-ink-faint">
              {ja
                ? "接続したAIエージェントが、要約をドキュメントに書き込めるようになります。オンにすると、外部のMCPクライアント(Claude DesktopやClaude Codeなど)があなたのパーソナルナレッジベースを検索し、指定したドキュメントに明示ラベル付きの参照チャンクを挿入できます。アプリ内で独自にAI要約を実行することはありません。既定はオフで、他のMCP機能(ドキュメントの読み取り・書き出し)はこの設定の影響を受けません。"
                : "Let a connected AI agent write summaries back into your documents. When on, an external MCP client (e.g. Claude Desktop or Claude Code) can search your personal knowledge base and insert a clearly labeled reference chunk into a document you point it at — it never runs its own AI summarization inside the app. Off by default; every other MCP capability (reading documents, exporting) is unaffected by this setting."}
            </p>
          </div>

          <div>
            <label className={labelCls}>{t("Model (text)")}</label>
            {renderModelList(
              "models",
              "model",
              newModel,
              setNewModel,
              t("Add model ID, e.g. anthropic/claude-3.5-sonnet"),
              ja ? (
                <>
                  モデルをクリックすると、執筆・AI操作に使うモデルになります。OpenRouterの
                  テキストモデルを自由に追加できます — 無料(例:{" "}
                  <code>google/gemma-4-31b-it:free</code>)でも有料(例:{" "}
                  <code>anthropic/claude-3.5-sonnet</code>)でも構いません。
                </>
              ) : (
                <>
                  Click a model to use it for writing/AI actions. Add any OpenRouter
                  text model — free (e.g. <code>google/gemma-4-31b-it:free</code>) or
                  paid (e.g. <code>anthropic/claude-3.5-sonnet</code>).
                </>
              )
            )}
          </div>

          <div>
            <label className={labelCls}>{t("Model (image generation)")}</label>
            {renderModelList(
              "imageModels",
              "imageModel",
              newImageModel,
              setNewImageModel,
              t("Add image model ID, e.g. google/gemini-2.5-flash-image"),
              ja ? (
                <>
                  段落の画像生成に使われます。例:{" "}
                  <code>google/gemini-2.5-flash-image</code> (Nano Banana) や
                  Nano Banana Pro。<strong>正確なIDは openrouter.ai/models で
                  確認してください</strong> — 画像モデルのIDは頻繁に変わります。
                </>
              ) : (
                <>
                  Used for paragraph image generation. e.g.{" "}
                  <code>google/gemini-2.5-flash-image</code> (Nano Banana) or
                  Nano Banana Pro. <strong>Verify exact ids on
                  openrouter.ai/models</strong> — image model ids change often.
                </>
              )
            )}
          </div>

          <div>
            <label className={labelCls}>{t("Editor font")}</label>
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
                <option value="serif">{t("Serif")}</option>
                <option value="sans">{t("Sans")}</option>
                <option value="mono">{t("Mono")}</option>
              </select>
              <div className="w-44">
                <label className="block text-xs text-ink-faint">
                  {t("Size")}: {form.editorFontSize ?? 17}px
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
              {ja
                ? "エディタ本文の段落に適用されます。文字を大きくすると弱視の方が読みやすく、Sans/Monoはディスレクシアの方に読みやすい場合があります。"
                : "Applies to body paragraphs in the editor (提案5 accessibility). Larger sizes help low-vision readers; Sans/Mono can be easier for dyslexic readers."}
            </p>
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className={labelCls}>{t("Writing tone")}</label>
              <select
                value={form.writingTone}
                onChange={(e) => update("writingTone", e.target.value)}
                className={field}
              >
                {/* Keep a custom stored tone selectable if it isn't a preset. */}
                {!WRITING_TONES.some((t) => t.value === form.writingTone) && (
                  <option value={form.writingTone}>{form.writingTone}</option>
                )}
                {WRITING_TONES.map((tone) => (
                  <option key={tone.label} value={tone.value}>
                    {t(tone.label)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-faint">
                {ja
                  ? "すべての執筆系操作(校正・加筆・下書きなど)に適用されます。"
                  : "Applied to every writing action (proofread, expand, draft…)."}
              </p>
            </div>
            <div className="w-40">
              <label className={labelCls}>
                {t("Temperature")}: {form.temperature.toFixed(1)}
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
            {t("Cancel")}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-soft disabled:opacity-50"
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
