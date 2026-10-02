// Pure labels and colours for the relationship graph (NetworkPanel.tsx).
//
// Constraints:
// - RELATION_COLORS is the single relation → colour map: it drives both the
//   cytoscape edge styles and the legend, so the two cannot disagree.
// - Relation names are shown localized (legend and edge labels); the
//   canonical English name stays the data value. Unknown/legacy relations are
//   shown as-is.
// - relativeTime takes `now` so it is deterministic in tests.
// - Keys are passed to translateWith as literals so the i18n coverage scan
//   sees them; NETWORK_LABEL_KEYS lists them for the JA-entry test.

import { translateWith, type UiLang } from "./i18n";

// Canonical relation → edge color (line + arrow). The analyzer lowercases
// relations to this set; unknown/legacy values fall through to the grey base
// edge style.
export const RELATION_COLORS: Record<string, string> = {
  cause: "#ea580c",
  effect: "#d97706",
  evidence: "#059669",
  claim: "#7c3aed",
  elaboration: "#9ca3af",
  contrast: "#dc2626",
  condition: "#0891b2",
  example: "#65a30d",
  definition: "#475569",
  sequence: "#2563eb",
};

const RELATION_LABELS: Record<string, (lang: UiLang) => string> = {
  cause: (lang) => translateWith("cause", lang, {}),
  effect: (lang) => translateWith("effect", lang, {}),
  evidence: (lang) => translateWith("evidence", lang, {}),
  claim: (lang) => translateWith("claim", lang, {}),
  elaboration: (lang) => translateWith("elaboration", lang, {}),
  contrast: (lang) => translateWith("contrast", lang, {}),
  condition: (lang) => translateWith("condition", lang, {}),
  example: (lang) => translateWith("example", lang, {}),
  definition: (lang) => translateWith("definition", lang, {}),
  sequence: (lang) => translateWith("sequence", lang, {}),
};

export const NETWORK_LABEL_KEYS = [
  ...Object.keys(RELATION_COLORS),
  "{n}s ago",
  "{n} min ago",
  "{n}h ago",
  "{n}d ago",
  "analyzed {when}",
  "Relationships",
  "out of date",
  "No relationships yet. Click “Refresh” to extract the logical structure of your document.",
] as const;

/** Localized relation name for the legend and edge labels. */
export function relationLabel(relation: string, lang: UiLang): string {
  const label = Object.prototype.hasOwnProperty.call(RELATION_LABELS, relation)
    ? RELATION_LABELS[relation]
    : undefined;
  return label ? label(lang) : relation;
}

/** s/min/h/d ago, or a locale date past a week. Future timestamps read as 0 s. */
export function relativeTime(ts: number, lang: UiLang, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return translateWith("{n}s ago", lang, { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return translateWith("{n} min ago", lang, { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return translateWith("{n}h ago", lang, { n: h });
  const d = Math.round(h / 24);
  if (d <= 7) return translateWith("{n}d ago", lang, { n: d });
  return new Date(ts).toLocaleDateString(lang === "ja" ? "ja-JP" : undefined);
}

/** The header's "analyzed …" label ("analyzed 3 min ago" / "3分前に分析"). */
export function analyzedLabel(ts: number, lang: UiLang, now: number = Date.now()): string {
  return translateWith("analyzed {when}", lang, { when: relativeTime(ts, lang, now) });
}
