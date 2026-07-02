// Parse an SVG file into editable shapes (which then regenerate tikzpicture code
// via generateTikz). Supports the common primitives: line, rect, circle,
// ellipse, polygon/polyline, path (straight + curve endpoints), and text.
// Element/ancestor transforms (translate/scale/rotate/matrix) are applied.
//
// SVG user space is px with the same orientation as our canvas (origin
// top-left, y-down), so coordinates map 1:1; `fitIntoCanvas` rescales anything
// that lands outside the canvas. Requires a DOM (browser) via DOMParser.
//
// NOTE: like importTikz, this intentionally breaks the one-way data-flow rule
// because the user asked to open external SVGs as editable drawings.

import { fitIntoCanvas } from "./importTikz";
import { DEFAULT_STYLE, type Point, type Shape, type Style } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/* --------------------------------- matrix --------------------------------- */

// Affine matrix [a,b,c,d,e,f]: (x,y) → (a·x + c·y + e, b·x + d·y + f).
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Mat, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Parse an SVG `transform` attribute into a matrix. */
function parseTransform(str: string | null): Mat {
  if (!str) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(str))) {
    const n = g[2].split(/[\s,]+/).map(Number).filter((x) => !Number.isNaN(x));
    let t: Mat = IDENTITY;
    switch (g[1]) {
      case "matrix": if (n.length === 6) t = n as Mat; break;
      case "translate": t = [1, 0, 0, 1, n[0] || 0, n[1] || 0]; break;
      case "scale": t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const a = ((n[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (n.length >= 3) {
          const cx = n[1], cy = n[2];
          t = mul(mul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
        } else t = rot;
        break;
      }
      case "skewX": t = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

/** Combined transform from the document root down to (and including) `el`. */
function ctmOf(el: Element): Mat {
  const chain: Element[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== "svg") {
    chain.unshift(cur);
    cur = cur.parentElement;
  }
  let m: Mat = IDENTITY;
  for (const node of chain) m = mul(m, parseTransform(node.getAttribute("transform")));
  return m;
}

/** Decompose a matrix into scale + rotation (no skew), for native shapes. */
function decompose(m: Mat): { sx: number; sy: number; rotDeg: number; axisAligned: boolean } {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = sx === 0 ? 0 : det / sx;
  const rot = Math.atan2(b, a);
  const axisAligned = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6;
  return { sx, sy: Math.abs(sy) * Math.sign(sy || 1), rotDeg: (rot * 180) / Math.PI, axisAligned };
}

/* --------------------------------- colors --------------------------------- */

const CSS_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  lime: "#00ff00", blue: "#0000ff", cyan: "#00ffff", aqua: "#00ffff",
  magenta: "#ff00ff", fuchsia: "#ff00ff", yellow: "#ffff00", gray: "#808080",
  grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
  navy: "#000080", teal: "#008080", purple: "#800080", orange: "#ffa500",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", indigo: "#4b0082",
};

const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** CSS/SVG color → hex, `"none"` passthrough, or null if unknown. */
function parseCssColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "none" || s === "transparent") return "none";
  if (CSS_COLORS[s]) return CSS_COLORS[s];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const rgb = /rgba?\(([^)]+)\)/.exec(s);
  if (rgb) {
    const n = rgb[1].split(",").map((x) => parseFloat(x));
    if (n.length >= 3) return `#${to2(n[0])}${to2(n[1])}${to2(n[2])}`;
  }
  return null;
}

/* --------------------------------- style ---------------------------------- */

/** Read a presentation property from `el` or its ancestors (inline style wins). */
function getProp(el: Element, name: string): string | null {
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== "svg") {
    const style = cur.getAttribute("style");
    if (style) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
      if (m) return m[1].trim();
    }
    const attr = cur.getAttribute(name);
    if (attr != null) return attr.trim();
    cur = cur.parentElement;
  }
  return null;
}

function styleOf(el: Element, avgScale: number): Style {
  const style: Style = { ...DEFAULT_STYLE };
  const stroke = parseCssColor(getProp(el, "stroke"));
  const fill = parseCssColor(getProp(el, "fill"));

  if (stroke && stroke !== "none") style.stroke = stroke;
  else if (fill && fill !== "none") style.stroke = fill; // borderless → match fill
  style.fill = fill && fill !== "none" ? fill : "none";

  const sw = getProp(el, "stroke-width");
  if (sw) {
    const v = parseFloat(sw);
    if (!Number.isNaN(v)) style.lineWidth = Math.max(0.1, v * avgScale);
  }
  const dash = getProp(el, "stroke-dasharray");
  if (dash && dash !== "none") style.dashed = true;

  const op = getProp(el, "opacity");
  const fo = getProp(el, "fill-opacity");
  const o = op ?? fo;
  if (o) {
    const v = parseFloat(o);
    if (!Number.isNaN(v)) style.opacity = Math.max(0, Math.min(1, v));
  }
  return style;
}

/* --------------------------------- points --------------------------------- */

function parsePointList(raw: string | null): Point[] {
  if (!raw) return [];
  const n = raw.trim().split(/[\s,]+/).map(Number).filter((x) => !Number.isNaN(x));
  const pts: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
  return pts;
}

const num = (el: Element, name: string, def = 0): number => {
  const v = parseFloat(el.getAttribute(name) || "");
  return Number.isNaN(v) ? def : v;
};

/* ---------------------------------- path ---------------------------------- */

// Split a path `d` into subpaths of on-path points (curve control points are
// dropped; we keep segment endpoints). Returns { points, closed } per subpath.
function parsePath(d: string): { points: Point[]; closed: boolean }[] {
  const out: { points: Point[]; closed: boolean }[] = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = "";
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let pts: Point[] = [];
  const nextNum = (): number => parseFloat(tokens[i++]);
  const push = (p: Point) => { cur = p; pts.push(p); };
  const flush = (closed: boolean) => {
    if (pts.length) out.push({ points: pts, closed });
    pts = [];
  };

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    switch (cmd.toUpperCase()) {
      case "M": {
        if (pts.length) flush(false);
        const p = { x: base.x + nextNum(), y: base.y + nextNum() };
        start = p;
        push(p);
        cmd = rel ? "l" : "L"; // subsequent implicit coords are lineto
        break;
      }
      case "L": push({ x: base.x + nextNum(), y: base.y + nextNum() }); break;
      case "H": push({ x: base.x + nextNum(), y: cur.y }); break;
      case "V": push({ x: cur.x, y: base.y + nextNum() }); break;
      case "C": { i += 4; push({ x: base.x + nextNum(), y: base.y + nextNum() }); break; }
      case "S": { i += 2; push({ x: base.x + nextNum(), y: base.y + nextNum() }); break; }
      case "Q": { i += 2; push({ x: base.x + nextNum(), y: base.y + nextNum() }); break; }
      case "T": push({ x: base.x + nextNum(), y: base.y + nextNum() }); break;
      case "A": { i += 5; push({ x: base.x + nextNum(), y: base.y + nextNum() }); break; }
      case "Z": push({ ...start }); flush(true); break;
      default: i++; // unknown token, skip
    }
  }
  flush(false);
  return out.filter((sp) => sp.points.length >= 2);
}

/* --------------------------------- elements ------------------------------- */

function elementToShapes(el: Element): Shape[] {
  const tag = el.tagName.toLowerCase();
  const m = ctmOf(el);
  const { sx, sy, rotDeg, axisAligned } = decompose(m);
  const avg = (Math.abs(sx) + Math.abs(sy)) / 2 || 1;
  const style = styleOf(el, avg);
  const T = (p: Point) => apply(m, p);

  switch (tag) {
    case "line": {
      const p1 = T({ x: num(el, "x1"), y: num(el, "y1") });
      const p2 = T({ x: num(el, "x2"), y: num(el, "y2") });
      return [{ id: uid(), kind: "line", p1, p2, style }];
    }
    case "rect": {
      const x = num(el, "x"), y = num(el, "y"), w = num(el, "width"), h = num(el, "height");
      const rounded = num(el, "rx") > 0 || num(el, "ry") > 0;
      if (axisAligned) {
        const p1 = T({ x, y });
        const p2 = T({ x: x + w, y: y + h });
        return [{ id: uid(), kind: rounded ? "roundrect" : "rect", p1, p2, style }];
      }
      // Rotated/skewed → keep exact geometry as a polygon.
      const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(T);
      return [{ id: uid(), kind: "polygon", points: corners, closed: true, style }];
    }
    case "circle": {
      const c = T({ x: num(el, "cx"), y: num(el, "cy") });
      const r = num(el, "r");
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) < 1e-3) {
        return [{ id: uid(), kind: "circle", center: c, r: r * Math.abs(sx), style }];
      }
      return [{ id: uid(), kind: "ellipse", center: c, rx: r * Math.abs(sx), ry: r * Math.abs(sy), style, ...(rotDeg ? { rotation: rotDeg } : {}) }];
    }
    case "ellipse": {
      const c = T({ x: num(el, "cx"), y: num(el, "cy") });
      return [{
        id: uid(), kind: "ellipse", center: c,
        rx: num(el, "rx") * Math.abs(sx), ry: num(el, "ry") * Math.abs(sy),
        style, ...(rotDeg && !axisAligned ? { rotation: rotDeg } : {}),
      }];
    }
    case "polygon":
    case "polyline": {
      const pts = parsePointList(el.getAttribute("points")).map(T);
      if (pts.length < 2) return [];
      return [{ id: uid(), kind: "polygon", points: pts, closed: tag === "polygon", style }];
    }
    case "path": {
      const d = el.getAttribute("d");
      if (!d) return [];
      return parsePath(d).map((sp) => {
        const points = sp.points.map(T);
        if (points.length === 2 && !sp.closed) {
          return { id: uid(), kind: "line", p1: points[0], p2: points[1], style } as Shape;
        }
        return { id: uid(), kind: "polygon", points, closed: sp.closed, style } as Shape;
      });
    }
    case "text": {
      const at = T({ x: num(el, "x"), y: num(el, "y") });
      const text = (el.textContent || "").trim();
      if (!text) return [];
      // In SVG, a <text>'s `fill` is the GLYPH color, not a background box.
      // `styleOf` already folds it into `stroke` (= node text color); force the
      // node background transparent so the text isn't hidden behind a filled box.
      return [{ id: uid(), kind: "node", at, text, style: { ...style, fill: "none" } }];
    }
    default:
      return [];
  }
}

const SHAPE_TAGS = new Set(["line", "rect", "circle", "ellipse", "polygon", "polyline", "path", "text"]);

/**
 * Parse SVG source text into shapes. Returns `[]` if the input isn't valid SVG
 * or nothing was recognised. Must run in a browser (uses DOMParser).
 */
export function importSvg(src: string): Shape[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(src, "image/svg+xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("svg")) return [];

  const shapes: Shape[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (SHAPE_TAGS.has(tag)) shapes.push(...elementToShapes(el));
    // `defs`/`symbol`/`clipPath` contents aren't rendered directly — skip them.
    if (tag === "defs" || tag === "symbol" || tag === "clippath" || tag === "mask") return;
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(doc.querySelector("svg")!);

  return fitIntoCanvas(shapes);
}
