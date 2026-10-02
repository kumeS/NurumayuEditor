// Settings dialog: OpenRouter endpoint, model, default translation language,
// temperature, and the API key (stored in the OS keychain via Rust — never
// echoed back to the frontend).
//
// Model pickers: manual entry and the OpenRouter catalog both select through
// applyModelSelection (openRouterModels.ts); nothing persists until Save.
// Opening this dialog sends no request — the catalog loads only when the user
// presses its Fetch button, and Fetch waits (with an inline reason) while the
// endpoint or API key in the form is unsaved — the backend uses the SAVED
// endpoint and key (catalogFetchBlock, security-rust-1). Saved models are never
// removed automatically: a
// model absent from a loaded catalog, or the one behind the last provider 404
// (store.aiModelIssue), only gets an inline marker.
// The one control that does not wait for Save is "Remove key": it deletes the
// keychain entry at once, so it asks through a native dialog first.

import { ask } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api } from "../api";
import { FONT_STACKS } from "../fonts";
import { tNow, useLang, useT } from "../i18n";
import { isImeKeyEvent } from "../modalBehavior";
import {
  applyModelSelection,
  catalogFetchBlock,
  type CatalogKind,
  isOpenRouterEndpoint,
  missingSavedModels,
  modelKeysFor,
} from "../openRouterModels";
import { DEFAULT_SETTINGS } from "../settingsDefaults";
import { useStore } from "../store";
import type { Settings } from "../types";
import { CloseIcon } from "./icons";
import Modal from "./Modal";
import OpenRouterModelCatalog, { useOpenRouterCatalog } from "./OpenRouterModelCatalog";
import { openPersonalLibraryPanel } from "./PersonalLibraryPanel";

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
  const models = s.models?.length ? s.models : DEFAULT_SETTINGS.models;
  const imageModels = s.imageModels?.length ? s.imageModels : DEFAULT_SETTINGS.imageModels;
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
  const settingsFocus = useStore((s) => s.settingsFocus);
  const storedSettings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const setHasApiKey = useStore((s) => s.setHasApiKey);
  const notify = useStore((s) => s.notify);
  const aiModelIssue = useStore((s) => s.aiModelIssue);

  const [form, setForm] = useState<Settings>(withActiveModels(storedSettings ?? DEFAULT_SETTINGS));
  const [apiKey, setApiKey] = useState("");
  // The backend gates on the SAVED endpoint and uses the SAVED key, so Fetch
  // waits for Save while either differs from what the form shows.
  const fetchBlock = catalogFetchBlock(form.endpoint, (storedSettings ?? DEFAULT_SETTINGS).endpoint, apiKey);
  // Session-scoped (this component stays mounted); one fetch serves both pickers.
  const catalog = useOpenRouterCatalog(form.endpoint, fetchBlock);
  const [newModel, setNewModel] = useState("");
  const [newImageModel, setNewImageModel] = useState("");
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  // One id per labelled control, so each visible label is its accessible name.
  const fid = useId();
  const ids = {
    lang: `${fid}-lang`,
    apiKey: `${fid}-api-key`,
    endpoint: `${fid}-endpoint`,
    charLimit: `${fid}-char-limit`,
    textModels: `${fid}-text-models`,
    imageModels: `${fid}-image-models`,
    font: `${fid}-font`,
    fontSize: `${fid}-font-size`,
    tone: `${fid}-tone`,
    temperature: `${fid}-temperature`,
  };
  const t = useT();
  const ja = useLang() === "ja";

  useEffect(() => {
    if (open) {
      setForm(withActiveModels(storedSettings ?? DEFAULT_SETTINGS));
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
  // Add + select + lift the tombstone (item 69); shared with catalog selection.
  const addModelTo = (kind: CatalogKind, raw: string) =>
    setForm((f) => applyModelSelection(f, kind, raw));
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

  // Unlike every other control here, this acts immediately (not on Save) and
  // the keychain secret cannot be restored, so it asks first (ui.md rule 5).
  // Success is quiet: the placeholder, hint and button flip in place.
  const clearKey = async () => {
    try {
      const confirmed = await ask(
        tNow(
          "Remove the OpenRouter API key from your OS keychain? AI actions will not work until you enter a key again."
        ),
        {
          title: tNow("Remove key"),
          kind: "warning",
          okLabel: tNow("Remove key"),
          cancelLabel: tNow("Cancel"),
        }
      );
      if (!confirmed) return;
      await api.deleteApiKey();
      setHasApiKey(false);
      setApiKey("");
    } catch (e) {
      notify(typeof e === "string" ? e : String(e), "error");
    }
  };

  const field = "w-full rounded-md border border-chrome-edge px-3 py-2 text-sm outline-none focus:border-accent";
  const labelCls = "mb-1 block text-sm font-medium text-ink-soft";

  // Shared renderer for a selectable, editable model list (text or image).
  const renderModelList = (
    kind: CatalogKind,
    addValue: string,
    setAddValue: (v: string) => void,
    placeholder: string,
    help: ReactNode,
    labelId: string
  ) => {
    const { listKey, activeKey } = modelKeysFor(kind);
    const list = form[listKey];
    const active = form[activeKey];
    const add = () => {
      addModelTo(kind, addValue);
      setAddValue("");
    };
    // Warn-only markers: never remove or disable a saved model. The catalog
    // comparison applies only while the endpoint is OpenRouter.
    const missing = new Set(
      isOpenRouterEndpoint(form.endpoint) ? missingSavedModels(list, catalog.state) : []
    );
    return (
      <>
        <div
          role="group"
          aria-labelledby={labelId}
          className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-chrome-edge p-1"
        >
          {list.map((m) => {
            const isActive = active === m;
            const unavailable = aiModelIssue?.model === m;
            return (
              <div key={m} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => update(activeKey, m)}
                  aria-pressed={isActive}
                  className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left text-sm ${
                    isActive
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-ink-soft hover:bg-chrome-hairline"
                  }`}
                  title={m}
                >
                  <span className="block truncate">
                    <span className="mr-1 inline-block w-3">{isActive ? "✓" : ""}</span>
                    {m}
                  </span>
                  {unavailable && (
                    <span
                      className="ml-4 block text-xs font-normal text-danger"
                      title={t("The provider could not serve this model in the last AI request. Choose another model.")}
                    >
                      {t("Unavailable (404)")}
                    </span>
                  )}
                  {missing.has(m) && (
                    <span className="ml-4 block text-xs font-normal text-warn-strong">
                      {t("Not found in the current OpenRouter catalog")}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeModelFrom(listKey, activeKey, m)}
                  disabled={list.length <= 1}
                  className="shrink-0 rounded px-1.5 text-ink-faint hover:text-danger disabled:opacity-30 disabled:hover:text-ink-faint"
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
              if (isImeKeyEvent(e.nativeEvent)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
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
        <OpenRouterModelCatalog
          kind={kind}
          catalog={catalog}
          fetchBlock={fetchBlock}
          activeModel={active}
          onSelect={(id) => addModelTo(kind, id)}
          autoOpen={settingsFocus === "model-catalog" && kind === "text"}
        />
      </>
    );
  };

  return (
    <Modal
      name="settings"
      onClose={closeSettings}
      labelledBy={titleId}
      dismissible={!saving}
      panelClassName="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl"
    >
        <div className="flex shrink-0 items-center justify-between border-b border-chrome-hairline px-6 pb-3 pt-6">
          <h2 id={titleId} className="text-lg font-semibold text-ink">{t("Settings")}</h2>
          <button
            type="button"
            onClick={closeSettings}
            disabled={saving}
            className="text-ink-faint hover:text-ink disabled:opacity-40"
            title={t("Close")}
            aria-label={t("Close")}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <label htmlFor={ids.lang} className={labelCls}>{t("Default language")}</label>
            <select
              id={ids.lang}
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
            <label htmlFor={ids.apiKey} className={labelCls}>{t("OpenRouter API key")}</label>
            <input
              id={ids.apiKey}
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
                  type="button"
                  className="text-xs text-danger hover:underline"
                >
                  {t("Remove key")}
                </button>
              )}
            </div>
          </div>

          <div>
            <label htmlFor={ids.endpoint} className={labelCls}>{t("Endpoint URL")}</label>
            <input
              id={ids.endpoint}
              value={form.endpoint}
              onChange={(e) => update("endpoint", e.target.value)}
              className={field}
              placeholder={DEFAULT_SETTINGS.endpoint}
            />
            <p className="mt-1 text-xs text-ink-faint">
              {ja ? (
                <>
                  <strong>推奨:</strong> OpenRouterの既定値{" "}
                  <code>{DEFAULT_SETTINGS.endpoint}</code> のままご利用ください。OpenAI互換の
                  chat-completionsエンドポイントも利用できます — 例: ローカルのOllamaブリッジ{" "}
                  <code>http://localhost:11434/v1/chat/completions</code>
                  (ローカルの場合APIキーは空欄で構いません)。画像生成にはOpenRouterの画像モデルが必要です。
                </>
              ) : (
                <>
                  <strong>Recommended:</strong> keep the OpenRouter default{" "}
                  <code>{DEFAULT_SETTINGS.endpoint}</code>. Any OpenAI-compatible
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
            <label htmlFor={ids.charLimit} className={labelCls}>
              {t("Paragraph character-limit warning")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id={ids.charLimit}
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
                className="shrink-0 rounded-md px-3 py-2 text-sm text-ink-soft hover:bg-chrome-hairline disabled:opacity-40"
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
                onClick={() => {
                  // The panel lives in the (inert while a modal is open)
                  // background chrome, so Settings must close first (BUG-017).
                  closeSettings();
                  openPersonalLibraryPanel();
                }}
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
            <span id={ids.textModels} className={labelCls}>{t("Model (text)")}</span>
            {renderModelList(
              "text",
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
              ),
              ids.textModels
            )}
          </div>

          <div>
            <span id={ids.imageModels} className={labelCls}>{t("Model (image generation)")}</span>
            {renderModelList(
              "image",
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
              ),
              ids.imageModels
            )}
          </div>

          <div>
            <label htmlFor={ids.font} className={labelCls}>{t("Editor font")}</label>
            <div className="flex items-center gap-4">
              <select
                id={ids.font}
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
                <label htmlFor={ids.fontSize} className="block text-xs text-ink-faint">
                  {t("Size")}: {form.editorFontSize ?? 17}px
                </label>
                <input
                  id={ids.fontSize}
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
              className="mt-1 truncate rounded-md border border-chrome-line bg-chrome/60 px-3 py-1.5 text-ink-soft"
              style={{
                fontFamily: FONT_STACKS[form.editorFontFamily ?? "serif"],
                fontSize: `${form.editorFontSize ?? 17}px`,
              }}
            >
              Aa — The quick brown fox / 素早い茶色の狐
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              {ja
                ? "エディタ本文の段落に適用されます。文字を大きくすると弱視の方が読みやすく、ゴシックや等幅はディスレクシアの方に読みやすい場合があります。"
                : "Applies to body paragraphs in the editor. Larger sizes help low-vision readers; Sans/Mono can be easier for dyslexic readers."}
            </p>
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label htmlFor={ids.tone} className={labelCls}>{t("Writing tone")}</label>
              <select
                id={ids.tone}
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
              <label htmlFor={ids.temperature} className={labelCls}>
                {t("Temperature")}: {form.temperature.toFixed(1)}
              </label>
              <input
                id={ids.temperature}
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

        <div className="flex shrink-0 justify-end gap-2 border-t border-chrome-hairline px-6 py-4">
          <button
            type="button"
            onClick={closeSettings}
            disabled={saving}
            className="rounded-md px-4 py-2 text-sm text-ink-soft hover:bg-chrome-hairline disabled:opacity-40"
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
    </Modal>
  );
}
