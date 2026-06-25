import { sideToAngle } from "./geometry";
import { DEFAULT_STYLE, type Shape, type Side } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

const ORIGIN = { x: 0, y: 0 };

function box(id: string, x1: number, y1: number, x2: number, y2: number, stroke: string): Shape {
  return { id, kind: "rect", p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, style: { ...DEFAULT_STYLE, stroke } };
}

function label(x: number, y: number, text: string, stroke: string): Shape {
  return { id: uid(), kind: "node", at: { x, y }, text, style: { ...DEFAULT_STYLE, stroke } };
}

function conn(from: string, fromSide: Side, to: string, toSide: Side, curved = false): Shape {
  return {
    id: uid(),
    kind: "connector",
    from: { point: ORIGIN, anchor: from, attach: sideToAngle(fromSide) },
    to: { point: ORIGIN, anchor: to, attach: sideToAngle(toSide) },
    curved,
    control: ORIGIN,
    style: { ...DEFAULT_STYLE, arrow: "->", stroke: "#334155" },
  };
}

export type Template = { id: string; name: string; build: () => Shape[] };

export const TEMPLATES: Template[] = [
  {
    id: "flow-v",
    name: "Flowchart (vertical)",
    build: () => {
      const b1 = uid(), b2 = uid(), b3 = uid();
      return [
        box(b1, 300, 80, 500, 140, "#1d4ed8"), label(400, 110, "Start", "#1d4ed8"),
        box(b2, 300, 260, 500, 320, "#1d4ed8"), label(400, 290, "Process", "#1d4ed8"),
        box(b3, 300, 440, 500, 500, "#1d4ed8"), label(400, 470, "End", "#1d4ed8"),
        conn(b1, "s", b2, "n"),
        conn(b2, "s", b3, "n"),
      ];
    },
  },
  {
    id: "pipeline-h",
    name: "Pipeline (horizontal)",
    build: () => {
      const a = uid(), b = uid(), c = uid();
      return [
        box(a, 40, 260, 220, 330, "#7c3aed"), label(130, 295, "Input", "#7c3aed"),
        box(b, 310, 260, 490, 330, "#7c3aed"), label(400, 295, "Transform", "#7c3aed"),
        box(c, 580, 260, 760, 330, "#7c3aed"), label(670, 295, "Output", "#7c3aed"),
        conn(a, "e", b, "w"),
        conn(b, "e", c, "w"),
      ];
    },
  },
  {
    id: "client-server",
    name: "Client ⇄ Server",
    build: () => {
      const client = uid(), server = uid();
      return [
        box(client, 80, 250, 280, 330, "#1d4ed8"), label(180, 290, "Client", "#1d4ed8"),
        box(server, 520, 250, 720, 330, "#dc2626"), label(620, 290, "Server", "#dc2626"),
        { ...(conn(client, "e", server, "w", true) as Shape & { kind: "connector" }), control: { x: 400, y: 220 } },
        { ...(conn(server, "w", client, "e", true) as Shape & { kind: "connector" }), control: { x: 400, y: 360 } },
      ];
    },
  },
];
