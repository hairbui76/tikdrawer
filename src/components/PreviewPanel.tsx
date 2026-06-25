"use client";

export type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; svg: string }
  | { status: "error"; log: string };

export function PreviewPanel({ state }: { state: RenderState }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Preview</span>
        {state.status === "loading" && <span className="text-xs text-blue-500">rendering…</span>}
        {state.status === "error" && <span className="text-xs text-red-500">error</span>}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {state.status === "idle" && (
          <p className="text-sm text-slate-400">Draw something to see a LaTeX-rendered preview.</p>
        )}
        {state.status === "loading" && <p className="text-sm text-slate-400">Compiling with LaTeX…</p>}
        {state.status === "ok" && (
          <div
            className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: state.svg }}
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
