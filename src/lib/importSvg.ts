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

import { pxToPt } from "./coords";
import { fitIntoCanvas } from "./importTikz";
import { CANVAS_FONT_FAMILY, textWidthPx } from "./text";
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

/* ---------------------------------- css ----------------------------------- */

// Illustrator, Figma and most hand-written SVGs put their colours and fonts in a
// <style> block and reference them by class, so ignoring stylesheets means
// ignoring most of the styling: text comes out in the default colour and every
// font size is unknown. We resolve a deliberately small subset — the flat
// `tag`, `.class`, `#id` selectors (optionally combined, optionally comma
// separated) that SVG exporters actually emit. No descendant combinators,
// pseudo-classes, media queries or specificity ordering: later rules simply win,
// which matches how these files are written.

type CssRule = { sel: string[]; decls: Record<string, string> };

function parseDecls(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    if (name) decls[name] = part.slice(i + 1).trim();
  }
  return decls;
}

/** Collect the rules of every <style> element in the document. */
function collectCss(root: Element): CssRule[] {
  const rules: CssRule[] = [];
  for (const styleEl of Array.from(root.ownerDocument?.getElementsByTagName("style") ?? [])) {
    const text = (styleEl.textContent || "").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const sel = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      const decls = parseDecls(m[2]);
      if (sel.length && Object.keys(decls).length) rules.push({ sel, decls });
    }
  }
  return rules;
}

/** Does `el` match a flat `tag` / `.class` / `#id` selector (or a combination)? */
function selectorMatches(el: Element, sel: string): boolean {
  const parts = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!parts) return false;
  if (parts[1] && parts[1].toLowerCase() !== el.tagName.toLowerCase()) return false;
  const classes = (el.getAttribute("class") || "").trim().split(/\s+/);
  for (const token of parts[2].match(/[.#][\w-]+/g) ?? []) {
    const name = token.slice(1);
    if (token[0] === "." ? !classes.includes(name) : el.getAttribute("id") !== name) return false;
  }
  return parts[1] !== undefined || parts[2] !== "";
}

/** The value `name` takes from the stylesheet for `el` (last matching rule). */
function cssProp(el: Element, name: string, css: CssRule[]): string | null {
  let found: string | null = null;
  for (const rule of css) {
    if (name in rule.decls && rule.sel.some((s) => selectorMatches(el, s))) found = rule.decls[name];
  }
  return found;
}

/* --------------------------------- style ---------------------------------- */

/**
 * Read a presentation property for `el`, walking up for inherited values.
 * Per element the order is CSS precedence: inline `style` beats a stylesheet
 * rule, which beats the presentation attribute.
 */
function getProp(el: Element, name: string, css: CssRule[]): string | null {
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== "svg") {
    const style = cur.getAttribute("style");
    if (style) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
      if (m) return m[1].trim();
    }
    const fromCss = cssProp(cur, name, css);
    if (fromCss != null) return fromCss;
    const attr = cur.getAttribute(name);
    if (attr != null) return attr.trim();
    cur = cur.parentElement;
  }
  return null;
}

/** SVG's initial font-size, used when a `<text>` declares none. */
const DEFAULT_FONT_SIZE = 16;

/** A CSS length in user units (px), or null. `em`/`rem`/`%` resolve against the
 *  16px CSS default rather than a real cascade — good enough for a size hint. */
function cssLength(raw: string, unit: string | undefined): number | null {
  const v = parseFloat(raw);
  if (Number.isNaN(v) || v <= 0) return null;
  const px =
    unit === "pt" ? v * (96 / 72)
    : unit === "em" || unit === "rem" ? v * DEFAULT_FONT_SIZE
    : unit === "%" ? (v / 100) * DEFAULT_FONT_SIZE
    : v;
  // A parse slip must not turn into a giant text offset.
  return px >= 1 && px <= 400 ? px : null;
}

/** The font stack a `<text>` asks for, for measuring its width faithfully. */
function fontFamilyOf(el: Element, css: CssRule[]): string {
  const direct = getProp(el, "font-family", css);
  if (direct) return direct;
  const shorthand = getProp(el, "font", css);
  // In the `font` shorthand the family is everything after the size (and any
  // `/line-height`): `700 25px Arial,Helvetica` → `Arial,Helvetica`.
  const m = shorthand && /[\d.]+(?:px|pt|em|rem|%)(?:\s*\/\s*[^\s]+)?\s+(.+)$/.exec(shorthand);
  return m ? m[1].trim() : CANVAS_FONT_FAMILY;
}

/** Font size in user units, resolving the `font:` shorthand exporters love. */
function fontSizeOf(el: Element, css: CssRule[]): number {
  const direct = getProp(el, "font-size", css);
  if (direct) {
    const m = /(-?[\d.]+)\s*(px|pt|em|rem|%)?/.exec(direct);
    const v = m && cssLength(m[1], m[2]);
    if (v) return v;
  }
  const shorthand = getProp(el, "font", css);
  if (shorthand) {
    // In the `font` shorthand the size is the first length that carries a UNIT.
    // Bare leading numbers are the weight — reading `font:700 25px Arial` as
    // 700px blew every text offset up by 28×, pushing labels off the canvas.
    const m = /(-?[\d.]+)(px|pt|em|rem|%)/.exec(shorthand);
    const v = m && cssLength(m[1], m[2]);
    if (v) return v;
  }
  return DEFAULT_FONT_SIZE;
}

function styleOf(el: Element, avgScale: number, css: CssRule[]): Style {
  const style: Style = { ...DEFAULT_STYLE };
  const stroke = parseCssColor(getProp(el, "stroke", css));
  const fill = parseCssColor(getProp(el, "fill", css));

  if (stroke && stroke !== "none") style.stroke = stroke;
  else if (fill && fill !== "none") style.stroke = fill; // borderless → match fill
  style.fill = fill && fill !== "none" ? fill : "none";

  // SVG stroke widths are user units (px); `lineWidth` is TeX pt. Skipping this
  // conversion inflated every stroke by ~1.4× before `fitIntoCanvas` had even
  // scaled the drawing down. An absent stroke-width means the SVG default of 1.
  const sw = getProp(el, "stroke-width", css);
  const swPx = sw == null ? 1 : parseFloat(sw);
  if (!Number.isNaN(swPx)) style.lineWidth = Math.max(0.05, pxToPt(swPx * avgScale));

  const dash = getProp(el, "stroke-dasharray", css);
  if (dash && dash !== "none") style.dashed = true;

  const op = getProp(el, "opacity", css);
  const fo = getProp(el, "fill-opacity", css);
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

// The model has no Bézier primitive, so curves are *flattened* into enough
// straight segments to still read as curves. Previously the control points were
// simply dropped and only the endpoint kept, which turned every rounded icon
// into an angular blob — a shield became a pentagon, a speech bubble a wedge.
//
// One flattening segment per this many user units of control-polygon length.
// Small enough that icon-sized curves keep their shape, large enough that a
// full-page path doesn't explode into thousands of vertices.
const CURVE_STEP = 4;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 48;

const hypot = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

const segmentCount = (approxLength: number): number =>
  Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.ceil(approxLength / CURVE_STEP)));

type PathScanner = {
  /** Next command letter, or null if the next thing isn't one. */
  command: () => string | null;
  /** Is another coordinate available (i.e. does the last command repeat)? */
  hasNumber: () => boolean;
  number: () => number;
  /** An arc flag: a single `0` or `1`, which may be glued to its neighbours. */
  flag: () => boolean;
};

/**
 * A scanner over a path `d`. Reading numbers on demand (rather than tokenising
 * the whole string up front) is what makes elliptical arcs work: their flag
 * arguments may be packed without separators — `a5 5 0 0110 10` — so only a
 * reader that knows it wants a single 0-or-1 next can split them correctly.
 */
function pathScanner(d: string): PathScanner {
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const number = (): number => {
    skip();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) {
      i++; // unparseable: step over it so we can't loop forever
      return 0;
    }
    i += m[0].length;
    return parseFloat(m[0]);
  };
  return {
    command: () => {
      skip();
      const c = d[i];
      if (c && /[a-zA-Z]/.test(c)) {
        i++;
        return c;
      }
      return null;
    },
    hasNumber: () => {
      skip();
      return /[-+.\d]/.test(d[i] ?? "");
    },
    number,
    flag: () => {
      skip();
      const c = d[i];
      if (c === "0" || c === "1") {
        i++;
        return c === "1";
      }
      return number() !== 0;
    },
  };
}

/** Sample a cubic Bézier, excluding `p0` (already on the path). */
function flattenCubic(p0: Point, c1: Point, c2: Point, p1: Point, push: (p: Point) => void): void {
  const n = segmentCount(hypot(p0, c1) + hypot(c1, c2) + hypot(c2, p1));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    push({
      x: a * p0.x + b * c1.x + c * c2.x + e * p1.x,
      y: a * p0.y + b * c1.y + c * c2.y + e * p1.y,
    });
  }
}

/** Sample a quadratic Bézier, excluding `p0`. */
function flattenQuad(p0: Point, c: Point, p1: Point, push: (p: Point) => void): void {
  const n = segmentCount(hypot(p0, c) + hypot(c, p1));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    });
  }
}

/** Signed angle from vector u to vector v. */
function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)));
  return ux * vy - uy * vx < 0 ? -a : a;
}

/**
 * Sample an elliptical arc (`A`), excluding `p0`. Uses the endpoint →
 * centre parameterisation from the SVG spec (implementation notes F.6.5).
 */
function flattenArc(
  p0: Point,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
  push: (p: Point) => void,
): void {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) {
    push(p1); // degenerate radii mean a straight line, per spec
    return;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cosP * dx + sinP * dy;
  const y1 = -sinP * dx + cosP * dy;

  // Scale the radii up if they are too small to span the two endpoints.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }

  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2;
  const cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2;

  const theta = angleBetween(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angleBetween((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const n = segmentCount(Math.abs(delta) * Math.max(rx, ry));
  for (let k = 1; k <= n; k++) {
    const t = theta + (delta * k) / n;
    const ct = Math.cos(t), st = Math.sin(t);
    push({
      x: cx + rx * ct * cosP - ry * st * sinP,
      y: cy + rx * ct * sinP + ry * st * cosP,
    });
  }
}

/**
 * Split a path `d` into subpaths of on-path points, flattening curves. Returns
 * `{ points, closed }` per subpath.
 */
function parsePath(d: string): { points: Point[]; closed: boolean }[] {
  const out: { points: Point[]; closed: boolean }[] = [];
  const scan = pathScanner(d);
  let cmd = "";
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  // Previous curve's control point, reflected by the shorthand S/T commands.
  let lastCubicCtrl: Point | null = null;
  let lastQuadCtrl: Point | null = null;
  let pts: Point[] = [];

  const push = (p: Point) => { cur = p; pts.push(p); };
  const flush = (closed: boolean) => {
    if (pts.length) out.push({ points: pts, closed });
    pts = [];
  };

  for (;;) {
    const letter = scan.command();
    if (letter) cmd = letter;
    else if (!cmd || !scan.hasNumber()) break; // no repeat left → done
    if (!cmd) break;

    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };
    const upper = cmd.toUpperCase();
    // Z takes no arguments; every other command needs at least one number.
    if (upper !== "Z" && !scan.hasNumber()) break;

    const pt = (): Point => ({ x: base.x + scan.number(), y: base.y + scan.number() });
    const reflect = (ctrl: Point | null): Point =>
      ctrl ? { x: 2 * cur.x - ctrl.x, y: 2 * cur.y - ctrl.y } : { ...cur };

    switch (upper) {
      case "M": {
        if (pts.length) flush(false);
        const p = pt();
        start = p;
        push(p);
        cmd = rel ? "l" : "L"; // implicit repeats of M are lineto
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "L": push(pt()); lastCubicCtrl = lastQuadCtrl = null; break;
      case "H": push({ x: base.x + scan.number(), y: cur.y }); lastCubicCtrl = lastQuadCtrl = null; break;
      case "V": push({ x: cur.x, y: base.y + scan.number() }); lastCubicCtrl = lastQuadCtrl = null; break;
      case "C": {
        const from = cur, c1 = pt(), c2 = pt(), to = pt();
        flattenCubic(from, c1, c2, to, push);
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "S": {
        const from = cur, c1 = reflect(lastCubicCtrl), c2 = pt(), to = pt();
        flattenCubic(from, c1, c2, to, push);
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "Q": {
        const from = cur, c = pt(), to = pt();
        flattenQuad(from, c, to, push);
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        break;
      }
      case "T": {
        const from = cur, c = reflect(lastQuadCtrl), to = pt();
        flattenQuad(from, c, to, push);
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        break;
      }
      case "A": {
        const from = cur;
        const rx = scan.number(), ry = scan.number(), rot = scan.number();
        const large = scan.flag(), sweep = scan.flag();
        const to = pt();
        flattenArc(from, rx, ry, rot, large, sweep, to, push);
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "Z":
        push({ ...start });
        flush(true);
        cur = start;
        lastCubicCtrl = lastQuadCtrl = null;
        // Z is the one command that takes no arguments, so it cannot repeat.
        // Clearing `cmd` stops the loop from re-running it forever on malformed
        // data like "zzz 1 2 3", where no number ever gets consumed.
        cmd = "";
        break;
      default:
        // Unknown command letter: consume its numbers so we make progress.
        while (scan.hasNumber()) scan.number();
        break;
    }
  }
  flush(false);
  return out.filter((sp) => sp.points.length >= 2);
}

/* --------------------------------- elements ------------------------------- */

function elementToShapes(el: Element, css: CssRule[]): Shape[] {
  const tag = el.tagName.toLowerCase();
  const m = ctmOf(el);
  const { sx, sy, rotDeg, axisAligned } = decompose(m);
  const avg = (Math.abs(sx) + Math.abs(sy)) / 2 || 1;
  const style = styleOf(el, avg, css);
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
      const text = (el.textContent || "").trim();
      if (!text) return [];
      // SVG anchors text at a baseline and, by default, starts it to the RIGHT
      // of x. A TikZ node (and our canvas) centres on its point instead, so the
      // raw coordinate pulls every label half its own width to the left — which
      // is what dragged labels on top of the icons they belong to. Shift the
      // point to the box centre the original layout reserved.
      const size = fontSizeOf(el, css);
      const anchor = (getProp(el, "text-anchor", css) || "start").toLowerCase();
      // Measured in the source's own font, so the offset matches the space the
      // original layout actually gave this label.
      const width = textWidthPx(text, size, fontFamilyOf(el, css));
      const dx = anchor === "middle" ? 0 : anchor === "end" ? -width / 2 : width / 2;
      // `dominant-baseline: middle/central` already means "centre on y".
      const baseline = (getProp(el, "dominant-baseline", css) || "").toLowerCase();
      const centred = baseline === "middle" || baseline === "central";
      const dy = centred ? 0 : -size * 0.36; // baseline → visual centre

      const at = T({ x: num(el, "x") + dx, y: num(el, "y") + dy });
      // In SVG, a <text>'s `fill` is the GLYPH color, not a background box.
      // `styleOf` already folds it into `stroke` (= node text color); force the
      // node background transparent so the text isn't hidden behind a filled box.
      // Keep the source's text size (scaled by the CTM) so headings stay bigger
      // than body labels instead of everything collapsing to one size.
      return [{
        id: uid(),
        kind: "node",
        at,
        text,
        style: { ...style, fill: "none", fontSize: Math.max(0.5, pxToPt(size * avg)) },
      }];
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

  const root = doc.querySelector("svg")!;
  const css = collectCss(root);

  const shapes: Shape[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (SHAPE_TAGS.has(tag)) shapes.push(...elementToShapes(el, css));
    // `defs`/`symbol`/`clipPath` contents aren't rendered directly — skip them.
    if (tag === "defs" || tag === "symbol" || tag === "clippath" || tag === "mask") return;
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);

  return fitIntoCanvas(shapes);
}
