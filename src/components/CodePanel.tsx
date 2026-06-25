"use client";

import { useState } from "react";
import { fullDocument } from "@/lib/generateTikz";
import { useCurrentProject } from "@/lib/store";

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tikdrawer"
  );
}

export function CodePanel({ code }: { code: string }) {
  const project = useCurrentProject();
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  function downloadTex() {
    const blob = new Blob([fullDocument(code)], { type: "text/x-tex" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(project.name)}.tex`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">TikZ code</span>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100">
            {copied ? "Copied!" : "Copy"}
          </button>
          <button onClick={downloadTex} className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100">
            Download .tex
          </button>
        </div>
      </div>
      <pre className="flex-1 overflow-auto bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
