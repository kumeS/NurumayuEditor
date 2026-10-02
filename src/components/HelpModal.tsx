// Help — a short guide to the recommended writing workflow, opened from the
// toolbar Help button and the native Help menu. The guide is available in
// several languages, picked from a selector next to the title; the initial
// language follows the user's Default language (Settings) when it matches.

import { useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { JA, tNow, translateWith, useLang } from "../i18n";
import { APP_VERSION, BUILD_ID } from "../buildInfo";
import { useStore } from "../store";
import {
  CloseIcon,
  DraftIcon,
  ImageIcon,
  LanguagesIcon,
  NetworkIcon,
  SettingsIcon,
  SparklesIcon,
  SpeakerIcon,
  ExportIcon,
} from "./icons";
import Modal from "./Modal";

const OPENROUTER_URL = "https://openrouter.ai/";

// Supported help languages. The keys match the Settings "Default language"
// labels so the initial selection can follow that setting.
type HelpLang = "English" | "日本語" | "中文" | "Español" | "Français";

const HELP_LANGS: { key: HelpLang; label: string }[] = [
  { key: "English", label: "English" },
  { key: "日本語", label: "日本語" },
  { key: "中文", label: "中文" },
  { key: "Español", label: "Español" },
  { key: "Français", label: "Français" },
];

interface HelpStep {
  title: string;
  body: string;
}

interface HelpContent {
  heading: string;
  apiTitle: string;
  apiIntro: string;
  apiStep1: string; // contains the [openrouter.ai](openrouter) link token
  apiStep2: string; // contains **bold** markers
  getKeyBtn: string;
  openSettingsBtn: string;
  ollamaNote: string;
  flowIntro: string;
  steps: HelpStep[]; // exactly 6, paired with STEP_ICONS by index
  tip: string; // contains **bold** markers
  /**
   * Ghost-text inline completion (開発.txt Stage 2, item 2-4) — documented
   * separately from the numbered steps since it's a passive, opt-in-by-
   * circumstance background behaviour, not a step the user deliberately
   * triggers. Optional: only English and 日本語 are translated for now (see
   * the note at HELP_I18N's end); the other languages simply omit this
   * paragraph rather than guess a translation.
   */
  ghostText?: { title: string; body: string };
  /**
   * Find / Replace, Save As and closing tabs — keyboard-driven editing
   * chores, documented outside the numbered workflow. Optional like
   * `ghostText`: only English and 日本語 carry it so far.
   */
  editing?: { title: string; body: string };
}

// Icons for the six workflow steps, shared across all languages (paired by index).
const STEP_ICONS = [
  <DraftIcon />,
  <SparklesIcon />,
  <ImageIcon />,
  <NetworkIcon />,
  <SpeakerIcon />,
  <ExportIcon />,
];

// Localized help content. Strings use two lightweight markup tokens, expanded by
// `renderRich`: `**bold**` → <strong>, and `[label](openrouter)` → a link to
// OpenRouter. Controls are named by the label the user actually sees: the app
// chrome is English or Japanese (src/i18n.ts), so the 日本語 bundle interpolates
// its control names from the JA dictionary (`ja(...)`) and can never drift from
// the Japanese UI (guarded by src/helpContent.test.ts). 中文/Español/Français
// readers see the English chrome, so those bundles keep the English labels.
// OpenRouter's own site navigation (sign in → Keys → Create Key) stays English.
const ja = (key: string): string => JA[key] ?? key;

export const HELP_I18N: Record<HelpLang, HelpContent> = {
  English: {
    heading: "How to write with NurumayuEditor",
    apiTitle: "Before you start — set an API key",
    apiIntro:
      "AI features use any OpenAI-compatible endpoint; the default is OpenRouter, which offers free models.",
    apiStep1: "Create a key at [openrouter.ai](openrouter) (sign in → Keys → Create Key).",
    apiStep2:
      "Open **Settings** (gear icon, top-right, or ⌘,) and paste it under “OpenRouter API key”. It is stored in the macOS keychain — never on disk in plaintext.",
    getKeyBtn: "Get an API key →",
    openSettingsBtn: "Open Settings",
    ollamaNote: "Using a local Ollama endpoint instead? You can leave the key blank.",
    flowIntro:
      "A typical flow goes from a whole-document draft to fine-grained, paragraph-level editing, illustration, and export.",
    steps: [
      {
        title: "1. Draft the whole document",
        body: "Click “Draft by AI”, enter a theme, pick an approximate length, and optionally attach reference text, a file (.txt/.md/.rtf/.pdf) or a URL. The AI streams a structured first draft — headings and paragraphs — into a new tab.",
      },
      {
        title: "2. Refine paragraph by paragraph",
        body: "Focus a paragraph and use the ✨ menu in the left gutter: Translate, Proofread (with a style), Expand, Add detail, Concentrate, Focus, or a Custom instruction. Each action reads the surrounding paragraphs for context. ⌘/Ctrl+Enter runs a quick proofread; results are undoable with ⌘/Ctrl+Z.",
      },
      {
        title: "3. Add images & diagrams",
        body: "From a paragraph’s right gutter, generate an image. To turn a paragraph into a Mermaid diagram, use “Generate diagram…” in its ✨ menu (left gutter). Select several paragraphs (checkbox) and use the bottom bar to generate one combined image. Regenerate to get alternatives and pick your favourite.",
      },
      {
        title: "4. Check the structure",
        body: "Use “Analyze” to extract the relationships between paragraphs and sentences as an interactive network graph. Click a node to jump to that paragraph.",
      },
      {
        title: "5. Listen back",
        body: "Use the read-aloud (🔊) control on a paragraph to hear it spoken — a quick way to catch awkward phrasing. The output language follows your Default language in Settings.",
      },
      {
        title: "6. Save & export",
        body: "Save as a native .aix file (lossless), or export to .txt / .md / .rtf / .pdf. PDF export asks where to save and writes an A4 PDF; images become text placeholders and diagrams print as their Mermaid source (both listed in the export report on the status bar — embedding them is planned).",
      },
    ],
    tip: "Tip: set your **Default language** and **Writing tone** in Settings — every AI action then keeps that language and voice.",
    ghostText: {
      title: "Ghost-text suggestions",
      body:
        "After you type in a paragraph and pause briefly with the cursor at its end, a faint grey inline suggestion for how the sentence continues may appear. Opening a file, switching tabs or clicking into a paragraph never requests one — only typing does. It only appears when AI is available (an API key set, or a local endpoint) and stays invisible otherwise — no dialog, no toast. Press Tab to accept it, or Escape (or keep typing) to dismiss it. In Settings, “Limit ghost-text completion to a local model” restricts it to a local endpoint only (e.g. Ollama), so it never reaches a remote server unless you choose one.",
    },
    editing: {
      title: "Find, Save As & tabs",
      body:
        "⌘F opens “Find…” and ⌥⌘F opens “Find and Replace…”. ⌘G / ⇧⌘G (or Enter / ⇧Enter in the find bar) step to the next / previous match; Esc closes the bar. “Replace All” is a single undo step. ⌘L is “Go to Line…”. Go to Line works in Markdown source — switch to Markdown to use it. Find in Slides is planned — switch to Editor or Markdown to search. ⇧⌘S (“Save As…”) saves under a new name, as .aix or .md. Closing a tab — or quitting — with unsaved changes asks Save / Don't Save / Cancel. Closing the last tab leaves a fresh untitled tab.",
    },
  },

  日本語: {
    heading: "NurumayuEditor で書くには",
    apiTitle: "始める前に — API キーを設定する",
    apiIntro:
      "AI 機能は OpenAI 互換のエンドポイントであればどれでも利用できます。既定では、無料モデルを提供する OpenRouter を使用します。",
    apiStep1: "[openrouter.ai](openrouter) でキーを作成します（sign in → Keys → Create Key）。",
    apiStep2: `**${ja("Settings")}**（右上の歯車アイコン、または ⌘,）を開き、「${ja("OpenRouter API key")}」の欄に貼り付けてください。キーは macOS のキーチェーンに保存され、平文でディスクに書き込まれることはありません。`,
    getKeyBtn: "API キーを取得 →",
    openSettingsBtn: `${ja("Settings")}を開く`,
    ollamaNote:
      "代わりにローカルの Ollama エンドポイントを使う場合は、キーは空欄のままでかまいません。",
    flowIntro:
      "基本的な流れは、文書全体の下書きから始まり、段落単位での細やかな編集、図版の挿入、そして書き出しへと進みます。",
    steps: [
      {
        title: "1. 文書全体を下書きする",
        body: `「${ja("Draft by AI")}」をクリックし、テーマを入力して、おおよその分量を選びます。必要に応じて、参考テキスト、ファイル（.txt/.md/.rtf/.pdf）、または URL を添付できます。AI が見出しと段落からなる構造化された初稿を、新しいタブにストリーミングで生成します。`,
      },
      {
        title: "2. 段落ごとに練り上げる",
        body: `段落を選択し、左側の余白にある ✨（${ja("Rewrite, translate or illustrate with AI…")}）メニューを使います：「${ja("Expand")}」「${ja("Add detail")}」「${ja("Concentrate")}」「${ja("Focus")}」「${ja("Translate…")}」「${ja("Proofread…")}」（スタイル指定あり）、または「${ja("Custom instruction…")}」。各操作は、文脈を把握するために前後の段落を読み取ります。⌘/Ctrl+Enter で素早く校正を実行でき、結果は ⌘/Ctrl+Z で元に戻せます。`,
      },
      {
        title: "3. 画像と図を追加する",
        body: `段落の右側の余白から画像を生成できます。段落を Mermaid 図に変換するには、左側の余白の ✨ メニューにある「${ja("Generate diagram…")}」を使います。複数の段落を選択（チェックボックス）し、下部のバーを使えば、それらをまとめた 1 枚の画像を生成できます。再生成すると別の候補が得られるので、気に入ったものを選べます。`,
      },
      {
        title: "4. 構成を確認する",
        body: `「${ja("Analyze")}」を使うと、段落や文どうしの関係を、操作可能なネットワークグラフとして抽出できます。ノードをクリックすると、その段落へジャンプします。`,
      },
      {
        title: "5. 読み上げを聞く",
        body: `段落の 🔊（${ja("Read this paragraph aloud")}）ボタンを使うと、その内容を音声で聞けます — 不自然な言い回しに気づくための手軽な方法です。出力言語は${ja("Settings")}の「${ja("Default language")}」に従います。`,
      },
      {
        title: "6. 保存と書き出し",
        body: `ネイティブの .aix ファイル（無劣化）として保存するか、「${ja("Import / Export")}」メニューから .txt / .md / .rtf / .pdf に書き出せます。PDF は保存先を選ぶと A4 の PDF ファイルとして書き出されます。画像はテキストの代替表示に、図は Mermaid のソースとして出力されます（ステータスバーの書き出しレポートに一覧表示されます。埋め込みは今後対応予定です）。`,
      },
    ],
    tip: `ヒント：${ja("Settings")}で **${ja("Default language")}** と **${ja("Writing tone")}** を設定しておくと、以降のすべての AI 操作がその言語と文体を保ちます。`,
    ghostText: {
      title: "インライン補完（ゴーストテキスト）",
      body: `段落に入力してから、カーソルを末尾に置いたまま少し手を止めると、文の続きの候補が薄いグレーの文字でカーソルの先に表示されることがあります。ファイルを開いたり、タブを切り替えたり、段落をクリックしただけでは表示されません — 入力したときだけです。これは AI が利用可能なとき（API キーが設定されている、またはローカルのエンドポイントを使っている場合）にだけ現れ、それ以外は何も表示されません — ダイアログもトーストも出ません。Tab キーで候補を確定し、Escape キー（またはそのまま入力を続ける）で消せます。${ja("Settings")}の「${ja("Limit ghost-text completion to a local model")}」を有効にすると、ローカルのエンドポイント（例：Ollama）のときにしか働かなくなり、リモートのサーバーに送られることはなくなります。`,
    },
    editing: {
      title: "検索・別名で保存・タブ",
      body: `⌘F で「${ja("Find…")}」、⌥⌘F で「${ja("Find and Replace…")}」を開きます。⌘G / ⇧⌘G（検索バーでは Enter / ⇧Enter）で次 / 前の一致へ移動し、Esc で検索バーを閉じます。「${ja("Replace All")}」は 1 回の取り消しでまとめて元に戻せます。⌘L は「${ja("Go to Line…")}」です。${ja("Go to Line works in Markdown source — switch to Markdown to use it.")}${ja("Find in Slides is planned — switch to Editor or Markdown to search.")}⇧⌘S（「${ja("Save As…")}」）で、別の名前で .aix または .md として保存できます。未保存の変更があるタブを閉じるとき（「${ja("Close tab")}」）やアプリを終了するときは、「${ja("Save")}」「${ja("Don't Save")}」「${ja("Cancel")}」から選べます。最後のタブを閉じると、新しい「${ja("Untitled")}」タブに置き換わります。`,
    },
  },

  中文: {
    heading: "如何使用 NurumayuEditor 写作",
    apiTitle: "开始之前 — 设置 API 密钥",
    apiIntro:
      "AI 功能可使用任何 OpenAI-compatible 端点；默认使用 OpenRouter，它提供免费模型。",
    apiStep1: "在 [openrouter.ai](openrouter) 创建密钥（登录 → Keys → Create Key）。",
    apiStep2:
      "打开 **Settings**（右上角齿轮图标，或 ⌘,），将密钥粘贴到“OpenRouter API key”下方。密钥保存在 macOS keychain 中 — 绝不会以明文形式存储在磁盘上。",
    getKeyBtn: "获取 API 密钥 →",
    openSettingsBtn: "打开 Settings",
    ollamaNote: "改用本地 Ollama 端点？可以将密钥留空。",
    flowIntro: "典型流程是从整篇文档的草稿开始，逐步细化到段落级编辑、配图与导出。",
    steps: [
      {
        title: "1. 起草整篇文档",
        body: "点击“Draft by AI”，输入主题，选择大致篇幅，并可选择附加参考文本、文件（.txt/.md/.rtf/.pdf）或一个 URL。AI 会将结构化的初稿 — 含标题和段落 — 以流式方式写入一个新标签页。",
      },
      {
        title: "2. 逐段润色",
        body: "聚焦某个段落，使用左侧栏中的 ✨ 菜单：Translate、Proofread（可指定风格）、Expand、Add detail、Concentrate、Focus，或一条 Custom 指令。每个操作都会读取相邻段落作为上下文。⌘/Ctrl+Enter 可快速校对；结果可用 ⌘/Ctrl+Z 撤销。",
      },
      {
        title: "3. 添加图片与图表",
        body: "在段落的右侧栏可生成图片；要将段落转换为 Mermaid 图表，请使用左侧栏 ✨ 菜单中的“Generate diagram…”。勾选多个段落（复选框），再使用底部栏生成一张合并图片。重新生成可获得不同方案，挑选你最满意的一张。",
      },
      {
        title: "4. 检查结构",
        body: "使用“Analyze”将段落与句子之间的关系提取为可交互的网络图。点击节点即可跳转到对应段落。",
      },
      {
        title: "5. 朗读回听",
        body: "使用段落上的朗读（🔊）控件听一听朗读效果 — 这是发现拗口表达的便捷方法。输出语言遵循 Settings 中的 Default language。",
      },
      {
        title: "6. 保存与导出",
        body: "保存为原生 .aix 文件（无损），或导出为 .txt / .md / .rtf / .pdf。导出 PDF 时选择保存位置即可生成 A4 PDF；图片会以文字占位符代替，图表以其 Mermaid 源代码输出（列在状态栏的导出报告中，嵌入功能计划中）。",
      },
    ],
    tip: "提示：在 Settings 中设置你的 **Default language** 和 **Writing tone** — 此后每个 AI 操作都会沿用该语言与语气。",
  },

  Español: {
    heading: "Cómo escribir con NurumayuEditor",
    apiTitle: "Antes de empezar — configura una clave de API",
    apiIntro:
      "Las funciones de IA usan cualquier endpoint compatible con OpenAI; el predeterminado es OpenRouter, que ofrece modelos gratuitos.",
    apiStep1: "Crea una clave en [openrouter.ai](openrouter) (inicia sesión → Keys → Create Key).",
    apiStep2:
      "Abre **Settings** (icono de engranaje, arriba a la derecha, o ⌘,) y pégala en «OpenRouter API key». Se almacena en el macOS keychain, nunca en disco en texto plano.",
    getKeyBtn: "Obtener una clave de API →",
    openSettingsBtn: "Abrir Settings",
    ollamaNote:
      "¿Usas en su lugar un endpoint local de Ollama? Puedes dejar la clave en blanco.",
    flowIntro:
      "Un flujo típico va desde un borrador de todo el documento hasta la edición detallada a nivel de párrafo, la ilustración y la exportación.",
    steps: [
      {
        title: "1. Redacta todo el documento",
        body: "Haz clic en «Draft by AI», introduce un tema, elige una longitud aproximada y, de forma opcional, adjunta texto de referencia, un archivo (.txt/.md/.rtf/.pdf) o una URL. La IA va generando en streaming un primer borrador estructurado —con títulos y párrafos— en una pestaña nueva.",
      },
      {
        title: "2. Perfecciona párrafo a párrafo",
        body: "Enfoca un párrafo y usa el menú ✨ del margen izquierdo: Translate, Proofread (con un estilo), Expand, Add detail, Concentrate, Focus o una instrucción Custom. Cada acción lee los párrafos circundantes para obtener contexto. ⌘/Ctrl+Enter ejecuta una corrección rápida; los resultados se pueden deshacer con ⌘/Ctrl+Z.",
      },
      {
        title: "3. Añade imágenes y diagramas",
        body: "Desde el margen derecho de un párrafo, genera una imagen. Para convertir un párrafo en un diagrama Mermaid, usa «Generate diagram…» en su menú ✨ (margen izquierdo). Selecciona varios párrafos (casilla) y usa la barra inferior para generar una sola imagen combinada. Vuelve a generar para obtener alternativas y elige tu favorita.",
      },
      {
        title: "4. Revisa la estructura",
        body: "Usa «Analyze» para extraer las relaciones entre párrafos y oraciones como un grafo de red interactivo. Haz clic en un nodo para saltar a ese párrafo.",
      },
      {
        title: "5. Escúchalo",
        body: "Usa el control de lectura en voz alta (🔊) de un párrafo para oírlo —una forma rápida de detectar frases poco naturales—. El idioma de salida sigue tu Default language de Settings.",
      },
      {
        title: "6. Guarda y exporta",
        body: "Guárdalo como archivo nativo .aix (sin pérdidas) o expórtalo a .txt / .md / .rtf / .pdf. Al exportar a PDF eliges dónde guardarlo y se genera un PDF A4; las imágenes se sustituyen por marcadores de texto y los diagramas se imprimen como su código fuente Mermaid (se listan en el informe de exportación de la barra de estado; su inclusión está prevista).",
      },
    ],
    tip: "Consejo: configura tu **Default language** y tu **Writing tone** en Settings — así cada acción de IA mantendrá ese idioma y esa voz.",
  },

  Français: {
    heading: "Comment écrire avec NurumayuEditor",
    apiTitle: "Avant de commencer — définissez une clé API",
    apiIntro:
      "Les fonctions d'IA utilisent n'importe quel point de terminaison OpenAI-compatible ; par défaut, il s'agit d'OpenRouter, qui propose des modèles gratuits.",
    apiStep1: "Créez une clé sur [openrouter.ai](openrouter) (connectez-vous → Keys → Create Key).",
    apiStep2:
      "Ouvrez **Settings** (icône d'engrenage, en haut à droite, ou ⌘,) et collez-la sous « OpenRouter API key ». Elle est stockée dans le macOS keychain — jamais sur le disque en texte clair.",
    getKeyBtn: "Obtenir une clé API →",
    openSettingsBtn: "Ouvrir Settings",
    ollamaNote:
      "Vous utilisez plutôt un point de terminaison Ollama local ? Vous pouvez laisser la clé vide.",
    flowIntro:
      "Un déroulement type va d'un brouillon de l'ensemble du document à une édition fine au niveau du paragraphe, à l'illustration et à l'export.",
    steps: [
      {
        title: "1. Rédigez tout le document",
        body: "Cliquez sur « Draft by AI », saisissez un thème, choisissez une longueur approximative et, si vous le souhaitez, joignez un texte de référence, un fichier (.txt/.md/.rtf/.pdf) ou une URL. L'IA génère en continu un premier brouillon structuré — titres et paragraphes — dans un nouvel onglet.",
      },
      {
        title: "2. Affinez paragraphe par paragraphe",
        body: "Placez le curseur dans un paragraphe et utilisez le menu ✨ dans la gouttière de gauche : Translate, Proofread (avec un style), Expand, Add detail, Concentrate, Focus, ou une instruction Custom. Chaque action lit les paragraphes environnants pour le contexte. ⌘/Ctrl+Enter lance une correction rapide ; les résultats sont annulables avec ⌘/Ctrl+Z.",
      },
      {
        title: "3. Ajoutez des images et des diagrammes",
        body: "Depuis la gouttière de droite d'un paragraphe, générez une image. Pour convertir un paragraphe en diagramme Mermaid, utilisez « Generate diagram… » dans son menu ✨ (gouttière de gauche). Sélectionnez plusieurs paragraphes (case à cocher) et utilisez la barre du bas pour générer une seule image combinée. Régénérez pour obtenir des variantes et choisissez votre préférée.",
      },
      {
        title: "4. Vérifiez la structure",
        body: "Utilisez « Analyze » pour extraire les relations entre les paragraphes et les phrases sous forme de graphe de réseau interactif. Cliquez sur un nœud pour accéder au paragraphe correspondant.",
      },
      {
        title: "5. Réécoutez",
        body: "Utilisez la commande de lecture à voix haute (🔊) sur un paragraphe pour l'entendre lu — un moyen rapide de repérer les tournures maladroites. La langue de sortie suit votre Default language dans Settings.",
      },
      {
        title: "6. Enregistrez et exportez",
        body: "Enregistrez au format natif .aix (sans perte), ou exportez vers .txt / .md / .rtf / .pdf. L'export PDF vous demande où enregistrer et produit un PDF A4 ; les images sont remplacées par des repères textuels et les diagrammes sont imprimés sous forme de leur source Mermaid (listés dans le rapport d'export de la barre d'état ; leur intégration est prévue).",
      },
    ],
    tip: "Astuce : définissez votre **Default language** et votre **Writing tone** dans Settings — chaque action d'IA conserve alors cette langue et ce ton.",
    // `ghostText` and `editing` intentionally omitted: only English and 日本語
    // are translated for these paragraphs so far (see the interface doc
    // comments above) — 中文/Español/Français readers simply don't see them
    // rather than risk an unverified machine translation of a behavioural
    // description.
  },
};

function isHelpLang(v: string | undefined): v is HelpLang {
  return v !== undefined && v in HELP_I18N;
}

// Expand the lightweight markup tokens (`**bold**` and `[label](openrouter)`)
// into React nodes, keeping plain text between them as-is.
function renderRich(text: string, onOpenRouter: () => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(openrouter\)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={key++}>{m[1]}</strong>);
    } else {
      out.push(
        <button
          key={key++}
          type="button"
          onClick={onOpenRouter}
          className="font-medium text-accent hover:underline"
        >
          {m[2]}
        </button>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function HelpModal() {
  const open = useStore((s) => s.helpOpen);
  const close = useStore((s) => s.closeHelp);
  const openSettings = useStore((s) => s.openSettings);
  const settings = useStore((s) => s.settings);
  const uiLang = useLang();

  const [lang, setLang] = useState<HelpLang>("English");
  // Once the user picks a language manually, stop following the Settings default.
  const userPicked = useRef(false);
  const titleId = useId();

  useEffect(() => {
    if (open && !userPicked.current && isHelpLang(settings?.defaultTargetLanguage)) {
      setLang(settings.defaultTargetLanguage as HelpLang);
    }
  }, [open, settings]);

  if (!open) return null;

  const t = HELP_I18N[lang];
  const openRouter = () => void openUrl(OPENROUTER_URL);

  return (
    <Modal
      name="help"
      onClose={close}
      labelledBy={titleId}
      panelClassName="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl bg-white shadow-2xl"
    >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-6 pb-3 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <h2 id={titleId} className="truncate text-lg font-semibold text-ink">{t.heading}</h2>
            <div className="flex shrink-0 items-center gap-1.5 text-ink-faint">
              <LanguagesIcon className="h-4 w-4" />
              <select
                value={lang}
                onChange={(e) => {
                  userPicked.current = true;
                  setLang(e.target.value as HelpLang);
                }}
                aria-label={tNow("Help language")}
                className="rounded-md border border-gray-300 bg-white py-1 pl-1.5 pr-6 text-sm text-ink-soft hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {HELP_LANGS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button onClick={close} className="text-ink-faint hover:text-ink" aria-label={tNow("Close")}>
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="text-sm font-semibold text-ink">{t.apiTitle}</div>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">{t.apiIntro}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
              <li>{renderRich(t.apiStep1, openRouter)}</li>
              <li>{renderRich(t.apiStep2, openRouter)}</li>
            </ol>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openRouter}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-soft"
              >
                {t.getKeyBtn}
              </button>
              <button
                type="button"
                onClick={() => {
                  close();
                  openSettings();
                }}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-ink-soft hover:bg-gray-100"
              >
                <SettingsIcon className="h-4 w-4" /> {t.openSettingsBtn}
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-faint">{t.ollamaNote}</p>
          </div>

          <p className="text-sm text-ink-soft">{t.flowIntro}</p>
          {t.steps.map((s, i) => (
            <div key={i} className="flex gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                {STEP_ICONS[i]}
              </div>
              <div>
                <div className="text-sm font-semibold text-ink">{s.title}</div>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{s.body}</p>
              </div>
            </div>
          ))}
          {[t.ghostText, t.editing].map(
            (section) =>
              section && (
                <div key={section.title} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                  <div className="text-sm font-semibold text-ink">{section.title}</div>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{section.body}</p>
                </div>
              ),
          )}
          <p className="border-t border-gray-100 pt-3 text-xs text-ink-faint">
            {renderRich(t.tip, openRouter)}
          </p>
          {/* Build identity (MISS-02): ties what the user runs to a commit. */}
          <p className="text-xs text-ink-faint" data-build-id={BUILD_ID}>
            {translateWith("Version {version} ({build})", uiLang, { version: APP_VERSION, build: BUILD_ID })}
          </p>
        </div>
    </Modal>
  );
}
