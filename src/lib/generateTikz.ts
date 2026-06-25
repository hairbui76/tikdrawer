import { fmtUnit, lenToCm, pxToCmX, pxToCmY, round, type Unit } from "./coords";
import { connectorControl, quadToCubic, resolveConnector, shapeCenter } from "./geometry";
import { imageFileName } from "./images";
import type { ImageAsset, Point, Shape, Style } from "./types";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(n.slice(0, 2), 16) || 0,
    g: parseInt(n.slice(2, 4), 16) || 0,
    b: parseInt(n.slice(4, 6), 16) || 0,
  };
}

/** xcolor inline rgb model — no need to predefine colors. */
function tikzColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `{rgb,255:red,${r};green,${g};blue,${b}}`;
}

function styleOpts(style: Style, opts: { arrow?: boolean } = {}): string {
  const o: string[] = [];
  o.push(`draw=${tikzColor(style.stroke)}`);
  if (style.fill && style.fill !== "none") o.push(`fill=${tikzColor(style.fill)}`);
  o.push(`line width=${round(style.lineWidth)}pt`);
  if (style.dashed) o.push("dashed");
  if (opts.arrow && style.arrow !== "none") o.push(style.arrow);
  if (style.opacity < 1) o.push(`opacity=${round(style.opacity)}`);
  return o.join(", ");
}

const coord = (x: number, y: number, u: Unit): string => `(${fmtUnit(pxToCmX(x), u)},${fmtUnit(pxToCmY(y), u)})`;
const coordP = (p: Point, u: Unit): string => coord(p.x, p.y, u);
const len = (px: number, u: Unit): string => fmtUnit(lenToCm(px), u);

// Screen rotation is clockwise (y-down); TikZ rotation is CCW (y-up) → negate.
const rotPath = (rotation: number | undefined, cx: number, cy: number, u: Unit): string =>
  rotation ? `, rotate around={${round(-rotation)}:${coord(cx, cy, u)}}` : "";
const rotNode = (rotation: number | undefined): string =>
  rotation ? `, rotate=${round(-rotation)}` : "";

export function shapeToTikz(
  s: Shape,
  byId: Map<string, Shape>,
  u: Unit,
  images?: Map<string, ImageAsset>,
): string {
  switch (s.kind) {
    case "line":
      return `\\draw[${styleOpts(s.style, { arrow: true })}] ${coord(s.p1.x, s.p1.y, u)} -- ${coord(s.p2.x, s.p2.y, u)};`;
    case "rect":
      return `\\draw[${styleOpts(s.style)}${rotPath(s.rotation, (s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2, u)}] ${coord(s.p1.x, s.p1.y, u)} rectangle ${coord(s.p2.x, s.p2.y, u)};`;
    case "circle":
      return `\\draw[${styleOpts(s.style)}] ${coord(s.center.x, s.center.y, u)} circle (${len(s.r, u)});`;
    case "ellipse":
      return `\\draw[${styleOpts(s.style)}${rotPath(s.rotation, s.center.x, s.center.y, u)}] ${coord(s.center.x, s.center.y, u)} ellipse (${len(s.rx, u)} and ${len(s.ry, u)});`;
    case "node": {
      const fillOpt =
        s.style.fill !== "none"
          ? `, fill=${tikzColor(s.style.fill)}, draw=${tikzColor(s.style.stroke)}`
          : "";
      return `\\node[text=${tikzColor(s.style.stroke)}${fillOpt}${rotNode(s.rotation)}] at ${coord(s.at.x, s.at.y, u)} {${s.text}};`;
    }
    case "connector": {
      const { a, b } = resolveConnector(s, byId);
      const opts = styleOpts(s.style, { arrow: true });
      if (s.curved) {
        const { c1, c2 } = quadToCubic(a, s.control, b);
        return `\\draw[${opts}] ${coordP(a, u)} .. controls ${coordP(c1, u)} and ${coordP(c2, u)} .. ${coordP(b, u)};`;
      }
      return `\\draw[${opts}] ${coordP(a, u)} -- ${coordP(b, u)};`;
    }
    case "diamond": {
      const cx = (s.p1.x + s.p2.x) / 2;
      const cy = (s.p1.y + s.p2.y) / 2;
      return `\\draw[${styleOpts(s.style)}${rotPath(s.rotation, cx, cy, u)}] ${coord(cx, s.p1.y, u)} -- ${coord(s.p2.x, cy, u)} -- ${coord(cx, s.p2.y, u)} -- ${coord(s.p1.x, cy, u)} -- cycle;`;
    }
    case "roundrect": {
      const cx = (s.p1.x + s.p2.x) / 2;
      const cy = (s.p1.y + s.p2.y) / 2;
      return `\\draw[${styleOpts(s.style)}, rounded corners=4pt${rotPath(s.rotation, cx, cy, u)}] ${coord(s.p1.x, s.p1.y, u)} rectangle ${coord(s.p2.x, s.p2.y, u)};`;
    }
    case "cylinder": {
      // Emit a TikZ cylinder node (vertical, database style) sized to the box.
      const cx = (s.p1.x + s.p2.x) / 2;
      const cy = (s.p1.y + s.p2.y) / 2;
      const w = len(Math.abs(s.p2.x - s.p1.x), u);
      const h = len(Math.abs(s.p2.y - s.p1.y), u);
      const draw = `draw=${tikzColor(s.style.stroke)}`;
      const fill = s.style.fill !== "none" ? `, fill=${tikzColor(s.style.fill)}` : "";
      return `\\node[cylinder, shape border rotate=90, aspect=0.3, inner sep=0pt, ${draw}${fill}, line width=${round(s.style.lineWidth)}pt, minimum width=${w}, minimum height=${h}${rotNode(s.rotation)}] at ${coord(cx, cy, u)} {};`;
    }
    case "polygon": {
      if (s.points.length < 2) return "";
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const path = s.points.map((p) => coord(p.x, p.y, u)).join(" -- ");
      return `\\draw[${styleOpts(s.style)}${rotPath(s.rotation, cx, cy, u)}] ${path}${s.closed ? " -- cycle" : ""};`;
    }
    case "image": {
      const asset = images?.get(s.imageId);
      const cx = (s.p1.x + s.p2.x) / 2;
      const cy = (s.p1.y + s.p2.y) / 2;
      const w = len(Math.abs(s.p2.x - s.p1.x), u);
      const h = len(Math.abs(s.p2.y - s.p1.y), u);
      if (!asset) return `% image (missing asset)`;
      const op = s.style.opacity < 1 ? `, opacity=${round(s.style.opacity)}` : "";
      return `\\node[inner sep=0pt${op}${rotNode(s.rotation)}] at ${coord(cx, cy, u)} {\\includegraphics[width=${w},height=${h}]{${imageFileName(asset)}}};`;
    }
  }
}

/** A centered text label for a shape that carries `text` (skips node — its
 *  text is the node itself). */
function labelOf(s: Shape, u: Unit): string {
  if (s.kind === "node") return "";
  const text = (s as { text?: string }).text;
  if (!text) return "";
  const c = shapeCenter(s);
  const rotation = (s as { rotation?: number }).rotation;
  return `\n  \\node[text=${tikzColor(s.style.stroke)}${rotNode(rotation)}] at ${coord(c.x, c.y, u)} {${text}};`;
}

export function generateTikz(shapes: Shape[], unit: Unit = "cm", images?: Map<string, ImageAsset>): string {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const body = shapes.map((s) => "  " + shapeToTikz(s, byId, unit, images) + labelOf(s, unit)).join("\n");
  return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
}

/** Wrap a tikzpicture block into a compilable standalone document. */
export function fullDocument(tikz: string): string {
  return [
    "\\documentclass[tikz,border=2pt]{standalone}",
    "\\usepackage{graphicx}",
    "\\usepackage{tikz}",
    "\\usetikzlibrary{arrows.meta,calc,positioning,patterns,shapes}",
    "\\begin{document}",
    tikz,
    "\\end{document}",
    "",
  ].join("\n");
}
