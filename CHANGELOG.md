# Changelog

## Unreleased

_Nothing yet._

## v1.4.0 — 2026-10-02

Everything since v1.3.0: the QA fix pass below, plus the Markdown workspace,
Stage 1–3 features and the rebrand, which were built after v1.3.0 and had not
shipped under a version number. Release notes with the full **Known Issues**
and **Future Release** lists: `release-notes/v1.4.0.en.md` (English) and
`release-notes/v1.4.0.md` (Japanese).

### QA fix pass (QA run 20260927-computer-use-v1, 2026-10-01)

Fixes for BUG-001–BUG-020 (BUG-004 was withdrawn by QA), G11 and the UX
audit. All three suites pass: `npm test` 67 files / 1336 tests, `npm run build`,
and `cargo test --lib` 346 tests. Tauri capabilities and the CSP are unchanged.
Items that only a person can confirm in the installed app are listed in
`../qa-results/20260927-computer-use-v1/retest-checklist-20261001.md`, which is outside this repository.

**Data integrity**

- A late AI result can no longer land in the wrong document. Every AI action
  records the tab and the document load it started in. It commits only into
  that same load. Reopening the same `.aix` file into the same tab counts as a
  different load, even though the chunk ids are the same. Paragraph rewrites
  (per-paragraph actions, bulletize, context summaries) also require the
  paragraph to still hold the text that was sent. Discarded results change
  nothing. (BUG-001)
- Ghost-text suggestions are requested only after you type in a paragraph,
  never on focus alone. Opening a file, switching tabs or switching modes makes
  no AI call. Tab accepts a suggestion only if it was made for the current text
  of the same paragraph in the same document load. (BUG-001)
- The network panel has a new **Recent AI operations** log. It records the
  start, apply or discard of each operation, with a reason code for each
  discard. It holds ids only, never text or keys, keeps the last 200 entries
  for this session, and has a **Copy log** button. (BUG-001 retest aid)
- Opening a file while an AI draft or other AI work is pending never reuses that
  busy tab. (BUG-001)
- Switching between Markdown, Editor and Slides is now a view change only. It
  never marks the document unsaved. An unedited round trip leaves the Markdown
  source byte-identical: no injected file-name H1, no added trailing newline,
  blank-line runs and h4–h6 kept, and CRLF files stay CRLF. Editing one
  paragraph rewrites only that paragraph's bytes. Notes, layouts and title edits
  no longer throw the source away. YAML frontmatter is kept verbatim and never
  becomes a chunk or a slide. `.md` saves write exactly the merged Markdown that
  the editor shows. (BUG-019)
- Opening a Markdown file in the source editor no longer marks a CRLF file
  unsaved or converts it to LF.
- An unclosed code fence no longer swallows the paragraphs placed after it when
  the Markdown is rebuilt.
- `~~~` fences are recognised, and a heading such as `## Using C#` keeps its
  `#`.
- Save marks clean only the tab and the document load it actually wrote. A
  keystroke typed during the write keeps the tab unsaved.
- Analyze no longer stamps a summary of older text as fresh when you edit during
  the run.
- Undoing every tab back to its saved state now clears the crash-recovery
  session.
- Stopping an AI action and then starting another on the same paragraph no
  longer lets the stopped result commit.

**Editing and undo**

- Undo goes back one state at a time: STATE_A → select → STATE_B → ⌘Z returns
  to STATE_A. Typing over a selection, paste, cut, a replacement, an inserted
  citation and a pause longer than 1.5 s each start a new undo step. Japanese
  IME composition is never split, even after a long pause. (BUG-002)
- Undo back to the saved document clears the unsaved marker, and redo back onto
  it does too. (MISS-12)
- ⌘Z / ⇧⌘Z in plain fields (titles, notes, dialog fields, the palette) undo that
  field's own typing instead of the document.

**Markdown, Slides and export**

- **Export as PDF** now opens a save dialog and writes the PDF directly, using
  the same renderer as the CLI. It no longer depends on a print dialog. What the
  PDF could not carry is counted in the persistent export report in the status
  bar: images become placeholders, diagrams print as Mermaid source, and
  Markdown markup prints literally. Japanese text is embedded with a system
  Unicode font. (BUG-003)
- Speaker notes work on the first slide when its title comes from the document
  title. Notes now live on the slide's lead chunk, appear with `N` in Present,
  and are exported to the PPTX notes page. (BUG-007)
- Slide bodies render Markdown in Preview, Present and PPTX: bold, italic,
  inline code, links, separate list items with nesting and numbering, code
  blocks in a monospace font without fences, and quotes. The TS and Rust
  converters share one golden fixture. Only http(s) and mailto links are
  clickable in the PPTX. The overflow warning counts visible text only.
  (BUG-020)
- PPTX export embeds images given as paths relative to the document folder, as
  the preview already did. A figure that cannot be read is reported as "couldn't
  be read from the document's folder". (G11)
- RTF exports now report what they could not carry, in the GUI, the CLI and MCP.
- The Markdown source editor no longer underlines headings or overlays a heavy
  active-line and selection colour on Japanese text. (BUG-008)
- The status bar counts Japanese documents in characters (文字), not "words".
  Diagrams and images are excluded, and the tooltip shows both counts.
  (BUG-012)
- AI drafts ask Japanese, Chinese and Korean output for a length in characters,
  with a ceiling. After drafting, the result reports the achieved length against
  the target. A miss of more than ±20% is kept in the persistent report.
  (BUG-005)

**Dialogs and keyboard**

- The unsaved-changes dialog now offers **Save / Don't Save / Cancel**, for
  closing a tab and for ⌘Q (asked once per unsaved tab). Esc or a dismissed
  dialog always means Cancel. A cancelled Save As or a failed write keeps the
  tab open. (BUG-011)
- The last tab can be closed. It is replaced by a fresh untitled tab, and the
  close X is always visible. ⌘W closes the tab, not the window. (BUG-018)
- Draft, Help, Settings, the prompt and the command palette share one modal
  layer. Esc closes the topmost dialog, except during IME conversion. Tab is
  trapped inside the dialog, the background is inert, and focus returns when the
  dialog closes. While a dialog is open, document shortcuts and menu commands do
  nothing. ⌘K does not open the palette over another dialog. (BUG-016/017)
- A Japanese IME Enter or Esc that confirms a conversion no longer submits or
  closes the palette, prompts, Draft, Settings or the find bar.
- No document shortcut or menu command acts behind presentation mode.
- An AI draft that fails before any content arrives no longer leaves an empty
  tab. The dialog stays open with your inputs, an inline error and Retry. A
  failure after partial content keeps the partial draft in its own unsaved tab.
  A draft that finishes in a background tab lands in that tab. (BUG-014)
- Analyze is disabled and does nothing on an empty document. The changes label
  never says "No changes" while the document is unsaved, and reports
  title-only changes. (BUG-015)

**Find and Replace** (BUG-010)

- New Find (⌘F), Find and Replace (⌥⌘F), Find Next/Previous (⌘G / ⇧⌘G) and Go to
  Line (⌘L, Markdown source). They are available from the Edit menu, the
  palette and a docked find bar, which is not a modal. Search handles CJK and
  mixed scripts, with case and whole-word options. Replacement text is inserted
  literally. Replace All is one undo step. ⌘Z right after Replace undoes the
  replacement. Full-width digits typed with the IME work in Go to Line. Find in
  Slides mode is planned.

**Settings and models**

- The retired `meta-llama/llama-3.3-70b-instruct:free` preset is no longer
  seeded for new installs. Lists you already saved are left as they are.
  (BUG-013)
- An HTTP 404 from the provider is classified the same way on every path. It
  names the model and is shown in Japanese. The status bar keeps a persistent
  **モデル利用不可: {model}** chip with **設定を開く**. (BUG-013)
- New **OpenRouter model catalog** in Settings (palette: "Browse OpenRouter
  models…"). Nothing is fetched until you press Fetch. The stored API key is
  sent only when the *saved* endpoint is OpenRouter.
- Export and save commands refuse a path without the expected extension. This
  includes dotfiles such as `.zshrc`.
- Settings, keychain, session and file commands no longer run on the main
  thread. This is a BUG-006 mitigation, not a fix.

**Japanese UI**

- The remaining English in the Japanese UI is translated. This covers toasts,
  the Draft dialog, Citations, Library, the slide rail, the network panel,
  export warnings, AI errors and Help, whose 日本語 page now uses the real
  Japanese control names. Wording fixes include 「Markdown」, 「ファイル一覧を
  非表示／表示」, a Save split button with 別名で保存… ⇧⌘S (⇧⌘S used to overwrite),
  and Draft lengths in 文字. (BUG-009, UX audit)
- The per-paragraph ✨ button is now named by outcome:
  「AIで書き換え・翻訳・図解…」.
- Slide commands are in the palette in Slides mode: add, duplicate, delete,
  merge, split, AI layout, summarize.
- Help shows the build identity, for example `バージョン 1.4.0 (abc1234-dirty)`,
  so a QA report can name the exact binary.

**Known limitations / planned** (summary — the complete Known Issues and
Future Release lists are in `release-notes/v1.4.0.en.md`)

- BUG-006 (intermittent accessibility hang on long Markdown) is mitigated, not
  closed. Closing it needs a profiling run with Instruments.
- BUG-019c (`**# 見出し**` wrapping) has no code path. Confirm it by clipboard
  or a file diff, not by an accessibility read.
- English-output draft length overrun (BUG-005) has not been re-verified.
- An empty ATX heading (`## ` with no text) is not treated as a heading, in the
  GUI or the CLI/MCP import.
- Find in Slides mode, slide-title Markdown, structured tables in slides and
  PPTX, and a native **Print…** command are planned.
- The PPTX has no notes master. Some versions of PowerPoint or Keynote may offer
  to repair a deck that has speaker notes.
- The OpenRouter catalog needs the endpoint and key to be saved first; until
  then **Fetch** is disabled and says why.
- Images read for the preview or export are limited by extension and size
  (25 MB), but not to the document folder. MCP export does not resolve
  document-relative figures yet; that is pending a decision.
- The unsaved-dialog button order ([Cancel][Don't Save][Save]) is a recorded
  deviation that is awaiting product sign-off.

### NurumayuEditor + Markdown workspace

- Renamed the application to **NurumayuEditor** across the window, native menu,
  help, CLI/MCP identity, package metadata, and exported presentation metadata.
  The stable bundle id, keychain service, and `.aix` extension remain unchanged
  so existing settings and documents continue to work.
- Added a CodeMirror Markdown workspace with **Edit**, live GFM **Preview**, and
  side-by-side **Split** layouts. Markdown source is retained verbatim while its
  headings, paragraphs, images, and Mermaid blocks remain available to the
  existing AI and slide projections.
- `.md` and `.markdown` files now open as first-class documents and save back to
  their original path atomically; native `.aix` documents remain supported.
- Markdown preview text is now directly editable in Split and Preview, uses a
  Japanese-capable Gothic/sans-serif stack, renders safe inline image data URLs
  (including URL-encoded SVG), and exposes source links through an open popover.
- Added a Finder-style Markdown folder browser: navigate nested folders in
  columns and single-click a file for a non-destructive instant preview before
  explicitly opening it for editing.

### Stage 1 (開発.txt §5 — 主戦場の完成)

- **Speaker notes** — every slide's heading chunk can carry speaker notes
  (`metadata.notes`), edited in a labeled textarea in Slide view, exported as a
  proper `notesSlide` OOXML part in `.pptx` (skipped entirely for slides with no
  notes, so empty decks stay untouched), and round-tripped losslessly through
  `.aix`. XML-escaped through the same helper as slide bodies.
  _(Superseded in the QA fix pass above: notes now live on the slide's lead
  chunk, so a title-derived first slide can hold notes too — BUG-007.)_
- **"Changes since last save" view** — the health bar now shows how many
  paragraphs changed since the last save/open, backed by a new document-level
  diff (added / removed / changed, by chunk id, CJK-safe) and a docked panel
  reusing the existing per-paragraph diff highlighting. Reachable from the
  health bar or the command palette ("Show changes since last save").
- **Presentation mode** — "Present" (toolbar button in Slide view, or the
  command palette) opens a fullscreen, keyboard-driven slideshow (←/→/Space to
  navigate, Esc to exit, `N` to toggle the current slide's speaker notes),
  rendered with the exact same slide component Preview/export use, so what you
  present matches what exports. A weekly lab-meeting talk no longer needs a
  PPTX export step first.
- **Headless AI via CLI** — `nurumayueditor ai <verb> <file.aix> <chunkId>
  [instruction] [--json]` runs any existing per-paragraph AI action
  (translate/proofread/summarize/…) from a script or agent, without the GUI.
  Read-only in this pass (prints a result, does not modify the source file).
  The `capabilities` manifest now reports `"aiActionsRunVia": ["gui", "cli"]`
  and lists `"ai"` among its CLI verbs.
- **CI** — `.github/workflows/ci.yml` now runs `cargo test --lib`, `npm test`,
  and `npm run build` on every push/PR.

### Stage 2 (開発.txt §5 — 第二波＋堀の公開)

- **"Zero external transmission" visibility** — the health bar now shows a
  live count of external calls this session ("N AI · M fetch"), backed by
  atomic counters at every real outbound network site: the three OpenRouter
  call sites in `ai.rs` (via their shared retry funnel) *and* `net.rs`'s
  guarded reference/image fetch — correcting an earlier assumption that
  `net.rs` alone was the sole chokepoint; it wasn't.
- **Minimal MCP server** (`nurumayueditor mcp`) — a standards-correct,
  read-only Model Context Protocol server over stdio (JSON-RPC 2.0,
  newline-delimited), so any MCP client (Claude Desktop, Claude Code, or
  otherwise) can inspect a `.aix` document without the GUI: `list_chunks`,
  `get_chunk`, `get_document`, `analyze`, and `export`. Malformed input,
  unknown methods, and unknown chunk ids all return proper JSON-RPC errors —
  never a crash that would kill the persistent server process. Write/apply-edit
  is intentionally **not** implemented yet (planned, pending a decision on
  approval-gated writes) and is documented as such, not silently absent.
- **Ghost-text inline completion** (Phase 6) — a low-latency, low-temperature
  inline suggestion as you type at the end of a paragraph (Tab accepts,
  Escape dismisses, any other key lets it vanish); only one in-flight request
  at a time, newest wins. An opt-in "limit to a local model" setting refuses
  to fire at all against a non-local endpoint rather than silently ignoring
  the preference.
- **Grant-application beachhead** (generic infrastructure only — bundling any
  specific official form is an explicit open decision, not attempted here):
  a configurable, CJK-aware per-paragraph character-limit warning in the
  health bar, and a "Check against review criteria" panel where you supply
  your own list of criteria and the AI flags which ones have no supporting
  paragraph anywhere in the document.

### Stage 3 (開発.txt §5 — 差別化の第二幕)

- **Personal RAG** (Phase 8) — an opt-in, fully on-device knowledge base of
  your own past papers and notes. Add reference files to your personal
  library; the AI can then optionally ground drafts/revisions in the most
  relevant passages, citing which source files it drew from. Embedding
  (`fastembed`, local ONNX) and similarity search (`sqlite-vec`) run entirely
  on-device — the only network activity anywhere in this feature is a
  one-time embedding-model download the first time it's used, never a
  per-search or per-add call (proven by a test asserting Stage 2's
  external-transmission counters don't move across repeated add/search
  cycles). Deliberately does not repurpose the existing same-document
  `linkedChunks` relationship field for this — a new, independent index is
  the cross-document link mechanism instead, so the relationship-graph
  subsystem is untouched.
- **Citation management** (Phase 9) — "bring your own references and format
  them," not a literature-search feature. Import a `.bib` file (the universal
  Zotero/reference-manager export format), format entries in APA or IEEE
  style, look up a DOI or arXiv id to auto-fill an entry via the guarded
  fetch, and insert a formatted citation or build an end-of-document
  bibliography. Citations are stored per-document (a JSON sidecar next to the
  `.aix` file), travel with the paper that cites them.

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
  _(Superseded in Unreleased: the GUI no longer prints PDFs through the
  webview. PDF export is now written by the Rust renderer, and diagrams appear
  as their Mermaid source, counted in the export report — BUG-003.)_
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
  _(Superseded in Unreleased: the print-dialog route is no longer used. PDF
  export now goes through a save dialog and the Rust PDF renderer — BUG-003.
  A native "Print…" command is planned.)_
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
