// Renders a chunk's Mermaid code as inline SVG (spec §3.3). Errors are caught
// and shown in place rather than crashing the editor.
//
// The lazy mermaid loader + config live in ../mermaidRender so the preview,
// AI validation and export rasterisation share a single-source configuration.

import { useEffect, useRef, useState } from "react";
import { getMermaid } from "../mermaidRender";

let mermaidSeq = 0;

export default function MermaidChunk({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mmd-${(mermaidSeq += 1)}`);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setError(null);
      if (ref.current) ref.current.innerHTML = "";
      return;
    }
    getMermaid()
      .then((mermaid) => mermaid.render(idRef.current, trimmed))
      .then(({ svg }) => {
        if (cancelled) return;
        setError(null);
        if (ref.current) ref.current.innerHTML = svg;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        // Mermaid may leave a temporary measuring node behind on failure.
        document.getElementById(idRef.current)?.remove();
        document.getElementById(`d${idRef.current}`)?.remove();
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="my-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        <div className="mb-1 font-medium">Diagram could not be rendered</div>
        <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="mermaid-render my-2 flex justify-center rounded-lg bg-gray-50 p-4"
    />
  );
}
