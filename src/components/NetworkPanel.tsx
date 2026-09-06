// Relationship network graph (spec §3.4). Renders the LLM analysis with
// Cytoscape; tapping a node jumps to (and flashes) the matching paragraph,
// tapping an edge flashes both of its endpoint paragraphs.

import cytoscape from "cytoscape";
import { useEffect, useMemo, useRef } from "react";
import { useT } from "../i18n";
import { pruneAnalysis, useStore } from "../store";
import { analyzeDocument } from "../aiActions";
import { CloseIcon, NetworkIcon, SpinnerIcon } from "./icons";

// Canonical relation → edge color (line + arrow). The analyzer lowercases
// relations to this set; unknown/legacy values fall through to the grey base
// edge style. The legend below the header is driven by the same map.
const RELATION_COLORS: Record<string, string> = {
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

/** "analyzed …" timestamp: s/min/h/d ago, or a locale date past a week. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d <= 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Map a graph node back to its owning paragraph chunk id. Sentence node ids
 * look like "{paragraphId}#s{n}"; prefer the node's parent field and fall
 * back to splitting the id (sentence nodes whose paragraph has no node of
 * its own are not compounds, so they carry no parent in cytoscape).
 */
function nodeChunkId(node: cytoscape.NodeSingular): string {
  const parent = node.data("parent") as string | undefined;
  if (parent) return parent;
  const id = node.id();
  const cut = id.indexOf("#s");
  return cut >= 0 ? id.slice(0, cut) : id;
}

export default function NetworkPanel() {
  const t = useT();
  const analysis = useStore((s) => s.analysis);
  const analysisStale = useStore((s) => s.analysisStale);
  const globalBusy = useStore((s) => s.globalBusy);
  const flashChunk = useStore((s) => s.flashChunk);
  const flashChunks = useStore((s) => s.flashChunks);
  const focusedChunkId = useStore((s) => s.focusedChunkId);
  const toggleNetwork = useStore((s) => s.toggleNetwork);
  const chunks = useStore((s) => s.doc.chunks);

  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Key on the id list — not the chunks array — so plain typing (which swaps
  // the array identity every keystroke) doesn't rebuild the graph.
  const chunkIdKey = chunks.map((c) => c.id).join(" ");
  const validChunkIds = useMemo(
    () => new Set(chunkIdKey.split(" ").filter(Boolean)),
    [chunkIdKey]
  );

  // Item 52 (FE half): build from the shared pruning helper instead of an
  // ad-hoc dangling filter, so the panel and the store agree on what survives
  // a structural edit. Identity is preserved when nothing was pruned so text
  // edits don't force a cytoscape rebuild.
  const pruned = useMemo(() => {
    const p = pruneAnalysis(analysis, validChunkIds);
    if (!p || !analysis) return p;
    return p.nodes.length === analysis.nodes.length &&
      p.edges.length === analysis.edges.length
      ? analysis
      : p;
  }, [analysis, validChunkIds]);

  // Legend lists only the canonical relations actually drawn (self-edges are
  // dropped from the graph, so they don't count here either).
  const legendRelations = useMemo(() => {
    if (!pruned) return [];
    const present = new Set(
      pruned.edges.filter((e) => e.source !== e.target).map((e) => e.relation)
    );
    return Object.keys(RELATION_COLORS).filter((r) => present.has(r));
  }, [pruned]);

  useEffect(() => {
    if (!containerRef.current || !pruned) return;

    const nodeIds = new Set(pruned.nodes.map((n) => n.id));
    const elements: cytoscape.ElementDefinition[] = [];
    for (const n of pruned.nodes) {
      const kind = n.kind === "sentence" ? "sentence" : "paragraph";
      const full = n.label || n.summary || "·";
      const data: Record<string, unknown> = {
        id: n.id,
        // Labels wrap inside the node; cap the raw text so one verbose
        // summary can't dwarf the graph.
        label: full.length > 80 ? `${full.slice(0, 79)}…` : full,
        summary: n.summary,
        kind,
      };
      // Nest sentence nodes inside their paragraph (compound) when it exists.
      if (kind === "sentence" && n.parent && nodeIds.has(n.parent)) {
        data.parent = n.parent;
      }
      elements.push({ data });
    }
    pruned.edges.forEach((e, i) => {
      // pruneAnalysis drops dangling endpoints but deliberately keeps
      // self-edges; they carry no visual information, so drop them here.
      if (e.source !== e.target) {
        elements.push({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.relation || "",
            relation: e.relation || "",
          },
        });
      }
    });

    // cytoscape retained; relation-colored edges + legend chosen over a d3
    // rewrite (item 50).
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node[kind="paragraph"]',
          style: {
            shape: "round-rectangle",
            "background-color": "#2563eb",
            label: "data(label)",
            color: "#ffffff",
            "font-size": 10,
            "font-weight": "bold",
            "text-wrap": "wrap",
            "text-max-width": "130px",
            "text-valign": "center",
            "text-halign": "center",
            width: "label",
            height: "label",
            padding: "7px",
            "border-width": 2,
            "border-color": "#bfdbfe",
          },
        },
        {
          selector: 'node[kind="sentence"]',
          style: {
            "background-color": "#94a3b8",
            label: "data(label)",
            color: "#52606d",
            "font-size": 8,
            "text-wrap": "wrap",
            "text-max-width": "90px",
            "text-valign": "bottom",
            "text-margin-y": 2,
            width: 9,
            height: 9,
            "border-width": 1,
            "border-color": "#e2e8f0",
          },
        },
        {
          // Paragraph nodes that contain sentence nodes render as a labelled
          // box (compound sizing overrides the width/height above). Kept
          // subtle so the sentence dots inside stay the focus.
          selector: ":parent",
          style: {
            "background-color": "#2563eb",
            "background-opacity": 0.04,
            "border-width": 1,
            "border-color": "#dbeafe",
            shape: "round-rectangle",
            padding: "10px",
            label: "data(label)",
            "font-size": 10,
            "font-weight": "bold",
            color: "#1f2933",
            "text-valign": "top",
            "text-margin-y": -2,
            "text-wrap": "wrap",
            "text-max-width": "150px",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#cbd5e1",
            "target-arrow-color": "#cbd5e1",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#7b8794",
            "text-rotation": "autorotate",
            "text-background-color": "#ffffff",
            "text-background-padding": "1px",
            // Hidden by default; the zoom handler reveals labels (and their
            // white halo) via edge.show-label so dense graphs stay legible.
            "text-opacity": 0,
            "text-background-opacity": 0,
          },
        },
        // Data-driven relation colors (line + arrow); unknown/legacy
        // relations fall through to the grey base style above.
        ...Object.entries(RELATION_COLORS).map(([relation, color]) => ({
          selector: `edge[relation = "${relation}"]`,
          style: { "line-color": color, "target-arrow-color": color },
        })),
        {
          // Toggled by the zoom handler: labels only render at >= 0.8 zoom.
          selector: "edge.show-label",
          style: { "text-opacity": 1, "text-background-opacity": 0.85 },
        },
        {
          selector: "edge.hovered",
          style: { width: 3 },
        },
        {
          // Mirrors the editor's focused paragraph (focusedChunkId effect).
          // overlay-* rather than underlay-*: the installed typings predate
          // the underlay properties, and the soft halo reads the same.
          selector: "node.focused",
          style: {
            "border-width": 3,
            "border-color": "#1d4ed8",
            "overlay-color": "#60a5fa",
            "overlay-opacity": 0.2,
            "overlay-padding": 5,
          },
        },
        {
          selector: "node:active",
          style: { "overlay-color": "#2563eb", "overlay-opacity": 0.2 },
        },
      ],
      layout: { name: "cose", animate: false, padding: 24, nodeDimensionsIncludeLabels: true },
      minZoom: 0.2,
      maxZoom: 2.5,
    });

    cy.on("tap", "node", (evt) => {
      // Sentence nodes jump to their owning paragraph; paragraphs to themselves.
      flashChunk(nodeChunkId(evt.target));
    });
    cy.on("tap", "edge", (evt) => {
      // Flash BOTH endpoint paragraphs so the relation reads in the editor.
      const edge = evt.target;
      flashChunks([nodeChunkId(edge.source()), nodeChunkId(edge.target())]);
    });
    cy.on("mouseover", "edge", (evt) => evt.target.addClass("hovered"));
    cy.on("mouseout", "edge", (evt) => evt.target.removeClass("hovered"));

    // Edge labels clutter a dense zoomed-out graph — only show them near 1:1.
    const syncEdgeLabels = () => {
      cy.edges().toggleClass("show-label", cy.zoom() >= 0.8);
    };
    cy.on("zoom", syncEdgeLabels);
    syncEdgeLabels();

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [pruned, flashChunk, flashChunks]);

  // Editor → graph sync: outline the node whose paragraph currently has
  // focus. Depends on `pruned` too so the class is re-applied after a graph
  // rebuild. Deliberately no fit/center — the user may just be typing.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("focused");
    if (focusedChunkId) cy.getElementById(focusedChunkId).addClass("focused");
  }, [focusedChunkId, pruned]);

  const relayout = () => {
    cyRef.current
      ?.layout({ name: "cose", animate: true, padding: 24, nodeDimensionsIncludeLabels: true })
      .run();
  };

  const isEmpty = !pruned || pruned.nodes.length === 0;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <NetworkIcon /> Relationships
          {!isEmpty && analysisStale && (
            <span
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
              title={t("The document changed since this graph was built — click Refresh to re-analyze.")}
            >
              out of date
            </span>
          )}
          {!isEmpty && analysis?.analyzedAt !== undefined && (
            <span
              className="whitespace-nowrap text-[10px] font-normal text-ink-faint"
              title={new Date(analysis.analyzedAt).toLocaleString()}
            >
              analyzed {relativeTime(analysis.analyzedAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void analyzeDocument()}
            className={`rounded px-2 py-1 text-xs hover:bg-gray-100 ${
              !isEmpty && analysisStale
                ? "font-medium text-amber-700"
                : "text-ink-soft"
            }`}
            disabled={!!globalBusy}
            title={t("Re-analyze document")}
          >
            {t("Refresh")}
          </button>
          <button
            onClick={relayout}
            className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-gray-100"
            disabled={isEmpty}
            title={t("Re-layout graph")}
          >
            {t("Re-layout")}
          </button>
          <button
            onClick={() => toggleNetwork(false)}
            className="rounded p-1 text-ink-faint hover:bg-gray-100 hover:text-ink"
            aria-label={t("Close panel")}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {legendRelations.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-gray-100 px-3 py-1.5 text-[10px] text-ink-soft">
          {legendRelations.map((r) => (
            <span key={r} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: RELATION_COLORS[r] }}
              />
              {r}
            </span>
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {globalBusy && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-accent">
            <SpinnerIcon className="mr-2 text-accent" /> {globalBusy}
          </div>
        )}
        {isEmpty && !globalBusy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-sm text-ink-faint">
            <NetworkIcon className="mb-2 h-6 w-6" />
            No relationships yet. Click “Analyze” to extract the logical structure
            of your document.
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 px-3 py-2 text-xs text-ink-faint">
        {t("Tap a node to jump to its paragraph; tap an edge to flash both ends.")}
      </div>
    </aside>
  );
}
