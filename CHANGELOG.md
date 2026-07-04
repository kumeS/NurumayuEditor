# Changelog

## Unreleased

### Rebrand → NurumayuFacet

- **Renamed the app from `aixTextEditor` to `NurumayuFacet`** (project/studio
  namespace `Nurumayu`, product `Facet`). Tagline: _“Write it. Present it. One
  file.”_ All user-facing surfaces updated — window title, native menu, About
  dialog, in-app Help (5 languages), CLI help/manifest (`app` field), OpenRouter
  `X-Title`, HTTP `User-Agent`, PPTX document metadata, README and Homebrew
  formula/cask (now `nurumayufacet.rb`; binary + tap token are `nurumayufacet`).
- **Internal identifiers intentionally unchanged** — the bundle identifier
  (`com.aix.texteditor`), the keychain service id, and the native document
  extension (`.aix`) are kept as-is. This is a display-only rebrand: existing
  users keep their settings, session and stored API key with **no migration**.
- **Machine-readable manifest** keeps its stable key `aixSchemaVersion`; only the
  human-facing `app` value changed to `NurumayuFacet`.

## v1.3.0 — 2026-07-04

Mode-switching polish. Editor/Slides was already switchable live, but the two
views didn't treat each other as equals — this closes that gap.

### Editor ⟷ Slides switching

- **Switching modes never loses your place** — going from Slides back to the
  Editor now scrolls to and briefly highlights the paragraph you were last on
  (the same scroll-and-flash the network graph and Review panel already use),
  matching the direction that already worked (Editor → Slides has always
  landed on the slide containing your focused paragraph).
- **The slide rail keeps the selected thumbnail in view** — entering Slide
  mode on a long deck no longer leaves the current slide's thumbnail
  scrolled out of the rail.
- **The Editor/Slides toggle now carries the same mode icons** used
  everywhere else (tab strip, command palette), and the view swap fades in
  briefly instead of hard-cutting (skipped under reduced-motion).
- Corrected doc comments (`types.ts`, `SlideEditor.tsx`, and the Rust mirror
  in `models.rs`) that claimed a document's mode was fixed at creation —
  stale since the live toolbar toggle shipped in v1.2.0.

### Export parity (Mismatch_report_v1 ズレ①)

- **RTF embeds real images** — image chunks (PNG/JPEG data URLs, and remote
  images, which are downloaded first) now export as actual pictures
  (`\pict` groups, aspect-scaled) with their caption beneath, instead of a
  `[Image: …]` placeholder. GIF/BMP keep the placeholder (unreliable in RTF
  readers); `.txt` stays text-only by design.
- **Diagrams export everywhere except txt** — at export time the app renders
  each Mermaid diagram to a PNG snapshot and embeds it in **RTF and PPTX**
  (Markdown keeps the editable ` ```mermaid ` fence; PDF already printed the
  live SVG, and unmounted diagrams now render offscreen instead of falling
  back to raw code). CLI exports can't render, and say so in their warning.
- **PPTX multi-image slides** — up to 6 images per slide, arranged in a grid
  that subdivides the layout's image region (stacked/2×2/2×3 in the side
  columns; side-by-side/2×2/3×2 in the top band), each aspect-fit in its cell.
  The editor preview renders the exact same grid (WYSIWYG parity), and the
  1-image-per-slide warning is gone.
- **Atomic writes everywhere** — `.aix` saves, exports and settings now write
  to a temp file and rename (the pattern session autosave already used), so a
  crash mid-write can no longer corrupt the target file (item 61/65).

### Live AI context (ズレ② / Task 2)

- **Summaries stay fresh** — every summary records a content hash; when you run
  an AI action, summaries whose paragraph changed since they were written are
  re-generated first (unchanged ones are never re-sent), so the document map
  the AI sees matches what you wrote — not the last time you pressed a button.
- **No more silent truncation** — the 60-line / 3,000-character caps on the
  document map are removed; paragraphs without a summary now contribute their
  first ~120 characters instead of being omitted entirely.
- **Freshness is visible** — the AI menu footer and the new health bar show
  when the document was last analyzed and how many summaries will refresh on
  the next run; the analysis itself now carries an `analyzedAt` timestamp
  (shown in the graph panel too).

### Review comments & integrity lens (new; Task 4)

- **Per-paragraph review comments** — a right-docked Review panel lists
  comments grouped by paragraph (click a group to jump), with add/edit/
  resolve/delete, You/AI author chips, and persistence inside the `.aix` file.
  Each paragraph's gutter shows a comment button with an unresolved-count badge.
- **AI review** — one click asks the model for concise, actionable comments on
  paragraphs that genuinely need them.
- **Check integrity** — using the relationship graph (claims/evidence edges) +
  the text, the AI flags **unsupported claims** and **contradictions** as
  comments attached to the offending paragraphs — the graph is now a writing
  tool, not just a picture.

### Slides: layout apply fix & structure editing (item 38 — v1.2 priority)

- **Picking a layout is now immediately visible** — image layouts on a slide
  with no image render a dashed placeholder slot (edit/preview) instead of
  silently falling back to full-width; picking a layout while in edit view
  switches to the preview so the change shows at full size; and layout
  overrides now clear stale values from *all* chunks of the slide, fixing the
  dead "Auto" reset (empty-string overrides are ignored, matching the Rust
  exporter).
- **AI layout** — a per-slide "AI layout" button asks the model to pick the
  best of the five layouts from the slide's own title/bullets/image count —
  text is never touched.
- **Split & merge slides** — "Split slide here" on any row of the slide body
  and "Merge into previous" on the toolbar; slides whose content likely
  overflows the 16:9 frame get an amber "long" badge (same heuristic as the
  export warning).
- **Slide-shaped summaries** — Summarize→Slide now asks for a key-message-first
  set of short parallel phrases instead of a compressed prose summary.

### AI robustness (items 22/24/27/28/32/49/53)

- **Retries for streaming and image generation** — the shared retry loop
  (429/5xx, `Retry-After` honored) now also covers translate/proofread/expand/…
  (until the first token arrives) and image generation, which previously failed
  on the first hiccup.
- **Stop button** — any in-flight per-paragraph AI action can be canceled; the
  result is discarded instead of overwriting the paragraph.
- **Robust JSON & bullet parsing** — analysis JSON is extracted with a
  string-aware balanced scanner (code fences, surrounding prose and stray
  braces tolerated) and one self-correcting retry; bullet output accepts
  numbered/`•`/`*`/`–` lists and skips preambles.
- **Validated diagrams** — AI-generated Mermaid is parse-checked before it's
  inserted; on failure the model gets one corrective retry with the parse
  error, and a broken diagram is never inserted.
- **Analysis covers headings** — the relationship graph now includes section
  headings, and edge relations use a closed vocabulary (cause, effect,
  evidence, claim, elaboration, contrast, condition, example, definition,
  sequence).

### Reading aloud (Phase 13, first slice — items 14/36)

- **Read the whole document, a selection, or one paragraph** — a toolbar
  Read/Stop button reads from the current paragraph onward; the selection bar
  reads selected paragraphs; playback advances paragraph-by-paragraph on the
  speech-done event and Stop clears the queue.
- **Voice follows your default language** — the configured output language now
  picks the voice first (e.g. Japanese → Kyoko); script detection remains the
  fallback.

### Editor mechanics (items 3/4/18)

- **Merge paragraphs** — select 2+ adjacent text paragraphs and hit **Merge**:
  contents join with smart separators (a space for Latin boundaries, none for
  CJK), comments carry over, and the stale summary is cleared. Undoable.
- **One unsaved-changes dialog** — quitting and closing a tab now share a
  single confirm helper (previously two separately-worded dialogs), and ⌘W
  closes the active tab with the same protection.

### Discoverability & accessibility (提案1/2/4/5)

- **Command palette (⌘K)** — search and run every major action (export,
  analyze, review, read aloud, tabs, settings…) from the keyboard.
- **Health bar** — a persistent status strip: save state, word count, AI
  freshness ("analyzed 5 min ago · out of date"), stale-summary count, busy/
  reading indicators, and the last export's warnings kept reviewable (they
  used to vanish with the toast).
- **Clustered AI menu** — the per-paragraph AI menu is grouped into labeled
  boxes (Rewrite / Language / Summarize / Generate / Custom), the same visual
  pattern as the slide design cluster.
- **Editor font settings** — Serif/Sans/Mono and a 12–28px size slider for
  body paragraphs (Settings → Editor font), with a live preview.

### Graph panel (items 48/50/52)

- **Edge & node navigation** — tapping an edge flashes *both* connected
  paragraphs in the editor; the focused paragraph is highlighted in the graph.
- **Relation-colored edges + legend** — the ten canonical relations each get a
  color; a legend shows the ones present. Labels appear at readable zoom.
- **One pruning rule** — the dangling-node/edge cleanup that existed in four
  copies now funnels through one helper per side (`pruneAnalysis` on the
  frontend, `AnalysisResult::drop_dangling_edges` in Rust).

### CLI & platform (items 61/65/66/69/77/78/81)

- **CLI PDF export** — `aixtexteditor export doc.aix out.pdf` works headlessly
  (A4, CJK-capable via system fonts, subset-embedded); the capabilities
  manifest no longer over-promises, and a unit test fails if the manifest and
  the real formats ever drift again. `aiActionsRunVia: "gui"` states honestly
  that AI verbs aren't CLI-invocable yet.
- **CLI transparency** — new `show <file.aix> <chunkId>` prints a chunk's raw
  content (diagram source included); `info --json` now includes full content;
  CLI PPTX export downloads remote images like the GUI does.
- **Settings safety** — a corrupt `settings.json` is backed up to
  `settings.json.bak` and reported instead of being silently replaced; saves
  are atomic; deleting a built-in model now sticks (tombstoned instead of
  re-merged on every launch).
- **Locale detection from Finder/Dock** — when shell env vars are absent
  (normal for Dock launches), the default language now comes from
  `defaults read -g AppleLocale`, so Japanese systems start in Japanese.

### Slide layouts & AI redesign

- **Two new layouts** — `title-image-left` (image left, bullets right — the
  mirror of the existing right-side layout) and `image-top` (a full-width image
  band above bullets), so a slide's text/image placement isn't limited to the
  three original choices.
- **Visual layout picker** — the layout `<select>` (raw enum strings like
  `title-content`) is replaced by a popover of labeled wireframe swatches
  (Section, Title + Bullets, Image right, Image left, Image top) with
  explanatory tooltips.
- **"Auto" layout** — a slide can now be explicitly reset to auto-picking its
  layout from its content; previously, once a layout was chosen there was no
  way back to auto without picking a matching value by hand.
- **Fixed preview/export mismatches** (WYSIWYG parity) — an image-capable
  layout with no image chunk yet (or one whose content was an empty string)
  used to still reserve a blank image column/band in the exported `.pptx`,
  though the live preview correctly rendered full-width; and an explicit
  subtitle on an image-capable layout used to render as a full-width band
  above the content in preview, but export folded it into the narrow bullets
  box beside/below the image — both now agree, on every layout.
- **Bulletize moved to per-paragraph** — the slide toolbar's "Bulletize" (which
  destructively rewrote the shared document text) read as a near-duplicate of
  the non-destructive "Summarize → slide". It's now a per-paragraph action in
  the AI (✨) menu, available in both Editor and Slide mode; the slide toolbar
  keeps only the one non-destructive, slide-scoped AI action.

## v1.2.0 — 2026-07-01

Slides. Adds a full presentation mode alongside the text editor, plus a
security- and stability-focused bug-fix pass.

### Slides & PPTX

- **Slides mode** — a new **Editor / Slides** toolbar toggle turns the current
  document into an editable deck (headings → titles, paragraphs → bullets), with
  a live deck preview kept in sync with the export. New tabs are added directly
  with the "+" button.
- **Per-slide layouts** — apply `section` / `title-content` / `title-image` to
  any slide (including a heading-less opening slide), so a slide isn't forced
  into a bullet list.
- **Title & subtitle** — mark a paragraph as a **subtitle** (Add subtitle, or the
  "S" control); it renders under the title and fills the slide's subtitle box —
  the same structure AI Draft produces, now insertable by hand.
- **Detach a slide** — "Summarize → slide" turns a slide's text into its own
  concise summary that lives independently of the document prose (edit it in
  place, or **Re-link** to reconnect); apply a custom layout on top.
- **Export to PowerPoint (`.pptx`)** — deterministic, AI-free conversion, from
  both the toolbar and the native File ▸ Export menu; on-screen preview and the
  exported deck now match (section layout, subtitles, heading-less titles).

### Fixes & hardening (Bug_report_v1 pass)

- Fixed a PPTX export failure caused by control characters in slide text
  (previously produced an unopenable file); broader image-format support
  (PNG/JPEG/GIF/BMP) with clear warnings for unsupported ones.
- `.aix` files are now validated and repaired on open (duplicate ids, dangling
  references, out-of-range values) instead of silently corrupting state.
- Network hardening for document image/URL fetches: SSRF guard against
  private/loopback/metadata addresses, response **size limits** + timeouts, and
  a tightened **Content-Security-Policy**; path-extension checks on writes.
- Per-tab in-flight state is fully isolated — no spinner/analysis leaks between
  open tabs.
- **Autosave & crash recovery** of open tabs; the relationship graph now flags
  itself out-of-date when its source paragraphs change (and prunes deleted ones).
- Read-aloud (text-to-speech) lifecycle fixed — the button clears when playback
  ends and no longer cross-wires between paragraphs.
- **Save As…**, native-menu PPTX export, undo-consistent analysis, and slide
  editing that respects slide boundaries.

### Other

- On macOS, **closing the window keeps the app running** — re-open it from the
  Dock; Cmd+Q quits.
- Pinned build-time **esbuild** (>= 0.28.1) to patch GHSA-g7r4-m6w7-qqqr.

## v1.1.0 — 2026-06-22

Feature update focused on language consistency, drafting, illustration and
accessibility.

### Settings
- **Default language** moved to the top of Settings and renamed from “Default
  translation language”. It is now the output language for **every** AI action,
  so results no longer drift (e.g. proofreading Japanese keeps it Japanese).
- **Writing tone** — choose a global voice (Blog / Memo / Report / Scientific /
  Academic paper) applied to all writing actions.
- Expanded pre-registered **text models** (default: `deepseek/deepseek-v4-flash`)
  and **image models** (Grok Imagine, Recraft v4 Pro, GPT-5.4-image, FLUX.2).
- Endpoint help now recommends the OpenRouter default and documents using a
  local **Ollama** endpoint (API key optional for local endpoints).

### Drafting
- **Draft a document by AI** (renamed) with an approximate **length** setting and
  attachable **reference material** — pasted text, a file (`.txt/.md/.rtf/.pdf`),
  or a fetched **URL** the draft is grounded in.

### Per-paragraph AI
- **Streaming** output for per-chunk actions (translate, proofread, …), like Draft.
- **Revise with context** — rewrite a paragraph to fit its neighbours.
- **Version history per paragraph** — every AI edit saves the previous version;
  swap back at any time.
- **Change highlight** — after proofreading, see exactly what changed (word-level).
- **Multi-paragraph editing** — apply one instruction to all selected paragraphs.
- AI actions (proofread / translate / custom) now available on **headings**, in
  addition to the H1/H2/H3 picker.

### Images & figures
- **Regenerate** button and **version gallery** on image chunks — keep every
  alternative and pick the final one.
- **Presentation figure** generation — a clean diagram-style illustration,
  separate from literal image generation.

### Other
- **Read aloud** (text-to-speech) for any paragraph (macOS speech synthesizer).
- **PDF export** via the system print dialog (handles CJK fonts correctly).
- **Help** menu — an in-app guide to the writing workflow (toolbar + native menu).
- **Tooltips** on the gutter and menu controls.

## v1.0.0 — 2026-06-21

First public release.

### Editing
- Chunk-based editor (text / heading / diagram / image chunks).
- **Multiple tabs** — manage several documents at once; each tab keeps its own
  document, file, undo/redo history and relationship graph (`⌘/Ctrl+T`, tab-bar ＋).
- **Headings** — `#`/`##`/`###` become heading chunks (levels 1–3); type the
  marker at a paragraph's start to convert.
- Split / merge / reorder chunks; move between chunks with the Up/Down arrows.

### AI (OpenRouter)
- Per-chunk ✨ menu: Translate, Proofread (selectable style), Expand, Add detail,
  Concentrate, Focus, Summarize, Generate diagram, Custom instruction.
- **Draft** — generate a structured document from a theme, streamed into a new
  tab in real time.
- **Image generation** — per paragraph or from a multi-paragraph selection;
  inserted as movable image chunks. Uses a separately-configured image model.
- **Relationship graph** — paragraph + per-sentence nodes with typed relations,
  rendered with Cytoscape; persisted in the `.aix` file.
- Context-aware prompts (neighbouring paragraphs); automatic retry/back-off on
  rate limits (HTTP 429).

### Files & platform
- Native `.aix` save/open (lossless); merged **Import / Export** menu for
  `.txt` / `.md` / `.rtf`.
- Native application menu mirrors the in-app toolbar.
- API key stored in the OS keychain; all network calls happen in Rust.

### Project
- Licensed under the **Artistic License 2.0** (© 2026 Satoshi Kume).
- Homebrew cask template under `Casks/`.
