import type { Attach, ConnectorShape, Point, Shape, Side } from "./types";

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Approximate half-size of a text node's clickable / anchor box (px). */
const NODE_HALF = { w: 24, h: 12 };

/** A shape's rotation in degrees (0 if not rotatable / unset). */
export function rotationOf(s: Shape): number {
  return (s as { rotation?: number }).rotation ?? 0;
}

/** Rotate a point around a center by `deg` (screen coords, y-down → clockwise). */
export function rotatePoint(p: Point, c: Point, deg: number): Point {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Bounding box of a list of points. */
function pointsBBox(pts: Point[]): { hw: number; hh: number; cx: number; cy: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  const y1 = Math.min(...ys), y2 = Math.max(...ys);
  return { hw: (x2 - x1) / 2, hh: (y2 - y1) / 2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

/** Half width/height of a shape's bounding box (px), or null if not boxable. */
function halfExtents(s: Shape): { hw: number; hh: number } | null {
  switch (s.kind) {
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return { hw: Math.abs(s.p2.x - s.p1.x) / 2, hh: Math.abs(s.p2.y - s.p1.y) / 2 };
    case "node":
      return { hw: NODE_HALF.w, hh: NODE_HALF.h };
    case "circle":
      return { hw: s.r, hh: s.r };
    case "ellipse":
      return { hw: s.rx, hh: s.ry };
    case "polygon":
      return s.points.length ? { hw: pointsBBox(s.points).hw, hh: pointsBBox(s.points).hh } : null;
    default:
      return null;
  }
}

/** Angle (radians, screen coords, 0 = east, +y down) for each named side. */
export const SIDE_ANGLE: Record<Side, number> = {
  e: 0,
  se: Math.PI / 4,
  s: Math.PI / 2,
  sw: (3 * Math.PI) / 4,
  w: Math.PI,
  nw: -(3 * Math.PI) / 4,
  n: -Math.PI / 2,
  ne: -Math.PI / 4,
};

export function sideToAngle(side: Side): number {
  return SIDE_ANGLE[side];
}

/**
 * Boundary point at a LOCAL `angle` (radians), i.e. relative to the shape's own
 * frame, then rotated into world space. So the port sticks to the shape as it
 * rotates.
 */
export function boundaryAtAngle(s: Shape, angle: number): Point {
  const c = shapeCenter(s);
  const lp = localAnchor(s, { x: c.x + Math.cos(angle) * 1e4, y: c.y + Math.sin(angle) * 1e4 });
  return rotatePoint(lp, c, rotationOf(s));
}

/** LOCAL angle from a shape's center toward a world point (undoes rotation). */
export function angleOf(s: Shape, p: Point): number {
  const c = shapeCenter(s);
  const lp = rotatePoint(p, c, -rotationOf(s));
  return Math.atan2(lp.y - c.y, lp.x - c.x);
}

/** A named connection-port point on a shape (one of the 8 sides). */
export function sidePoint(s: Shape, side: Side): Point {
  return boundaryAtAngle(s, sideToAngle(side));
}

/** Nearest of the 8 named ports to a world point (rotation-aware). */
export function sideOf8(s: Shape, p: Point): Side {
  const idx = ((Math.round(angleOf(s, p) / (Math.PI / 4)) % 8) + 8) % 8;
  // idx: 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE (screen, y down)
  return (["e", "se", "s", "sw", "w", "nw", "n", "ne"] as const)[idx];
}

/** A connection port: its world point + the (local) attach angle that reproduces it. */
export type PortPoint = { point: Point; attach: number };

// Target spacing (px, ~1cm) between adjacent ports; clamped per edge / around.
const PORT_SPACING = 48;
const MIN_PER_EDGE = 2; // 2 per edge → 4 corners + 4 mids = 8 ports minimum
const MAX_PER_EDGE = 6;
const MIN_ROUND = 8;
const MAX_ROUND = 24;

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * The discrete connection ports of a shape, evenly distributed around its
 * outline. The count adapts to size: short edges get the minimum (corners +
 * midpoints), larger shapes get more evenly-spaced points (~1cm apart).
 */
export function portsOf(s: Shape): PortPoint[] {
  const c = shapeCenter(s);
  const rot = rotationOf(s);
  const toPort = (lp: Point): PortPoint => ({
    point: rotatePoint(lp, c, rot),
    attach: Math.atan2(lp.y - c.y, lp.x - c.x),
  });

  if (s.kind === "circle" || s.kind === "ellipse") {
    const rx = s.kind === "circle" ? s.r : s.rx;
    const ry = s.kind === "circle" ? s.r : s.ry;
    const circumference = 2 * Math.PI * ((rx + ry) / 2);
    const n = clampInt(circumference / PORT_SPACING, MIN_ROUND, MAX_ROUND);
    const out: PortPoint[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(toPort({ x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry }));
    }
    return out;
  }

  const ext = halfExtents(s);
  if (!ext) return [];
  const corners: Point[] =
    s.kind === "diamond"
      ? [
          { x: c.x, y: c.y - ext.hh },
          { x: c.x + ext.hw, y: c.y },
          { x: c.x, y: c.y + ext.hh },
          { x: c.x - ext.hw, y: c.y },
        ]
      : [
          { x: c.x - ext.hw, y: c.y - ext.hh },
          { x: c.x + ext.hw, y: c.y - ext.hh },
          { x: c.x + ext.hw, y: c.y + ext.hh },
          { x: c.x - ext.hw, y: c.y + ext.hh },
        ];
  const out: PortPoint[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = clampInt(len / PORT_SPACING, MIN_PER_EDGE, MAX_PER_EDGE);
    for (let j = 0; j < k; j++) {
      const t = j / k;
      out.push(toPort({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
    }
  }
  return out;
}

/** Current width/height (px) of a resizable shape, or null if not resizable. */
export function sizeOf(s: Shape): { w: number; h: number } | null {
  switch (s.kind) {
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return { w: Math.abs(s.p2.x - s.p1.x), h: Math.abs(s.p2.y - s.p1.y) };
    case "circle":
      return { w: s.r * 2, h: s.r * 2 };
    case "ellipse":
      return { w: s.rx * 2, h: s.ry * 2 };
    case "polygon": {
      if (!s.points.length) return null;
      const b = pointsBBox(s.points);
      return { w: b.hw * 2, h: b.hh * 2 };
    }
    default:
      return null; // line / connector / node aren't box-resizable
  }
}

/** Patch to resize a shape to width/height (px), keeping its anchor. */
export function resizeShape(s: Shape, w: number, h: number): Partial<Shape> {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  switch (s.kind) {
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image": {
      const x0 = Math.min(s.p1.x, s.p2.x);
      const y0 = Math.min(s.p1.y, s.p2.y);
      return { p1: { x: x0, y: y0 }, p2: { x: x0 + W, y: y0 + H } } as Partial<Shape>;
    }
    case "circle":
      return { r: W / 2 } as Partial<Shape>;
    case "ellipse":
      return { rx: W / 2, ry: H / 2 } as Partial<Shape>;
    case "polygon": {
      if (!s.points.length) return {};
      const b = pointsBBox(s.points);
      const x0 = b.cx - b.hw;
      const y0 = b.cy - b.hh;
      const sx = b.hw ? W / (b.hw * 2) : 1;
      const sy = b.hh ? H / (b.hh * 2) : 1;
      return { points: s.points.map((p) => ({ x: x0 + (p.x - x0) * sx, y: y0 + (p.y - y0) * sy })) } as Partial<Shape>;
    }
    default:
      return {};
  }
}

/** Resize a shape to width/height (px) centered at `center`. */
export function setBox(s: Shape, center: Point, w: number, h: number): Partial<Shape> {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  switch (s.kind) {
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return {
        p1: { x: center.x - W / 2, y: center.y - H / 2 },
        p2: { x: center.x + W / 2, y: center.y + H / 2 },
      } as Partial<Shape>;
    case "circle":
      return { center: { ...center }, r: W / 2 } as Partial<Shape>;
    case "ellipse":
      return { center: { ...center }, rx: W / 2, ry: H / 2 } as Partial<Shape>;
    case "polygon": {
      if (!s.points.length) return {};
      const b = pointsBBox(s.points);
      const sx = b.hw ? W / (b.hw * 2) : 1;
      const sy = b.hh ? H / (b.hh * 2) : 1;
      return {
        points: s.points.map((p) => ({ x: center.x + (p.x - b.cx) * sx, y: center.y + (p.y - b.cy) * sy })),
      } as Partial<Shape>;
    }
    default:
      return {};
  }
}

/** The port of `s` closest to a world point. */
export function nearestPort(s: Shape, p: Point): PortPoint {
  const ports = portsOf(s);
  let best = ports[0];
  let bestD = Infinity;
  for (const port of ports) {
    const d = (port.point.x - p.x) ** 2 + (port.point.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = port;
    }
  }
  return best;
}

/** Resolve where one connector end sits on its shape. */
export function attachPoint(s: Shape, attach: Attach, otherCenter: Point): Point {
  return attach === "auto" || attach === undefined
    ? anchorOnShape(s, otherCenter)
    : boundaryAtAngle(s, attach);
}

export function shapeCenter(s: Shape): Point {
  switch (s.kind) {
    case "line":
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return mid(s.p1, s.p2);
    case "circle":
    case "ellipse":
      return s.center;
    case "node":
      return s.at;
    case "connector":
      return mid(s.from.point, s.to.point);
    case "polygon": {
      if (!s.points.length) return { x: 0, y: 0 };
      const b = pointsBBox(s.points);
      return { x: b.cx, y: b.cy };
    }
  }
}

/** Boundary point toward `target`, accounting for the shape's rotation. */
export function anchorOnShape(s: Shape, target: Point): Point {
  const rot = rotationOf(s);
  if (!rot) return localAnchor(s, target);
  const c = shapeCenter(s);
  const local = localAnchor(s, rotatePoint(target, c, -rot));
  return rotatePoint(local, c, rot);
}

/** Boundary point toward `target` in the shape's own (unrotated) frame. */
function localAnchor(s: Shape, target: Point): Point {
  const c = shapeCenter(s);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  switch (s.kind) {
    case "circle": {
      const d = Math.hypot(dx, dy);
      return { x: c.x + (dx / d) * s.r, y: c.y + (dy / d) * s.r };
    }
    case "ellipse": {
      const denom = Math.hypot(dx / s.rx, dy / s.ry);
      if (denom === 0) return c;
      return { x: c.x + dx / denom, y: c.y + dy / denom };
    }
    case "line":
    case "connector":
      return c; // not real anchor targets
    case "diamond": {
      // Rhombus boundary: |x|/hw + |y|/hh = 1 (intersect the ray, not the bbox).
      const ext = halfExtents(s);
      if (!ext || ext.hw === 0 || ext.hh === 0) return c;
      const t = 1 / (Math.abs(dx) / ext.hw + Math.abs(dy) / ext.hh);
      return { x: c.x + dx * t, y: c.y + dy * t };
    }
    default: {
      // Box-like shapes (rect / roundrect / cylinder / node / polygon):
      // intersect the ray from the center with the bounding box.
      const ext = halfExtents(s);
      if (!ext || ext.hw === 0 || ext.hh === 0) return c;
      const scale = 1 / Math.max(Math.abs(dx) / ext.hw, Math.abs(dy) / ext.hh);
      return { x: c.x + dx * scale, y: c.y + dy * scale };
    }
  }
}

/** Resolve a connector's two endpoints to concrete canvas points. */
export function resolveConnector(
  c: ConnectorShape,
  byId: Map<string, Shape>,
): { a: Point; b: Point } {
  const fromShape = c.from.anchor ? byId.get(c.from.anchor) : undefined;
  const toShape = c.to.anchor ? byId.get(c.to.anchor) : undefined;
  const fromCenter = fromShape ? shapeCenter(fromShape) : c.from.point;
  const toCenter = toShape ? shapeCenter(toShape) : c.to.point;

  const resolve = (
    ep: ConnectorShape["from"],
    shape: Shape | undefined,
    otherCenter: Point,
  ): Point => {
    if (!shape) return ep.point;
    return attachPoint(shape, ep.attach ?? "auto", otherCenter);
  };

  return {
    a: resolve(c.from, fromShape, toCenter),
    b: resolve(c.to, toShape, fromCenter),
  };
}

/** The effective control point: the stored one when curved, else the midpoint. */
export function connectorControl(c: ConnectorShape, a: Point, b: Point): Point {
  return c.curved ? c.control : mid(a, b);
}

/** Convert a quadratic control point into the two cubic Bézier controls. */
export function quadToCubic(p0: Point, cp: Point, p1: Point): { c1: Point; c2: Point } {
  return {
    c1: { x: p0.x + (2 / 3) * (cp.x - p0.x), y: p0.y + (2 / 3) * (cp.y - p0.y) },
    c2: { x: p1.x + (2 / 3) * (cp.x - p1.x), y: p1.y + (2 / 3) * (cp.y - p1.y) },
  };
}

/** Whether a point falls inside a shape (anchor targets only). */
export function shapeContains(s: Shape, pt: Point): boolean {
  // Test in the shape's own frame so rotated shapes hit-test correctly.
  const p = rotatePoint(pt, shapeCenter(s), -rotationOf(s));
  switch (s.kind) {
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image": {
      const x1 = Math.min(s.p1.x, s.p2.x);
      const x2 = Math.max(s.p1.x, s.p2.x);
      const y1 = Math.min(s.p1.y, s.p2.y);
      const y2 = Math.max(s.p1.y, s.p2.y);
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    }
    case "circle":
      return Math.hypot(p.x - s.center.x, p.y - s.center.y) <= s.r;
    case "ellipse": {
      const nx = (p.x - s.center.x) / s.rx;
      const ny = (p.y - s.center.y) / s.ry;
      return nx * nx + ny * ny <= 1;
    }
    case "node":
      return Math.abs(p.x - s.at.x) <= NODE_HALF.w && Math.abs(p.y - s.at.y) <= NODE_HALF.h;
    case "polygon": {
      if (s.points.length < 2) return false;
      const b = pointsBBox(s.points);
      return Math.abs(p.x - b.cx) <= b.hw && Math.abs(p.y - b.cy) <= b.hh;
    }
    default:
      return false; // line / connector are not anchor targets
  }
}

/** Topmost shape under a point that can serve as a connector anchor. */
export function shapeAtPoint(shapes: Shape[], p: Point, excludeId?: string): Shape | undefined {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.id === excludeId) continue;
    if (shapeContains(s, p)) return s;
  }
  return undefined;
}
