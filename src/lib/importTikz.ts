// Parse a TikZ `tikzpicture` (or a full .tex file containing one) into editable
// shapes. This is the reverse of `generateTikz` and is intentionally lossy: it
// understands the primitives this app emits (\draw ... --/rectangle/circle/
// ellipse, \node) plus common hand-written variants. Anything it can't map is
// skipped. Coordinates are converted from TikZ cm back to canvas px.
//
// NOTE: this deliberately breaks the documented one-way data-flow rule
// (model → TikZ → render). It exists because the user asked to open external
// .tex/.svg files as editable drawings. See MEMORY.md.

import { CANVAS_H, CANVAS_W, cmToLen, cmToPxX, cmToPxY, UNIT_PER_CM } from "./coords";
import { DEFAULT_STYLE, type Point, type Shape, type Style } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/* --------------------------------- lengths -------------------------------- */

// value + optional unit → centimetres. TikZ's default (no unit) is cm.
const LEN_RE = /(-?\d*\.?\d+)\s*(cm|mm|pt|bp|in|px|em|ex)?/i;
function lenToCmValue(raw: string): number {
  const m = LEN_RE.exec(raw.trim());
  if (!m) return 0;
  const v = parseFloat(m[1]);
  switch ((m[2] || "cm").toLowerCase()) {
    case "cm": return v;
    case "mm": return v / UNIT_PER_CM.mm; // 10 mm per cm
    case "pt": return v / UNIT_PER_CM.pt;
    case "bp": return v / 28.3464567; // PostScript big point
    case "in": return v * 2.54;
    case "px": return v / 37.795; // ~96dpi
    case "em": return v * 0.35; // rough
    case "ex": return v * 0.15; // rough
    default: return v;
  }
}

/** Parse a `(x,y)` coordinate body ("1cm,2cm") to canvas px, or null. */
function parseCoord(body: string): Point | null {
  const parts = body.split(",");
  if (parts.length !== 2) return null;
  const cx = lenToCmValue(parts[0]);
  const cy = lenToCmValue(parts[1]);
  if (Number.isNaN(cx) || Number.isNaN(cy)) return null;
  return { x: cmToPxX(cx), y: cmToPxY(cy) };
}

/* --------------------------------- colors --------------------------------- */

const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#00ff00",
  blue: "#0000ff", cyan: "#00ffff", magenta: "#ff00ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", lightgray: "#d3d3d3", darkgray: "#a9a9a9",
  orange: "#ff8000", purple: "#800080", brown: "#a52a2a", lime: "#bfff00",
  olive: "#808000", teal: "#008080", violet: "#800080", pink: "#ffc0cb",
};

const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** Parse a TikZ/xcolor color spec to a hex string, or null if unknown. */
function parseColor(raw: string): string | null {
  const s = raw.trim();
  // Inline model: {rgb,255:red,R;green,G;blue,B} or {rgb,1:...}
  const m = /rgb,\s*(\d+(?:\.\d+)?)\s*:\s*red\s*,\s*([\d.]+)\s*;\s*green\s*,\s*([\d.]+)\s*;\s*blue\s*,\s*([\d.]+)/i.exec(s);
  if (m) {
    const denom = parseFloat(m[1]) || 255;
    const scale = 255 / denom;
    return `#${to2(parseFloat(m[2]) * scale)}${to2(parseFloat(m[3]) * scale)}${to2(parseFloat(m[4]) * scale)}`;
  }
  const named = s.replace(/[{}]/g, "").toLowerCase();
  if (NAMED_COLORS[named]) return NAMED_COLORS[named];
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  return null;
}

/* --------------------------------- options -------------------------------- */

/** Split an options string on top-level commas (ignoring commas inside {} / []). */
function splitOpts(opts: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of opts) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

type ParsedOpts = { style: Style; rounded: boolean };

function parseOpts(opts: string): ParsedOpts {
  const style: Style = { ...DEFAULT_STYLE };
  let rounded = false;
  for (const rawTok of splitOpts(opts)) {
    const tok = rawTok.trim();
    if (!tok) continue;
    const eq = tok.indexOf("=");
    const key = (eq >= 0 ? tok.slice(0, eq) : tok).trim().toLowerCase();
    const val = eq >= 0 ? tok.slice(eq + 1).trim() : "";
    switch (key) {
      case "draw": {
        const c = val ? parseColor(val) : null;
        if (c) style.stroke = c;
        break;
      }
      case "color": {
        const c = parseColor(val);
        if (c) style.stroke = c;
        break;
      }
      case "fill": {
        const c = val ? parseColor(val) : null;
        if (c) style.fill = c;
        break;
      }
      case "line width":
        style.lineWidth = lenToCmValue(val) * UNIT_PER_CM.pt; // back to pt
        break;
      case "very thin": style.lineWidth = 0.5; break;
      case "thin": style.lineWidth = 0.8; break;
      case "thick": style.lineWidth = 1.6; break;
      case "very thick": style.lineWidth = 2.4; break;
      case "ultra thick": style.lineWidth = 4; break;
      case "dashed":
      case "dotted":
      case "densely dashed":
      case "loosely dashed":
        style.dashed = true;
        break;
      case "opacity":
      case "draw opacity":
        style.opacity = Math.max(0, Math.min(1, parseFloat(val) || 1));
        break;
      case "->": style.arrow = "->"; break;
      case "<-": style.arrow = "<-"; break;
      case "<->": style.arrow = "<->"; break;
      case "rounded corners": rounded = true; break;
      default: {
        // Arrow tips can appear as e.g. "-{Stealth}" / "-Latex" / "->".
        if (eq < 0 && /[<>]/.test(tok)) {
          if (/^</.test(tok) && />$/.test(tok.replace(/\s/g, ""))) style.arrow = "<->";
          else if (/^</.test(tok)) style.arrow = "<-";
          else if (/>/.test(tok)) style.arrow = "->";
          break;
        }
        // A bare color name/spec (e.g. `\draw[red]`) sets the draw color.
        if (eq < 0) {
          const c = parseColor(tok);
          if (c && c !== "none") style.stroke = c;
        }
        break;
      }
    }
  }
  return { style, rounded };
}

/* -------------------------------- tokenizer ------------------------------- */

type Tok =
  | { t: "coord"; p: Point }
  | { t: "arg"; s: string }
  | { t: "op"; s: "--" | ".." }
  | { t: "word"; s: string }
  | { t: "brace"; s: string };

const KEYWORDS = /^(cycle|controls|and|rectangle|circle|ellipse|node|arc|grid|cos|sin)$/;

function tokenizePath(path: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\(([^)]*)\)|(--)|(\.\.)|\{([^{}]*)\}|\[[^\]]*\]|([A-Za-z][A-Za-z ]*[A-Za-z]|[A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) {
      const p = parseCoord(m[1]);
      toks.push(p ? { t: "coord", p } : { t: "arg", s: m[1] });
    } else if (m[2]) toks.push({ t: "op", s: "--" });
    else if (m[3]) toks.push({ t: "op", s: ".." });
    else if (m[4] !== undefined) toks.push({ t: "brace", s: m[4] });
    else if (m[5]) {
      const w = m[5].trim().toLowerCase();
      if (KEYWORDS.test(w)) toks.push({ t: "word", s: w });
    }
  }
  return toks;
}

/* ------------------------------ path → shapes ----------------------------- */

function firstCoord(toks: Tok[]): Point | null {
  const c = toks.find((t) => t.t === "coord");
  return c && c.t === "coord" ? c.p : null;
}

/** Radius (px) of `... circle (r)` or `circle [radius=r]`. */
function circleRadius(path: string): number | null {
  const inl = /circle\s*(?:\[[^\]]*radius\s*=\s*([^,\]]+)[^\]]*\]|\(([^)]*)\))/i.exec(path);
  if (!inl) return null;
  const raw = (inl[1] ?? inl[2] ?? "").trim();
  if (!raw || raw.includes(",")) return null;
  return cmToLen(lenToCmValue(raw));
}

/** rx/ry (px) of `... ellipse (rx and ry)` or `[x radius=.., y radius=..]`. */
function ellipseRadii(path: string): { rx: number; ry: number } | null {
  const paren = /ellipse\s*\(([^)]*)\)/i.exec(path);
  if (paren) {
    const parts = paren[1].split(/\s+and\s+/i);
    if (parts.length === 2) {
      return { rx: cmToLen(lenToCmValue(parts[0])), ry: cmToLen(lenToCmValue(parts[1])) };
    }
  }
  const xr = /x\s*radius\s*=\s*([^,\]]+)/i.exec(path);
  const yr = /y\s*radius\s*=\s*([^,\]]+)/i.exec(path);
  if (xr && yr) return { rx: cmToLen(lenToCmValue(xr[1])), ry: cmToLen(lenToCmValue(yr[1])) };
  return null;
}

/** On-path points (skips bezier control points), in order. */
function pathPoints(toks: Tok[]): Point[] {
  const pts: Point[] = [];
  let ctrlNext = false;
  for (const tok of toks) {
    if (tok.t === "word") {
      if (tok.s === "controls" || tok.s === "and") ctrlNext = true;
      // rectangle/circle/ellipse handled elsewhere; ignore here
    } else if (tok.t === "op") {
      // '..' / '--' just separate points
    } else if (tok.t === "coord") {
      if (ctrlNext) {
        ctrlNext = false; // this coord is a control point → skip
      } else {
        pts.push(tok.p);
      }
    }
  }
  return pts;
}

function drawToShapes(optsStr: string, path: string): Shape[] {
  const { style, rounded } = parseOpts(optsStr);
  const toks = tokenizePath(path);
  const out: Shape[] = [];

  if (/\brectangle\b/i.test(path)) {
    const coords = toks.filter((t): t is { t: "coord"; p: Point } => t.t === "coord");
    if (coords.length >= 2) {
      const p1 = coords[0].p;
      const p2 = coords[1].p;
      out.push(
        rounded
          ? { id: uid(), kind: "roundrect", p1, p2, style }
          : { id: uid(), kind: "rect", p1, p2, style },
      );
    }
    return out;
  }

  if (/\bcircle\b/i.test(path)) {
    const center = firstCoord(toks);
    const r = circleRadius(path);
    if (center && r) out.push({ id: uid(), kind: "circle", center, r, style });
    return out;
  }

  if (/\bellipse\b/i.test(path)) {
    const center = firstCoord(toks);
    const rr = ellipseRadii(path);
    if (center && rr) out.push({ id: uid(), kind: "ellipse", center, rx: rr.rx, ry: rr.ry, style });
    return out;
  }

  // Plain path: points joined by -- (straight) or .. controls .. (curved).
  const curved = /\bcontrols\b/i.test(path);
  const closed = /\bcycle\b/i.test(path);
  const pts = pathPoints(toks);
  if (pts.length < 2) return out;

  if (!closed && !curved && pts.length === 2) {
    out.push({ id: uid(), kind: "line", p1: pts[0], p2: pts[1], style });
    return out;
  }

  if (curved) {
    // Represent a bezier path as a free curved connector through its on-path pts.
    const [p1, ...rest] = pts;
    const p2 = rest.pop()!;
    out.push({
      id: uid(),
      kind: "connector",
      from: { point: p1, anchor: null, attach: "auto" },
      to: { point: p2, anchor: null, attach: "auto" },
      waypoints: rest,
      curved: true,
      style,
    });
    return out;
  }

  out.push({ id: uid(), kind: "polygon", points: pts, closed, style });
  return out;
}

/* --------------------------------- nodes ---------------------------------- */

// \node[opts] (name) at (x,y) {text};
function nodeToShape(optsStr: string, rest: string): Shape | null {
  const at = /at\s*\(([^)]*)\)/i.exec(rest);
  const pt = at ? parseCoord(at[1]) : firstCoordInText(rest);
  if (!pt) return null;
  const braceStart = rest.lastIndexOf("{");
  const text = braceStart >= 0 ? rest.slice(braceStart + 1, rest.lastIndexOf("}")) : "";
  const { style } = parseOpts(optsStr);
  // `text=<color>` sets the label color → treat as stroke.
  return { id: uid(), kind: "node", at: pt, text: text.trim(), style };
}

function firstCoordInText(s: string): Point | null {
  const m = /\(([^)]*)\)/.exec(s);
  return m ? parseCoord(m[1]) : null;
}

/* ------------------------------ statement split --------------------------- */

/** Extract the tikzpicture body from a full document, or return input as-is. */
export function extractTikzBody(src: string): string {
  const m = /\\begin\{tikzpicture\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{tikzpicture\}/.exec(src);
  return m ? m[1] : src;
}

/** Strip TeX comments (unescaped %). */
function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && line[i - 1] !== "\\") break;
        out += line[i];
      }
      return out;
    })
    .join("\n");
}

/** Split a tikzpicture body into individual `;`-terminated statements. */
function splitStatements(body: string): string[] {
  const stmts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

/** Pull the leading `[...]` option block from a command remainder. */
function takeOptions(s: string): { opts: string; rest: string } {
  const t = s.replace(/^\s+/, "");
  if (t[0] !== "[") return { opts: "", rest: t };
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "[") depth++;
    else if (t[i] === "]") {
      depth--;
      if (depth === 0) return { opts: t.slice(1, i), rest: t.slice(i + 1) };
    }
  }
  return { opts: "", rest: t };
}

/* --------------------------------- public --------------------------------- */

/**
 * Parse TikZ source (a bare tikzpicture body, a full `\begin{tikzpicture}…`, or
 * a whole .tex document) into shapes. Returns `[]` when nothing was recognised.
 */
export function importTikz(src: string): Shape[] {
  const body = stripComments(extractTikzBody(src));
  const shapes: Shape[] = [];

  for (const stmt of splitStatements(body)) {
    const cmd = /^\\(draw|path|fill|filldraw|node)\b/i.exec(stmt);
    if (!cmd) continue;
    const kind = cmd[1].toLowerCase();
    const after = stmt.slice(cmd[0].length);
    const { opts, rest } = takeOptions(after);

    if (kind === "node") {
      const n = nodeToShape(opts, rest);
      if (n) shapes.push(n);
    } else {
      // fill/filldraw imply a fill color if none was given.
      let optsStr = opts;
      if ((kind === "fill" || kind === "filldraw") && !/\bfill\b/i.test(opts)) {
        optsStr = opts ? `${opts}, fill=black` : "fill=black";
      }
      shapes.push(...drawToShapes(optsStr, rest));
    }
  }

  return fitIntoCanvas(shapes);
}

/**
 * If the imported drawing falls outside the canvas (common when the source uses
 * a very different scale/origin), uniformly scale + translate it to fit with a
 * margin. In-bounds drawings are left exactly as-is so round-trips are faithful.
 */
export function fitIntoCanvas(shapes: Shape[], margin = 40): Shape[] {
  if (!shapes.length) return shapes;
  const pts = shapes.flatMap(shapePoints);
  if (!pts.length) return shapes;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const inBounds = minX >= 0 && minY >= 0 && maxX <= CANVAS_W && maxY <= CANVAS_H;
  if (inBounds) return shapes;

  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = Math.min(1, (CANVAS_W - 2 * margin) / w, (CANVAS_H - 2 * margin) / h);
  const offX = margin - minX * scale;
  const offY = margin - minY * scale;
  const tx = (p: Point): Point => ({ x: p.x * scale + offX, y: p.y * scale + offY });
  return shapes.map((s) => transformShape(s, tx, scale));
}

function shapePoints(s: Shape): Point[] {
  switch (s.kind) {
    case "line": return [s.p1, s.p2];
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image": return [s.p1, s.p2];
    case "circle": return [{ x: s.center.x - s.r, y: s.center.y - s.r }, { x: s.center.x + s.r, y: s.center.y + s.r }];
    case "ellipse": return [{ x: s.center.x - s.rx, y: s.center.y - s.ry }, { x: s.center.x + s.rx, y: s.center.y + s.ry }];
    case "node": return [s.at];
    case "polygon": return s.points;
    case "connector": return [s.from.point, s.to.point, ...s.waypoints];
  }
}

function transformShape(s: Shape, tx: (p: Point) => Point, scale: number): Shape {
  switch (s.kind) {
    case "line":
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return { ...s, p1: tx(s.p1), p2: tx(s.p2) };
    case "circle":
      return { ...s, center: tx(s.center), r: s.r * scale };
    case "ellipse":
      return { ...s, center: tx(s.center), rx: s.rx * scale, ry: s.ry * scale };
    case "node":
      return { ...s, at: tx(s.at) };
    case "polygon":
      return { ...s, points: s.points.map(tx) };
    case "connector":
      return {
        ...s,
        from: { ...s.from, point: tx(s.from.point) },
        to: { ...s.to, point: tx(s.to.point) },
        waypoints: s.waypoints.map(tx),
      };
  }
}
