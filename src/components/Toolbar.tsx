"use client";

import { useStore } from "@/lib/store";
import type { Tool } from "@/lib/types";

function ToolIcon({ tool }: { tool: Tool }) {
  const s = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (tool) {
    case "select":
      return (
        <svg {...s} fill="currentColor" stroke="none">
          <path d="M4 3l15 7.5-6.2 1.8L10 21z" />
        </svg>
      );
    case "line":
      return (
        <svg {...s}>
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      );
    case "rect":
      return (
        <svg {...s}>
          <rect x="4" y="6" width="16" height="12" rx="1" />
        </svg>
      );
    case "circle":
      return (
        <svg {...s}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...s}>
          <ellipse cx="12" cy="12" rx="9" ry="6" />
        </svg>
      );
    case "node":
      return (
        <svg {...s}>
          <rect x="4" y="6" width="16" height="12" rx="1" />
          <line x1="7" y1="10.5" x2="17" y2="10.5" />
          <line x1="7" y1="14" x2="13" y2="14" />
        </svg>
      );
    case "connector":
      return (
        <svg {...s}>
          <path d="M6.5 17.5C11 14 13 10 17.5 6.5" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="5" r="2" />
        </svg>
      );
    case "diamond":
      return (
        <svg {...s}>
          <path d="M12 3 21 12 12 21 3 12Z" />
        </svg>
      );
    case "roundrect":
      return (
        <svg {...s}>
          <rect x="4" y="7" width="16" height="10" rx="4" />
        </svg>
      );
    case "cylinder":
      return (
        <svg {...s}>
          <ellipse cx="12" cy="6" rx="7" ry="2.6" />
          <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
        </svg>
      );
    case "polygon":
      return (
        <svg {...s}>
          <path d="M12 3 20 9 17 19 7 19 4 9Z" />
        </svg>
      );
  }
}

export type ToolDef = { id: Tool; label: string; key?: string; hint: string };

const SELECT_TOOL: ToolDef = { id: "select", label: "Select", key: "V", hint: "Select / move shapes" };

const SHAPE_TOOLS: ToolDef[] = [
  { id: "line", label: "Line", key: "L", hint: "Drag to draw a line" },
  { id: "rect", label: "Rectangle", key: "R", hint: "Drag a bounding box" },
  { id: "circle", label: "Circle", key: "C", hint: "Drag from center outward" },
  { id: "ellipse", label: "Ellipse", key: "E", hint: "Drag a bounding box" },
  { id: "node", label: "Text node", key: "T", hint: "Click to place text, then type" },
];

const PRESET_TOOLS: ToolDef[] = [
  { id: "diamond", label: "Diamond", key: "D", hint: "Decision / rhombus" },
  { id: "roundrect", label: "Rounded box", key: "U", hint: "Rounded rectangle" },
  { id: "cylinder", label: "Cylinder", key: "Y", hint: "Database / cylinder" },
  { id: "polygon", label: "Polygon", key: "P", hint: "Click vertices; Enter/dbl-click to finish" },
];

const CONNECT_TOOLS: ToolDef[] = [
  { id: "connector", label: "Connector", key: "X", hint: "Drag between shapes to connect" },
];

/** Lookup used by the keyboard shortcut handler. */
export const TOOL_BY_KEY: Record<string, Tool> = Object.fromEntries(
  [SELECT_TOOL, ...SHAPE_TOOLS, ...PRESET_TOOLS, ...CONNECT_TOOLS]
    .filter((t) => t.key)
    .map((t) => [t.key!.toLowerCase(), t.id]),
);

function ToolButton({ t }: { t: ToolDef }) {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const active = tool === t.id;
  return (
    <button
      title={`${t.label} (${t.key}) — ${t.hint}`}
      aria-label={`${t.label} (${t.key})`}
      aria-pressed={active}
      onClick={() => setTool(t.id)}
      className={`relative flex aspect-square items-center justify-center rounded transition ${
        active ? "bg-blue-600 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
      }`}
    >
      <ToolIcon tool={t.id} />
      {t.key && (
        <span
          className={`absolute bottom-0.5 right-1 text-[9px] font-semibold ${
            active ? "text-blue-100" : "text-slate-400"
          }`}
        >
          {t.key}
        </span>
      )}
    </button>
  );
}

function Group({ title, tools }: { title: string; tools: ToolDef[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <div className="grid grid-cols-3 gap-1.5">
        {tools.map((t) => (
          <ToolButton key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}

export function Toolbar() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tool</h3>
        <div className="grid grid-cols-3 gap-1.5">
          <ToolButton t={SELECT_TOOL} />
        </div>
      </div>
      <Group title="Shapes" tools={SHAPE_TOOLS} />
      <Group title="Presets" tools={PRESET_TOOLS} />
      <Group title="Connect" tools={CONNECT_TOOLS} />
    </div>
  );
}
