"use client";

import { useState } from "react";
import { useCurrentProject } from "@/lib/store";

export type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error"; log: string };

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tikdrawer";
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Rasterize the (already-rendered) SVG to a PNG via an <img> + canvas. This is
 *  exactly what the browser is painting in the preview, so the exported PNG
 *  reflects what you see — useful to check whether the glyphs are real text or
 *  boxes. `scale` bumps the resolution above the SVG's intrinsic pt size. */
function exportPng(svg: string, filename: string, scale = 3): void {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const w = (img.naturalWidth || img.width || 300) * scale;
    const h = (img.naturalHeight || img.height || 300) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((png) => {
      if (png) download(filename, png);
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    window.alert("Could not rasterize the SVG to PNG in this browser.");
  };
  img.src = url;
}

/** Strip the `<?xml …?>` prolog / comments so the SVG embeds cleanly via
 *  innerHTML (a leading prolog can confuse the HTML parser in some browsers). */
function inlineSvg(svg: string): string {
  const i = svg.indexOf("<svg");
  return i > 0 ? svg.slice(i) : svg;
}

export function PreviewPanel({
  state,
  onExportPdf,
}: {
  state: RenderState;
  /** Compile and return the figure as a PDF (base64), or an error log. */
  onExportPdf?: () => Promise<{ pdf: string | null; log?: string }>;
}) {
  const project = useCurrentProject();
  const name = slugify(project.name);
  const svg = state.status === "ok" ? state.svg : null;
  const [pdfBusy, setPdfBusy] = useState(false);

  async function exportPdf() {
    if (!onExportPdf || pdfBusy) return;
    setPdfBusy(true);
    try {
      const { pdf, log } = await onExportPdf();
      if (pdf) {
        const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
        download(`${name}.pdf`, new Blob([bytes], { type: "application/pdf" }));
      } else {
        window.alert(`PDF export failed:\n${log ?? "unknown error"}`);
      }
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Preview</span>
        <div className="flex items-center gap-2">
          {state.status === "loading" && <span className="text-xs text-blue-500">rendering…</span>}
          {state.status === "error" && <span className="text-xs text-red-500">error</span>}
          {svg && (
            <>
              <button
                onClick={() => download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }))}
                title="Download the rendered SVG"
                className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
              >
                Download SVG
              </button>
              <button
                onClick={() => exportPng(svg, `${name}.png`)}
                title="Export the preview as a PNG image"
                className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
              >
                Export PNG
              </button>
              {onExportPdf && (
                <button
                  onClick={exportPdf}
                  disabled={pdfBusy}
                  title="Compile the figure to a PDF (vector, ready to \includegraphics)"
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50"
                >
                  {pdfBusy ? "Exporting…" : "Export PDF"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {state.status === "idle" && (
          <p className="text-sm text-slate-400">Draw something to see a LaTeX-rendered preview.</p>
        )}
        {state.status === "loading" && <p className="text-sm text-slate-400">Compiling with LaTeX…</p>}
        {state.status === "ok" && (
          <div
            className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: inlineSvg(state.svg) }}
          />
        )}
        {state.status === "error" && (
          <pre className="overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
            {state.log}
          </pre>
        )}
      </div>
    </div>
  );
}
