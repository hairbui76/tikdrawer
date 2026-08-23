import { fmtUnit, lenToCm, pxToCmX, pxToCmY, round, type Unit } from "./coords";
import { connectorPoints, roundedSegments, shapeCenter, smoothControls } from "./geometry";
import { imageFileName } from "./images";
import { fontPtOf } from "./text";
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

const TEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * `font=…` for a label, always emitted so the PDF matches the canvas. Without
 * it LaTeX uses the document's 10pt while the canvas draws ~11.4pt, so the
 * preview never quite agreed with the editor. Baseline skip follows the usual
 * 1.2× convention.
 */
function fontOpt(style: Style): string {
  const pt = round(fontPtOf(style));
  return `, font=\\fontsize{${pt}}{${round(pt * 1.2)}}\\selectfont`;
}

/**
 * Make label text safe to drop into a tikzpicture. Unescaped text is a hard
 * failure, not a cosmetic one: a single `&` in a label ("Observation &") aborts
 * the whole compile with "Misplaced alignment tab character", so nothing renders
 * at all — which is what happened to text-heavy imported SVGs.
 *
 * Balanced `$…$` spans are passed through untouched so a label can still hold
 * real math (`$x^2$`, `$\alpha$`); an unpaired `$` is escaped like any other
 * special character.
 */
export function escapeTexText(text: string): string {
  const escape = (s: string): string => s.replace(/[\\&%$#_{}~^]/g, (c) => TEX_SPECIALS[c]);
  const parts = text.split("$");
  // An odd number of parts means the `$`s pair up; the odd-indexed pieces are
  // then the math spans. Otherwise there is a stray `$` and nothing is math.
  if (parts.length % 2 === 0) return escape(text);
  return parts.map((part, i) => (i % 2 === 1 ? `$${part}$` : escape(part))).join("");
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
      return `\\node[text=${tikzColor(s.style.stroke)}${fillOpt}${rotNode(s.rotation)}${fontOpt(s.style)}] at ${coord(s.at.x, s.at.y, u)} {${escapeTexText(s.text)}};`;
    }
    case "connector": {
      const pts = connectorPoints(s, byId);
      const opts = styleOpts(s.style, { arrow: true });
      if (s.curved && pts.length >= 2) {
        const segs = smoothControls(pts);
        let path = coordP(pts[0], u);
        segs.forEach((c, i) => {
          path += ` .. controls ${coordP(c.c1, u)} and ${coordP(c.c2, u)} .. ${coordP(pts[i + 1], u)}`;
        });
        return `\\draw[${opts}] ${path};`;
      }
      return `\\draw[${opts}] ${pts.map((p) => coordP(p, u)).join(" -- ")};`;
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
      // Centerlined strokes need round caps/joins or the PDF shows stubby
      // ends and cracked corners wherever segments meet.
      const caps = s.style.fill === "none" ? ", line cap=round, line join=round" : "";
      const opts = `${styleOpts(s.style)}${caps}${rotPath(s.rotation, cx, cy, u)}`;
      if (s.rounded && s.points.length >= 3) {
        // Mixed Bézier path from the same control points the canvas renders,
        // so the PDF matches the preview: curves through gentle vertices,
        // exact joins at sharp corners.
        const segs = roundedSegments(s.points, s.closed);
        let path = coordP(s.points[0], u);
        segs.forEach((seg, i) => {
          const last = s.closed && i === segs.length - 1;
          const to = last ? "cycle" : coordP(s.points[(i + 1) % s.points.length], u);
          path += seg.straight
            ? ` -- ${to}`
            : ` .. controls ${coordP(seg.c1, u)} and ${coordP(seg.c2, u)} .. ${to}`;
        });
        return `\\draw[${opts}] ${path};`;
      }
      const path = s.points.map((p) => coord(p.x, p.y, u)).join(" -- ");
      return `\\draw[${opts}] ${path}${s.closed ? " -- cycle" : ""};`;
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
  return `\n  \\node[text=${tikzColor(s.style.stroke)}${rotNode(rotation)}${fontOpt(s.style)}] at ${coord(c.x, c.y, u)} {${escapeTexText(text)}};`;
}

export function generateTikz(shapes: Shape[], unit: Unit = "cm", images?: Map<string, ImageAsset>): string {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const body = shapes.map((s) => "  " + shapeToTikz(s, byId, unit, images) + labelOf(s, unit)).join("\n");
  return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
}

/**
 * Where the figure will live in the reader's paper. "full" emits the raw
 * tikzpicture at its natural size; "column" wraps it in
 * `\resizebox{\columnwidth}{!}{…}` so it fits one column of a two-column
 * layout (the drawing canvas is 20cm wide — far wider than any column).
 */
export type TexLayout = "full" | "column";

export function wrapForLayout(tikz: string, layout: TexLayout): string {
  if (layout !== "column") return tikz;
  // graphicx provides \resizebox — loaded by fullDocument below, and by
  // virtually every paper template. The trailing % after \end{tikzpicture}
  // keeps a spurious space out of the box.
  return `\\resizebox{\\columnwidth}{!}{%\n${tikz}%\n}`;
}

/** Wrap a tikzpicture block into a compilable standalone document. */
export function fullDocument(tikz: string, layout: TexLayout = "full"): string {
  return [
    "\\documentclass[tikz,border=2pt]{standalone}",
    // Unicode text support (e.g. Vietnamese "ớ", accents, symbols). Works with
    // any engine: pdfLaTeX uses inputenc/fontenc (T5 = Vietnamese) + Latin
    // Modern; XeLaTeX/LuaLaTeX use fontspec with a full Unicode font.
    "\\usepackage{iftex}",
    "\\ifPDFTeX",
    "  \\usepackage[utf8]{inputenc}",
    "  \\usepackage[T1,T5]{fontenc}",
    "  \\usepackage{lmodern}",
    "\\else",
    "  \\usepackage{fontspec}",
    "\\fi",
    "\\usepackage{graphicx}",
    "\\usepackage{tikz}",
    "\\usetikzlibrary{arrows.meta,calc,positioning,patterns,shapes}",
    // standalone has no meaningful \columnwidth; give the resizebox a typical
    // two-column paper's column (IEEE ≈ 8.9cm, ACM ≈ 8.45cm) so the download
    // compiles and previews at a realistic size. In the real paper the wrapper
    // picks up the template's own \columnwidth instead.
    ...(layout === "column" ? ["\\setlength{\\columnwidth}{8.5cm} % one column of a two-column paper"] : []),
    "\\begin{document}",
    tikz,
    "\\end{document}",
    "",
  ].join("\n");
}
