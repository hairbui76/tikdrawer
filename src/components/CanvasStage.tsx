"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CANVAS_H,
  CANVAS_W,
  GRID,
  MAX_ZOOM,
  MIN_ZOOM,
  PX_PER_CM,
  UNIT_PER_CM,
  dist,
  snapToGrid,
} from "@/lib/coords";
import { fileToAsset } from "@/lib/images";
import { fontPxOf, labelHalfSize } from "@/lib/text";
import {
  anchorOnShape,
  angleOf,
  connectorPoints,
  nearestOnPolyline,
  nearestPort,
  portsOf,
  rotatePoint,
  rotationOf,
  setBox,
  shapeAtPoint,
  shapeCenter,
  sizeOf,
  svgPath,
  type PortPoint,
} from "@/lib/geometry";
import { useShapes, useStore } from "@/lib/store";
import {
  DEFAULT_STYLE,
  type ConnectorShape,
  type Endpoint,
  type Point,
  type PolygonShape,
  type Shape,
  type Tool,
} from "@/lib/types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/** Build a shape from two drag points for a drawing tool. */
function makeShape(tool: Tool, a: Point, b: Point): Shape | null {
  const style = { ...DEFAULT_STYLE };
  switch (tool) {
    case "line":
      return { id: "draft", kind: "line", p1: a, p2: b, style };
    case "rect":
      return { id: "draft", kind: "rect", p1: a, p2: b, style };
    case "diamond":
      return { id: "draft", kind: "diamond", p1: a, p2: b, style };
    case "roundrect":
      return { id: "draft", kind: "roundrect", p1: a, p2: b, style };
    case "cylinder":
      return { id: "draft", kind: "cylinder", p1: a, p2: b, style };
    case "circle":
      return { id: "draft", kind: "circle", center: a, r: dist(a, b), style };
    case "ellipse":
      return {
        id: "draft",
        kind: "ellipse",
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        rx: Math.abs(b.x - a.x) / 2,
        ry: Math.abs(b.y - a.y) / 2,
        style,
      };
    default:
      return null;
  }
}

function isValid(s: Shape): boolean {
  switch (s.kind) {
    case "line":
      return dist(s.p1, s.p2) > 2;
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return Math.abs(s.p2.x - s.p1.x) > 2 && Math.abs(s.p2.y - s.p1.y) > 2;
    case "circle":
      return s.r > 2;
    case "ellipse":
      return s.rx > 2 && s.ry > 2;
    case "node":
      return true;
    case "connector":
      // Need two anchored ends, or enough drag distance — avoids stray clicks
      // on a shape creating a zero-length connector.
      return (Boolean(s.from.anchor) && Boolean(s.to.anchor)) || dist(s.from.point, s.to.point) > 6;
    case "polygon":
      return s.points.length >= 2;
  }
}

function translate(s: Shape, dx: number, dy: number): Partial<Shape> {
  const mv = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  switch (s.kind) {
    case "line":
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return { p1: mv(s.p1), p2: mv(s.p2) } as Partial<Shape>;
    case "circle":
    case "ellipse":
      return { center: mv(s.center) } as Partial<Shape>;
    case "node":
      return { at: mv(s.at) } as Partial<Shape>;
    case "polygon":
      return { points: s.points.map(mv) } as Partial<Shape>;
    case "connector":
      // Free ends move; anchored ends stay attached (their point is ignored).
      return {
        from: { ...s.from, point: mv(s.from.point) },
        to: { ...s.to, point: mv(s.to.point) },
        waypoints: (s.waypoints ?? []).map(mv),
      } as Partial<Shape>;
  }
}

function bbox(s: Shape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case "line":
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image": {
      const x = Math.min(s.p1.x, s.p2.x);
      const y = Math.min(s.p1.y, s.p2.y);
      return { x, y, w: Math.abs(s.p2.x - s.p1.x), h: Math.abs(s.p2.y - s.p1.y) };
    }
    case "circle":
      return { x: s.center.x - s.r, y: s.center.y - s.r, w: s.r * 2, h: s.r * 2 };
    case "ellipse":
      return { x: s.center.x - s.rx, y: s.center.y - s.ry, w: s.rx * 2, h: s.ry * 2 };
    case "node": {
      // Follow the label's real size so the selection box hugs the text.
      const { hw, hh } = labelHalfSize(s.text, s.style);
      return { x: s.at.x - hw, y: s.at.y - hh, w: hw * 2, h: hh * 2 };
    }
    case "polygon": {
      if (!s.points.length) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "connector":
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

function ShapeView({
  shape,
  selected,
  hovered = false,
  imageHref,
}: {
  shape: Shape;
  selected: boolean;
  hovered?: boolean;
  imageHref?: string;
}) {
  const st = shape.style;
  const common = {
    stroke: st.stroke,
    strokeWidth: Math.max(0.5, st.lineWidth) * 1.5,
    // Use a transparent (not "none") fill so the interior of border-only shapes
    // is still clickable.
    fill: st.fill === "none" ? "transparent" : st.fill,
    strokeDasharray: st.dashed ? "6 4" : undefined,
    opacity: st.opacity,
    vectorEffect: "non-scaling-stroke" as const,
  };
  const markerEnd =
    shape.kind === "line" && (st.arrow === "->" || st.arrow === "<->") ? "url(#arrow)" : undefined;
  const markerStart =
    shape.kind === "line" && (st.arrow === "<-" || st.arrow === "<->") ? "url(#arrowStart)" : undefined;

  let el: React.ReactNode = null;
  switch (shape.kind) {
    case "line":
      el = (
        <line
          x1={shape.p1.x}
          y1={shape.p1.y}
          x2={shape.p2.x}
          y2={shape.p2.y}
          {...common}
          markerEnd={markerEnd}
          markerStart={markerStart}
        />
      );
      break;
    case "rect": {
      const b = bbox(shape);
      el = <rect x={b.x} y={b.y} width={b.w} height={b.h} {...common} />;
      break;
    }
    case "circle":
      el = <circle cx={shape.center.x} cy={shape.center.y} r={shape.r} {...common} />;
      break;
    case "ellipse":
      el = <ellipse cx={shape.center.x} cy={shape.center.y} rx={shape.rx} ry={shape.ry} {...common} />;
      break;
    case "roundrect": {
      const b = bbox(shape);
      el = <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} ry={8} {...common} />;
      break;
    }
    case "diamond": {
      const b = bbox(shape);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      el = <polygon points={`${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`} {...common} />;
      break;
    }
    case "cylinder": {
      const b = bbox(shape);
      const ry = Math.min(b.h * 0.2, b.w * 0.35);
      const top = b.y + ry;
      const bot = b.y + b.h - ry;
      const rx = b.w / 2;
      const cx = b.x + rx;
      const body = `M ${b.x} ${top} L ${b.x} ${bot} A ${rx} ${ry} 0 0 0 ${b.x + b.w} ${bot} L ${b.x + b.w} ${top}`;
      el = (
        <>
          <path d={body} {...common} />
          <ellipse cx={cx} cy={top} rx={rx} ry={ry} {...common} />
        </>
      );
      break;
    }
    case "polygon": {
      const pts = shape.points.map((p) => `${p.x},${p.y}`).join(" ");
      el = shape.closed ? (
        <polygon points={pts} {...common} />
      ) : (
        <polyline points={pts} {...common} />
      );
      break;
    }
    case "image": {
      const b = bbox(shape);
      el = imageHref ? (
        <image href={imageHref} x={b.x} y={b.y} width={b.w} height={b.h} opacity={st.opacity} preserveAspectRatio="none" />
      ) : (
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="#f1f5f9" stroke="#cbd5e1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      );
      break;
    }
    case "node":
      el = (
        <text
          x={shape.at.x}
          y={shape.at.y}
          fill={st.stroke}
          opacity={st.opacity}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={fontPxOf(st)}
        >
          {shape.text}
        </text>
      );
      break;
    case "connector":
      return null; // rendered by ConnectorView
  }

  // Fat invisible hit area so thin open shapes (line / polyline) are easy to grab.
  let hit: React.ReactNode = null;
  if (shape.kind === "line") {
    hit = <line x1={shape.p1.x} y1={shape.p1.y} x2={shape.p2.x} y2={shape.p2.y} stroke="transparent" strokeWidth={12} fill="none" />;
  } else if (shape.kind === "polygon" && !shape.closed) {
    hit = <polyline points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke="transparent" strokeWidth={12} fill="none" />;
  }

  // Centered text label (for non-node shapes that carry text).
  const text = shape.kind !== "node" ? shapeText(shape) : undefined;
  let labelEl: React.ReactNode = null;
  if (text) {
    const b = bbox(shape);
    labelEl = (
      <text
        x={b.x + b.w / 2}
        y={b.y + b.h / 2}
        fill={st.stroke}
        opacity={st.opacity}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontPxOf(st)}
        pointerEvents="none"
      >
        {text}
      </text>
    );
  }

  return (
    <>
      {hit}
      <g style={hovered ? { filter: "drop-shadow(0 0 2px #0ea5e9) drop-shadow(0 0 2px #0ea5e9)" } : undefined}>{el}</g>
      {labelEl}
      {selected &&
        (() => {
          const b = bbox(shape);
          return (
            <rect
              x={b.x - 4}
              y={b.y - 4}
              width={b.w + 8}
              height={b.h + 8}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          );
        })()}
    </>
  );
}

function ConnectorView({
  connector,
  byId,
  selectMode,
}: {
  connector: ConnectorShape;
  byId: Map<string, Shape>;
  selectMode: boolean;
}) {
  const st = connector.style;
  const common = {
    stroke: st.stroke,
    strokeWidth: Math.max(0.5, st.lineWidth) * 1.5,
    fill: "none",
    strokeDasharray: st.dashed ? "6 4" : undefined,
    opacity: st.opacity,
    vectorEffect: "non-scaling-stroke" as const,
  };
  const markerEnd = st.arrow === "->" || st.arrow === "<->" ? "url(#arrow)" : undefined;
  const markerStart = st.arrow === "<-" || st.arrow === "<->" ? "url(#arrowStart)" : undefined;

  const d = svgPath(connectorPoints(connector, byId), connector.curved);

  return (
    <>
      {selectMode && <path d={d} stroke="transparent" strokeWidth={14} fill="none" />}
      <path d={d} {...common} markerEnd={markerEnd} markerStart={markerStart} />
    </>
  );
}

const ROTATABLE = new Set<Shape["kind"]>(["rect", "diamond", "roundrect", "cylinder", "ellipse", "node", "polygon", "image"]);
/** Shapes that can carry a centered text label (editable inline). */
const TEXTABLE = new Set<Shape["kind"]>(["node", "rect", "diamond", "roundrect", "cylinder", "circle", "ellipse", "polygon"]);
const shapeText = (s: Shape): string | undefined => (s as { text?: string }).text;

type Drag =
  | { type: "shape"; id: string; start: Point; origs: { id: string; shape: Shape }[] }
  | { type: "waypoint"; id: string; index: number; start: Point }
  | { type: "vertex"; id: string; index: number; start: Point }
  | { type: "segment"; id: string; axis: "x" | "y"; li: number; ri: number; origWp: Point[]; start: Point }
  | { type: "endpoint"; id: string; end: "from" | "to"; start: Point }
  | { type: "rotate"; id: string; start: Point; center: Point }
  | {
      type: "resize";
      id: string;
      start: Point;
      orig: Shape;
      center: Point;
      u: Point;
      v: Point;
      ow: number;
      oh: number;
      hx: number;
      hy: number;
    }
  | { type: "marquee"; start: Point };

/** 8 resize handles: corners + edge midpoints (local-frame direction signs). */
const RESIZE_HANDLES: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
];

/** Ruler gutter size (viewBox units) along the top + left when the ruler shows. */
const RULER = 24;

export function CanvasStage() {
  const tool = useStore((s) => s.tool);
  const snap = useStore((s) => s.snap);
  const showRuler = useStore((s) => s.showRuler);
  const unit = useStore((s) => s.unit);
  const lockAspect = useStore((s) => s.lockAspect);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const zoomBy = useStore((s) => s.zoomBy);
  const selectedIds = useStore((s) => s.selectedIds);
  const addShape = useStore((s) => s.addShape);
  const updateShape = useStore((s) => s.updateShape);
  const deleteShape = useStore((s) => s.deleteShape);
  const selectShape = useStore((s) => s.selectShape);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectMany = useStore((s) => s.selectMany);
  const beginChange = useStore((s) => s.beginChange);
  const addImage = useStore((s) => s.addImage);
  const insertImageShape = useStore((s) => s.insertImageShape);
  const shapes = useShapes();
  const images = useStore((s) => s.images);

  const byId = new Map(shapes.map((s) => [s.id, s]));
  const imageHrefById = new Map(images.map((im) => [im.id, im.dataUrl]));

  const svgRef = useRef<SVGSVGElement>(null);
  // The scroll viewport and the zoom-sized wrapper the <svg> fills. Panning is
  // just scrolling this viewport, so it needs no coordinate maths of its own.
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<Point | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRecorded = useRef(false);
  // True while drawing a connector from a shape's 8 ports (snap target to ports)
  // vs the free connector tool (attach anywhere).
  const portDrag = useRef(false);
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // In-progress polygon vertices (polygon tool) + live cursor for the preview.
  const [poly, setPoly] = useState<Point[] | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  // Rubber-band selection rectangle (select tool).
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Shape currently under the cursor while connecting (for the hover highlight).
  const [hoverId, setHoverId] = useState<string | null>(null);
  // True while an image is being dragged over the canvas.
  const [dragOver, setDragOver] = useState(false);
  // Anchor-tool hover marker: where a bend/vertex would be added.
  const [anchorHover, setAnchorHover] = useState<Point | null>(null);
  // Space held = temporary pan mode (the drawing tools are suspended).
  const [spaceDown, setSpaceDown] = useState(false);

  /* ------------------------------ zoom & pan ------------------------------ */

  // Ruler gutter, in viewBox units. Declared here because the zoom helpers
  // below need the full viewBox size.
  const M = showRuler ? RULER : 0;
  const vbW = CANVAS_W + M;
  const vbH = CANVAS_H + M;
  /** Padding around the page inside the scroll viewport (CSS px). */
  const PAD = 16;

  // Handle sizes are authored in viewBox units but must stay a constant size on
  // screen, so they are divided by the zoom. (Strokes use non-scaling-stroke.)
  const hz = (n: number): number => n / zoom;

  // A pending "keep this point under the cursor" correction, applied once the
  // new zoom has been laid out.
  const zoomAnchorRef = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ cx: number; cy: number; left: number; top: number } | null>(null);
  // Mirror of `drag` for the native wheel listener (which sees stale closures).
  const dragStateRef = useRef<Drag | null>(null);
  useEffect(() => {
    dragStateRef.current = drag;
  }, [drag]);

  /** Zoom by `factor`, keeping the point under (cx, cy) visually fixed. */
  function zoomAt(factor: number, cx: number, cy: number) {
    const wrap = wrapRef.current;
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      zoomAnchorRef.current = { fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, cx, cy };
    }
    zoomBy(factor);
  }

  // Re-anchor after the browser has laid the new size out but before paint, so
  // zooming doesn't visibly jump. scrollLeft/Top clamp themselves when the page
  // is smaller than the viewport, which is exactly the centred case.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current;
    const el = scrollRef.current;
    const wrap = wrapRef.current;
    zoomAnchorRef.current = null;
    if (!a || !el || !wrap) return;
    const box = el.getBoundingClientRect();
    el.scrollLeft = wrap.offsetLeft + a.fx * wrap.offsetWidth - (a.cx - box.left);
    el.scrollTop = wrap.offsetTop + a.fy * wrap.offsetHeight - (a.cy - box.top);
  }, [zoom]);

  // Ctrl/Cmd + wheel zooms; a plain wheel scrolls (pans) natively. This must be
  // a non-passive native listener: React's synthetic wheel handler is passive,
  // so preventDefault there would not stop the browser's own page zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Scrolling (or zooming) mid-drag shifts the canvas under the pointer;
      // drag positions come from client coords via the CTM, so the dragged
      // shape would jump by the scrolled amount. A grazed wheel or trackpad
      // inertia from an earlier pan does this by accident — swallow the wheel
      // until the interaction ends.
      if (dragStateRef.current || startRef.current) {
        e.preventDefault();
        return;
      }
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Exponential so each notch is a constant *ratio*, and trackpads (which
      // send many small deltas) feel the same as a mouse wheel.
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomBy]);

  /** Scale at which the whole page fits the viewport. */
  function fitZoom(): number {
    const el = scrollRef.current;
    if (!el) return 1;
    return Math.min((el.clientWidth - 2 * PAD) / vbW, (el.clientHeight - 2 * PAD) / vbH);
  }

  // Ctrl/Cmd+9 = fit. Lives here rather than with the other shortcuts because
  // only this component knows the viewport size.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "9" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(fitZoom());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setZoom, vbW, vbH]);

  // Space toggles pan mode. Ignored while typing so it still types a space.
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault(); // otherwise space scrolls the viewport
      setSpaceDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    // Releasing space outside the window would otherwise latch pan mode on.
    const blur = () => setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /** Start a pan drag (middle button, or any button with space held). */
  function startPan(e: React.PointerEvent) {
    const el = scrollRef.current;
    if (!el) return;
    panRef.current = { cx: e.clientX, cy: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    const move = (ev: PointerEvent) => {
      const p = panRef.current;
      if (!p || !scrollRef.current) return;
      scrollRef.current.scrollLeft = p.left - (ev.clientX - p.cx);
      scrollRef.current.scrollTop = p.top - (ev.clientY - p.cy);
    };
    const end = () => {
      panRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  // Snap a point so it lines up (same x or y) with nearby neighbour points —
  // makes orthogonal/zig-zag bends align with the shape's connection ports.
  const ALIGN = 8;
  const alignSnap = (p: Point, neighbors: Point[]): Point => {
    let { x, y } = p;
    for (const n of neighbors) {
      if (Math.abs(x - n.x) <= ALIGN) x = n.x;
      if (Math.abs(y - n.y) <= ALIGN) y = n.y;
    }
    return { x, y };
  };

  // Clear connect-hover when switching to a drawing tool (kept for select/connector).
  useEffect(() => {
    if (tool !== "connector" && tool !== "select") setHoverId((cur) => (cur ? null : cur));
    if (tool !== "anchor") setAnchorHover((cur) => (cur ? null : cur));
  }, [tool]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitPoly(points: Point[]) {
    if (points.length >= 2) {
      addShape({ id: "draft", kind: "polygon", points, closed: points.length >= 3, style: { ...DEFAULT_STYLE } });
    }
    setPoly(null);
  }

  // Enter = finish polygon, Escape = cancel, while building one.
  useEffect(() => {
    if (!poly) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitPoly(poly!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setPoly(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poly]);

  // Discard an in-progress polygon if the tool changes.
  useEffect(() => {
    if (tool !== "polygon") setPoly((cur) => (cur ? null : cur));
  }, [tool]);

  function startEdit(shape: Shape) {
    if (!TEXTABLE.has(shape.kind)) return;
    beginChange();
    setEditing({ id: shape.id, original: shapeText(shape) ?? "" });
  }

  function commitEdit() {
    setEditing((cur) => {
      if (cur) {
        const node = shapes.find((s) => s.id === cur.id);
        if (node && node.kind === "node" && node.text.trim() === "") deleteShape(cur.id);
      }
      return null;
    });
  }

  // Convert screen coords to canvas (viewBox) coords via the SVG CTM, so it
  // works regardless of the viewBox / ruler margin.
  function clientToCanvas(clientX: number, clientY: number): Point {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const sp = svg.createSVGPoint();
      sp.x = clientX;
      sp.y = clientY;
      const loc = sp.matrixTransform(ctm.inverse());
      return { x: loc.x, y: loc.y };
    }
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((clientY - rect.top) / rect.height) * CANVAS_H,
    };
  }

  const clampPt = (p: Point): Point => ({
    x: Math.max(0, Math.min(CANVAS_W, p.x)),
    y: Math.max(0, Math.min(CANVAS_H, p.y)),
  });

  function getPoint(e: React.PointerEvent): Point {
    let { x, y } = clientToCanvas(e.clientX, e.clientY);
    if (snap) {
      x = snapToGrid(x);
      y = snapToGrid(y);
    }
    return clampPt({ x, y });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const at = clampPt(clientToCanvas(e.clientX, e.clientY));
    // 1) Image files dropped from the OS.
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      let offset = 0;
      for (const file of files) {
        try {
          const asset = await fileToAsset(file);
          addImage(asset);
          insertImageShape(asset, { x: at.x + offset, y: at.y + offset });
          offset += 16;
        } catch {
          /* skip */
        }
      }
      return;
    }
    // 2) A library image dragged onto the canvas.
    const imgId = e.dataTransfer.getData("application/x-tikdrawer-image");
    if (imgId) {
      const asset = images.find((im) => im.id === imgId);
      if (asset) insertImageShape(asset, at);
    }
  }

  // The shape to connect to at point `p`: the one under the cursor, or the
  // nearest one within a small margin (so you don't have to hit it exactly).
  function connectTarget(p: Point, excludeId?: string): Shape | undefined {
    const inside = shapeAtPoint(shapes, p, excludeId);
    if (inside) return inside;
    const MARGIN = hz(16);
    let best: Shape | undefined;
    let bestD = MARGIN;
    for (const s of shapes) {
      if (s.id === excludeId || s.kind === "line" || s.kind === "connector") continue;
      const d = dist(p, anchorOnShape(s, p));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /**
   * Endpoint at a point: attach to a shape (the boundary point in the direction
   * of the cursor — i.e. ANY position) or float free.
   */
  function endpointAt(p: Point, excludeId?: string): Endpoint {
    const target = connectTarget(p, excludeId);
    return target
      ? { point: p, anchor: target.id, attach: angleOf(target, p) }
      : { point: p, anchor: null, attach: "auto" };
  }

  /** Like endpointAt but snaps the attachment to the target's nearest port. */
  function endpointAtPort(p: Point, excludeId?: string): Endpoint {
    const target = connectTarget(p, excludeId);
    if (!target) return { point: p, anchor: null, attach: "auto" };
    const port = nearestPort(target, p);
    return { point: port.point, anchor: target.id, attach: port.attach };
  }

  function recordOnce() {
    if (!dragRecorded.current) {
      beginChange();
      dragRecorded.current = true;
    }
  }

  function onBackgroundDown(e: React.PointerEvent) {
    if (tool === "select") {
      const p = getPoint(e);
      if (!e.shiftKey) selectShape(null);
      setDrag({ type: "marquee", start: p });
      setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    // Anchor tool: click a connector to add a bend, or a polygon to add a vertex.
    if (tool === "anchor") {
      const raw = clientToCanvas(e.clientX, e.clientY);
      const conn = connectorHitTest(raw);
      if (conn) {
        selectShape(conn.conn.id);
        addWaypoint(e, conn.conn, conn.seg, conn.point);
        return;
      }
      const poly = polygonHitTest(raw);
      if (poly) {
        selectShape(poly.poly.id);
        addPolygonVertex(e, poly.poly, poly.seg, poly.point);
      }
      return;
    }
    const p = getPoint(e);

    if (tool === "node") {
      // Place an empty node and edit it inline straight away.
      const id = uid();
      addShape({ id, kind: "node", at: p, text: "", style: { ...DEFAULT_STYLE } });
      setEditing({ id, original: "" });
      return;
    }

    if (tool === "polygon") {
      if (!poly) {
        setPoly([p]);
        return;
      }
      // Click near the first vertex closes the polygon.
      if (poly.length >= 3 && dist(p, poly[0]) < hz(10)) {
        commitPoly(poly);
        return;
      }
      // Ignore a click that lands on the previous vertex (e.g. double-click).
      if (dist(p, poly[poly.length - 1]) < hz(6)) return;
      setPoly([...poly, p]);
      return;
    }

    if (tool === "connector") {
      portDrag.current = false;
      const from = endpointAt(p);
      startRef.current = p;
      setDraft({
        id: "draft",
        kind: "connector",
        from,
        to: { point: p, anchor: null, attach: "auto" },
        waypoints: [],
        curved: false,
        style: { ...DEFAULT_STYLE, arrow: "->" },
      });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    startRef.current = p;
    setDraft(makeShape(tool, p, p));
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onShapeDown(e: React.PointerEvent, shape: Shape) {
    if (tool !== "select") return;
    e.stopPropagation();
    // Shift + drag a connector = move the whole segment under the cursor.
    if (shape.kind === "connector" && e.shiftKey) {
      selectShape(shape.id);
      const seg = nearestOnPolyline(connectorPoints(shape, byId), clientToCanvas(e.clientX, e.clientY)).seg;
      onSegmentDown(e, shape, seg);
      return;
    }
    if (e.shiftKey) {
      toggleSelect(shape.id);
      return;
    }
    // Click outside the current selection selects just this shape.
    let ids = selectedIds;
    if (!selectedIds.includes(shape.id)) {
      selectShape(shape.id);
      ids = [shape.id];
    }
    const origs = shapes.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, shape: s }));
    setDrag({ type: "shape", id: shape.id, start: getPoint(e), origs });
    dragRecorded.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onHandleDown(e: React.PointerEvent, d: Drag) {
    e.stopPropagation();
    setDrag(d);
    dragRecorded.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  // Insert a bend point into segment `seg` (at `pos`) and start dragging it.
  function addWaypoint(e: React.PointerEvent, conn: ConnectorShape, seg: number, pos: Point) {
    e.stopPropagation();
    beginChange();
    const panchors = connectorPoints(conn, byId);
    const snapped = alignSnap(pos, [panchors[seg], panchors[seg + 1]].filter(Boolean));
    const wp = [...(conn.waypoints ?? [])];
    wp.splice(seg, 0, snapped);
    updateShape(conn.id, { waypoints: wp });
    setDrag({ type: "waypoint", id: conn.id, index: seg, start: pos });
    dragRecorded.current = true; // already recorded by beginChange
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function removeWaypoint(conn: ConnectorShape, index: number) {
    beginChange();
    updateShape(conn.id, { waypoints: (conn.waypoints ?? []).filter((_, i) => i !== index) });
  }

  // Closest connector to a world point (within 10 screen px), with segment + point.
  function connectorHitTest(p: Point): { conn: ConnectorShape; seg: number; point: Point } | null {
    let best: { conn: ConnectorShape; seg: number; point: Point } | null = null;
    let bestD = hz(10);
    for (const s of shapes) {
      if (s.kind !== "connector") continue;
      const near = nearestOnPolyline(connectorPoints(s, byId), p);
      if (near.dist < bestD) {
        bestD = near.dist;
        best = { conn: s, seg: near.seg, point: near.point };
      }
    }
    return best;
  }

  // Polygon vertices in LOCAL (unrotated) coords; a closed polygon repeats p0.
  function polygonRing(poly: PolygonShape): Point[] {
    return poly.closed && poly.points.length ? [...poly.points, poly.points[0]] : poly.points;
  }

  // Closest polygon edge to a world point (within 10 screen px), with edge index + world point.
  function polygonHitTest(p: Point): { poly: PolygonShape; seg: number; point: Point } | null {
    let best: { poly: PolygonShape; seg: number; point: Point } | null = null;
    let bestD = hz(10);
    for (const s of shapes) {
      if (s.kind !== "polygon" || s.points.length < 2) continue;
      const center = shapeCenter(s);
      const rot = rotationOf(s);
      const near = nearestOnPolyline(polygonRing(s), rotatePoint(p, center, -rot));
      if (near.dist < bestD) {
        bestD = near.dist;
        best = { poly: s, seg: near.seg, point: rotatePoint(near.point, center, rot) };
      }
    }
    return best;
  }

  // Insert a vertex into a polygon edge (at world `pos`) and start dragging it.
  function addPolygonVertex(e: React.PointerEvent, poly: PolygonShape, seg: number, pos: Point) {
    e.stopPropagation();
    beginChange();
    const lp = rotatePoint(pos, shapeCenter(poly), -rotationOf(poly));
    const pts = [...poly.points];
    pts.splice(seg + 1, 0, lp);
    updateShape(poly.id, { points: pts });
    setDrag({ type: "vertex", id: poly.id, index: seg + 1, start: pos });
    dragRecorded.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function removePolygonVertex(poly: PolygonShape, index: number) {
    if (poly.points.length <= 2) return;
    beginChange();
    updateShape(poly.id, { points: poly.points.filter((_, i) => i !== index) });
  }

  // Grab a whole segment and translate it perpendicular (draw.io style). Stubs
  // are inserted at port ends so the shapes stay connected while it moves.
  function onSegmentDown(e: React.PointerEvent, conn: ConnectorShape, s: number) {
    e.stopPropagation();
    const full = connectorPoints(conn, byId);
    const a = full[0];
    const b = full[full.length - 1];
    const wp = [...(conn.waypoints ?? [])];
    const k = wp.length;
    const axis: "x" | "y" = Math.abs(full[s + 1].y - full[s].y) < Math.abs(full[s + 1].x - full[s].x) ? "y" : "x";
    let newWp: Point[];
    let li: number;
    let ri: number;
    if (s >= 1 && s <= k - 1) {
      newWp = wp;
      li = s - 1;
      ri = s;
    } else if (s === 0 && s === k) {
      newWp = [{ ...a }, { ...b }];
      li = 0;
      ri = 1;
    } else if (s === 0) {
      newWp = [{ ...a }, ...wp];
      li = 0;
      ri = 1;
    } else {
      newWp = [...wp, { ...b }];
      li = k - 1;
      ri = k;
    }
    beginChange();
    updateShape(conn.id, { waypoints: newWp });
    setDrag({ type: "segment", id: conn.id, axis, li, ri, origWp: newWp, start: clampPt(clientToCanvas(e.clientX, e.clientY)) });
    dragRecorded.current = true;
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onResizeDown(e: React.PointerEvent, shape: Shape, hx: number, hy: number) {
    e.stopPropagation();
    const size = sizeOf(shape);
    if (!size) return;
    const center = shapeCenter(shape);
    const r = (rotationOf(shape) * Math.PI) / 180;
    setDrag({
      type: "resize",
      id: shape.id,
      start: getPoint(e),
      orig: shape,
      center,
      u: { x: Math.cos(r), y: Math.sin(r) },
      v: { x: -Math.sin(r), y: Math.cos(r) },
      ow: size.w,
      oh: size.h,
      hx,
      hy,
    });
    dragRecorded.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  // Start a connector from one of a shape's ports (drag onto another shape).
  function onPortDown(e: React.PointerEvent, shape: Shape, port: PortPoint) {
    e.stopPropagation();
    portDrag.current = true;
    startRef.current = port.point;
    setDraft({
      id: "draft",
      kind: "connector",
      from: { point: port.point, anchor: shape.id, attach: port.attach },
      to: { point: port.point, anchor: null, attach: "auto" },
      waypoints: [],
      curved: false,
      style: { ...DEFAULT_STYLE, arrow: "->" },
    });
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    if (panRef.current) return; // panning: no hover tracking or drafting
    if (poly) {
      setCursor(getPoint(e));
      return;
    }
    // Idle hover (select or connector tool): track the shape under the cursor
    // so its connection ports / highlight can show.
    if ((tool === "select" || tool === "connector") && !drag && !startRef.current) {
      setHoverId(connectTarget(getPoint(e))?.id ?? null);
      return;
    }
    // Anchor tool: preview where a bend/vertex would be added.
    if (tool === "anchor" && !drag) {
      const raw = clientToCanvas(e.clientX, e.clientY);
      const hit = connectorHitTest(raw) ?? polygonHitTest(raw);
      setAnchorHover(hit ? hit.point : null);
      return;
    }
    if (drag) {
      // Segment drag: translate the whole segment perpendicular (draw.io style).
      if (drag.type === "segment") {
        recordOnce();
        const cur = clampPt(clientToCanvas(e.clientX, e.clientY));
        const dx = cur.x - drag.start.x;
        const dy = cur.y - drag.start.y;
        const wp = drag.origWp.map((p, idx) =>
          idx === drag.li || idx === drag.ri
            ? drag.axis === "y"
              ? { x: p.x, y: p.y + dy }
              : { x: p.x + dx, y: p.y }
            : p,
        );
        updateShape(drag.id, { waypoints: wp });
        return;
      }
      // Polygon vertex drag (local frame + align to neighbour vertices).
      if (drag.type === "vertex") {
        recordOnce();
        const c = shapes.find((s) => s.id === drag.id);
        if (c && c.kind === "polygon") {
          const center = shapeCenter(c);
          const rot = rotationOf(c);
          const local = rotatePoint(clampPt(clientToCanvas(e.clientX, e.clientY)), center, -rot);
          const neighbors = [c.points[drag.index - 1], c.points[drag.index + 1]].filter(Boolean) as Point[];
          const pts = [...c.points];
          pts[drag.index] = alignSnap(local, neighbors);
          updateShape(drag.id, { points: pts });
        }
        return;
      }
      // Waypoint drag: align to neighbours (no grid snap) for clean zig-zags.
      if (drag.type === "waypoint") {
        recordOnce();
        const c = shapes.find((s) => s.id === drag.id);
        if (c && c.kind === "connector") {
          const pts = connectorPoints(c, byId);
          const fi = drag.index + 1;
          const neighbors = [pts[fi - 1], pts[fi + 1]].filter(Boolean) as Point[];
          const snapped = alignSnap(clampPt(clientToCanvas(e.clientX, e.clientY)), neighbors);
          const wp = [...(c.waypoints ?? [])];
          wp[drag.index] = snapped;
          updateShape(drag.id, { waypoints: wp });
        }
        return;
      }
      const p = getPoint(e);
      if (drag.type === "marquee") {
        setMarquee({
          x: Math.min(p.x, drag.start.x),
          y: Math.min(p.y, drag.start.y),
          w: Math.abs(p.x - drag.start.x),
          h: Math.abs(p.y - drag.start.y),
        });
        return;
      }
      const moved = p.x !== drag.start.x || p.y !== drag.start.y;
      if (!moved) return;
      recordOnce();
      switch (drag.type) {
        case "shape": {
          const dx = p.x - drag.start.x;
          const dy = p.y - drag.start.y;
          for (const o of drag.origs) updateShape(o.id, translate(o.shape, dx, dy));
          break;
        }
        case "rotate": {
          let deg = (Math.atan2(p.y - drag.center.y, p.x - drag.center.x) * 180) / Math.PI + 90;
          if (snap) deg = Math.round(deg / 15) * 15; // snap to 15° steps
          updateShape(drag.id, { rotation: ((deg % 360) + 360) % 360 });
          break;
        }
        case "resize": {
          const { center, u, v, ow, oh, hx, hy } = drag;
          // Fixed corner/edge (opposite the dragged handle) in world space.
          const fx = center.x + u.x * (-hx * ow) / 2 + v.x * (-hy * oh) / 2;
          const fy = center.y + u.y * (-hx * ow) / 2 + v.y * (-hy * oh) / 2;
          const rx = p.x - fx;
          const ry = p.y - fy;
          const du = rx * u.x + ry * u.y; // projection onto local x axis
          const dv = rx * v.x + ry * v.y; // onto local y axis
          let nw = hx ? Math.max(4, Math.abs(du)) : ow;
          let nh = hy ? Math.max(4, Math.abs(dv)) : oh;
          if (lockAspect) {
            if (hx) nh = (nw * oh) / ow;
            else if (hy) nw = (nh * ow) / oh;
          }
          const cx = fx + (u.x * hx * nw) / 2 + (v.x * hy * nh) / 2;
          const cy = fy + (u.y * hx * nw) / 2 + (v.y * hy * nh) / 2;
          updateShape(drag.id, setBox(drag.orig, { x: cx, y: cy }, nw, nh));
          break;
        }
        case "endpoint": {
          const ep = endpointAt(p, drag.id);
          updateShape(drag.id, drag.end === "from" ? { from: ep } : { to: ep });
          break;
        }
      }
      return;
    }

    if (!startRef.current || !draft) return;
    const p = getPoint(e);
    if (draft.kind === "connector") {
      const ep = portDrag.current
        ? endpointAtPort(p, draft.from.anchor ?? undefined)
        : endpointAt(p, draft.from.anchor ?? undefined);
      setDraft({ ...draft, to: ep });
      setHoverId(ep.anchor);
    } else {
      setDraft(makeShape(tool, startRef.current, p));
    }
  }

  function onUp() {
    if (drag) {
      if (drag.type === "marquee") {
        if (marquee && (marquee.w > 3 || marquee.h > 3)) {
          const r = marquee;
          const hit = (s: Shape): boolean => {
            let b = bbox(s);
            if (s.kind === "connector") {
              const pts = connectorPoints(s, byId);
              const xs = pts.map((p) => p.x);
              const ys = pts.map((p) => p.y);
              b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
            }
            return !(r.x > b.x + b.w || r.x + r.w < b.x || r.y > b.y + b.h || r.y + r.h < b.y);
          };
          selectMany(shapes.filter(hit).map((s) => s.id));
        }
        setMarquee(null);
      }
      setDrag(null);
      return;
    }
    if (startRef.current && draft && isValid(draft)) {
      const c = draft;
      const selfLoop = c.kind === "connector" && c.from.anchor && c.from.anchor === c.to.anchor;
      if (!selfLoop) addShape(draft);
    }
    startRef.current = null;
    setDraft(null);
    setHoverId(null);
  }

  const gridLines: React.ReactNode[] = [];
  for (let x = 0; x <= CANVAS_W; x += GRID) {
    gridLines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={CANVAS_H} stroke="#eef2f7" strokeWidth={x % (GRID * 2) === 0 ? 1 : 0.5} />);
  }
  for (let y = 0; y <= CANVAS_H; y += GRID) {
    gridLines.push(<line key={`h${y}`} x1={0} y1={y} x2={CANVAS_W} y2={y} stroke="#eef2f7" strokeWidth={y % (GRID * 2) === 0 ? 1 : 0.5} />);
  }

  // Coordinate ruler (cm) along the top (x) and left (y, TikZ-up) edges.
  const ruler: React.ReactNode[] = [];
  if (showRuler) {
    const label = (cm: number) => `${Math.round(cm * UNIT_PER_CM[unit])}`;
    for (let c = 0; c * PX_PER_CM <= CANVAS_W; c++) {
      const x = c * PX_PER_CM;
      ruler.push(<line key={`rx${c}`} x1={x} y1={-5} x2={x} y2={0} stroke="#94a3b8" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />);
      ruler.push(<text key={`rxt${c}`} x={x} y={-8} fontSize={9} fill="#64748b" textAnchor="middle">{label(c)}</text>);
    }
    for (let c = 0; c * PX_PER_CM <= CANVAS_H; c++) {
      const y = CANVAS_H - c * PX_PER_CM;
      ruler.push(<line key={`ry${c}`} x1={-5} y1={y} x2={0} y2={y} stroke="#94a3b8" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />);
      ruler.push(<text key={`ryt${c}`} x={-7} y={y + 3} fontSize={9} fill="#64748b" textAnchor="end">{label(c)}</text>);
    }
    ruler.push(<text key="runit" x={-7} y={-8} fontSize={8} fill="#94a3b8" textAnchor="end">{unit}</text>);
  }

  const selected = selectedIds.length === 1 ? shapes.find((s) => s.id === selectedIds[0]) : undefined;
  const selectedConnector = selected?.kind === "connector" && tool === "select" ? selected : null;
  // Connection ports show on HOVER (select tool) — like draw.io — so selection
  // can stay focused on resize/rotate. Hidden while dragging or drafting.
  const hoveredShape = hoverId ? shapes.find((s) => s.id === hoverId) : undefined;
  // Ports show on hover only when nothing is selected — once a shape is
  // selected we're in transform mode (resize/rotate handles only).
  const portShape =
    hoveredShape &&
    tool === "select" &&
    selectedIds.length === 0 &&
    hoveredShape.kind !== "connector" &&
    hoveredShape.kind !== "line" &&
    !draft &&
    !drag
      ? hoveredShape
      : null;
  const rotShape = selected && tool === "select" && ROTATABLE.has(selected.kind) && !draft ? selected : null;
  // Polygons are edited via vertex handles (custom shape), not bbox resize.
  const resizeSel =
    selected && tool === "select" && !draft && selected.kind !== "polygon" && sizeOf(selected) ? selected : null;
  const polyVertexShape =
    selected && tool === "select" && selected.kind === "polygon" && !draft ? selected : null;

  return (
    <div className="relative h-full w-full">
      <div
        ref={scrollRef}
        className={`flex h-full w-full select-none overflow-auto ${dragOver ? "bg-blue-100" : "bg-slate-100"}`}
        style={{ padding: PAD }}
        // Capture phase, so a pan takes precedence over the drawing/selection
        // handlers on the <svg> and on individual shapes. Never while another
        // drag is live: scrolling would shift the canvas under that drag.
        onPointerDownCapture={(e) => {
          if ((e.button !== 1 && !spaceDown) || drag || startRef.current) return;
          e.stopPropagation();
          startPan(e);
        }}
        // Blocks the middle-click autoscroll widget (preventing the pointer event
        // is not enough for it).
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        {/* Auto margins centre the page while it is smaller than the viewport,
            and collapse to 0 once it overflows — unlike justify/align centring,
            which would put the overflow out of scroll reach. */}
        <div ref={wrapRef} className="m-auto shrink-0" style={{ width: vbW * zoom, height: vbH * zoom }}>
          <svg
            ref={svgRef}
            viewBox={`${-M} ${-M} ${vbW} ${vbH}`}
            className="block h-full w-full select-none rounded border border-slate-300 shadow-sm"
            style={{ cursor: spaceDown ? (panRef.current ? "grabbing" : "grab") : tool === "select" ? "default" : "crosshair", touchAction: "none", WebkitUserSelect: "none", userSelect: "none" }}
            onPointerDown={onBackgroundDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            // A cancelled pointer (browser gesture takeover) would otherwise
            // leave `drag` latched, and the shape would follow the bare cursor.
            onPointerCancel={onUp}
            onDoubleClick={(e) => {
              if (poly) {
                commitPoly(poly);
                return;
              }
              // Pointer capture (from the click that selects) redirects dblclick to
              // the <svg>, so resolve the target by hit-testing here.
              if (tool !== "select") return;
              const target = shapeAtPoint(shapes, clientToCanvas(e.clientX, e.clientY));
              if (target && TEXTABLE.has(target.kind)) startEdit(target);
            }}
          >
            <rect x={-M} y={-M} width={CANVAS_W + M} height={CANVAS_H + M} fill="#f8fafc" />
            <rect x={0} y={0} width={CANVAS_W} height={CANVAS_H} fill="#ffffff" />

            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
              <marker id="arrowStart" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 10 0 L 0 5 L 10 10 z" fill="context-stroke" />
              </marker>
            </defs>

            <g>{gridLines}</g>
            {showRuler && <g pointerEvents="none">{ruler}</g>}

            {shapes.map((s) => {
              const rot = rotationOf(s);
              let transform: string | undefined;
              if (rot) {
                const c = shapeCenter(s);
                transform = `rotate(${rot} ${c.x} ${c.y})`;
              }
              return (
                <g
                  key={s.id}
                  transform={transform}
                  onPointerDown={(e) => onShapeDown(e, s)}
                  style={{ pointerEvents: tool === "select" ? "auto" : "none", cursor: tool === "select" ? "move" : "inherit" }}
                >
                  {s.kind === "connector" ? (
                    <ConnectorView connector={s} byId={byId} selectMode={tool === "select"} />
                  ) : (
                    <ShapeView
                      shape={s}
                      selected={selectedIds.includes(s.id)}
                      hovered={tool === "connector" && hoverId === s.id}
                      imageHref={s.kind === "image" ? imageHrefById.get(s.imageId) : undefined}
                    />
                  )}
                </g>
              );
            })}

            {editing &&
              (() => {
                const shape = shapes.find((s) => s.id === editing.id);
                if (!shape || !TEXTABLE.has(shape.kind)) return null;
                const c = shapeCenter(shape);
                const w = 160;
                const h = 30;
                return (
                  <foreignObject
                    x={c.x - w / 2}
                    y={c.y - h / 2}
                    width={w}
                    height={h}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <input
                      ref={inputRef}
                      value={shapeText(shape) ?? ""}
                      onChange={(e) => updateShape(shape.id, { text: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          updateShape(shape.id, { text: editing.original });
                          setEditing(null);
                        }
                      }}
                      style={{
                        width: "100%",
                        height: "100%",
                        textAlign: "center",
                        border: "1.5px solid #0ea5e9",
                        borderRadius: 4,
                        font: "16px sans-serif",
                        outline: "none",
                        background: "white",
                        boxSizing: "border-box",
                        userSelect: "text",
                        WebkitUserSelect: "text",
                      }}
                    />
                  </foreignObject>
                );
              })()}

            {draft &&
              (draft.kind === "connector" ? (
                <ConnectorView connector={draft} byId={byId} selectMode={false} />
              ) : (
                <ShapeView shape={draft} selected={false} />
              ))}

            {marquee && (marquee.w > 0 || marquee.h > 0) && (
              <rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                fill="rgba(14,165,233,0.10)"
                stroke="#0ea5e9"
                strokeWidth={1}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}

            {poly && (
              <g pointerEvents="none">
                <polyline
                  points={[...poly, ...(cursor ? [cursor] : [])].map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#0ea5e9"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
                {poly.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={hz(i === 0 ? 5 : 3)}
                    fill={i === 0 ? "#0ea5e9" : "#fff"}
                    stroke="#0ea5e9"
                    strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            )}

            {selectedConnector &&
              (() => {
                const pts = connectorPoints(selectedConnector, byId);
                const wp = selectedConnector.waypoints ?? [];
                const a = pts[0];
                const b = pts[pts.length - 1];
                return (
                  <g>
                    {/* bend points: white squares — drag to move this point freely,
                        double-click to remove. (Distinct from the blue segment dots.) */}
                    {wp.map((w, i) => (
                      <rect
                        key={`wp${i}`}
                        x={w.x - hz(5)}
                        y={w.y - hz(5)}
                        width={hz(10)}
                        height={hz(10)}
                        rx={hz(1.5)}
                        fill="#fff"
                        stroke="#0ea5e9"
                        strokeWidth={1.75}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "move" }}
                        onPointerDown={(e) => onHandleDown(e, { type: "waypoint", id: selectedConnector.id, index: i, start: getPoint(e) })}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          removeWaypoint(selectedConnector, i);
                        }}
                      />
                    ))}
                    {/* endpoints */}
                    <circle cx={a.x} cy={a.y} r={hz(5)} fill="#fff" stroke="#0ea5e9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} onPointerDown={(e) => onHandleDown(e, { type: "endpoint", id: selectedConnector.id, end: "from", start: getPoint(e) })} />
                    <circle cx={b.x} cy={b.y} r={hz(5)} fill="#fff" stroke="#0ea5e9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ cursor: "move" }} onPointerDown={(e) => onHandleDown(e, { type: "endpoint", id: selectedConnector.id, end: "to", start: getPoint(e) })} />
                  </g>
                );
              })()}

            {portShape && (
              <g>
                {portsOf(portShape).map((port, i) => (
                  <circle
                    key={i}
                    cx={port.point.x}
                    cy={port.point.y}
                    r={hz(3.5)}
                    fill="#fff"
                    stroke="#0ea5e9"
                    strokeWidth={1.25}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: "crosshair" }}
                    onPointerDown={(e) => onPortDown(e, portShape, port)}
                  />
                ))}
              </g>
            )}

            {rotShape &&
              (() => {
                const c = shapeCenter(rotShape);
                const rot = rotationOf(rotShape);
                const b = bbox(rotShape);
                const topMid = rotatePoint({ x: c.x, y: b.y }, c, rot);
                const handle = rotatePoint({ x: c.x, y: b.y - hz(22) }, c, rot);
                return (
                  <g>
                    <line x1={topMid.x} y1={topMid.y} x2={handle.x} y2={handle.y} stroke="#0ea5e9" strokeWidth={0.75} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                    <circle
                      cx={handle.x}
                      cy={handle.y}
                      r={hz(5)}
                      fill="#0ea5e9"
                      stroke="#fff"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => onHandleDown(e, { type: "rotate", id: rotShape.id, start: getPoint(e), center: c })}
                    />
                  </g>
                );
              })()}

            {resizeSel &&
              (() => {
                const size = sizeOf(resizeSel)!;
                const c = shapeCenter(resizeSel);
                const rot = rotationOf(resizeSel);
                const hw = size.w / 2;
                const hh = size.h / 2;
                return (
                  <g>
                    {RESIZE_HANDLES.map(([hx, hy]) => {
                      const wp = rotatePoint({ x: c.x + hx * hw, y: c.y + hy * hh }, c, rot);
                      const cursor = hx && hy ? (hx === hy ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize";
                      return (
                        <rect
                          key={`${hx}_${hy}`}
                          x={wp.x - hz(4)}
                          y={wp.y - hz(4)}
                          width={hz(8)}
                          height={hz(8)}
                          fill="#fff"
                          stroke="#0ea5e9"
                          strokeWidth={1.25}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor }}
                          onPointerDown={(e) => onResizeDown(e, resizeSel, hx, hy)}
                        />
                      );
                    })}
                  </g>
                );
              })()}

            {polyVertexShape &&
              (() => {
                const c = shapeCenter(polyVertexShape);
                const rot = rotationOf(polyVertexShape);
                return (
                  <g>
                    {polyVertexShape.points.map((pt, i) => {
                      const w = rotatePoint(pt, c, rot);
                      return (
                        <rect
                          key={`pv${i}`}
                          x={w.x - hz(5)}
                          y={w.y - hz(5)}
                          width={hz(10)}
                          height={hz(10)}
                          rx={hz(1.5)}
                          fill="#fff"
                          stroke="#0ea5e9"
                          strokeWidth={1.75}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: "move" }}
                          onPointerDown={(e) => onHandleDown(e, { type: "vertex", id: polyVertexShape.id, index: i, start: getPoint(e) })}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            removePolygonVertex(polyVertexShape, i);
                          }}
                        />
                      );
                    })}
                  </g>
                );
              })()}

            {tool === "anchor" && anchorHover && (
              <g pointerEvents="none">
                <circle cx={anchorHover.x} cy={anchorHover.y} r={hz(7)} fill="#fff" stroke="#0ea5e9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <line x1={anchorHover.x - hz(3.5)} y1={anchorHover.y} x2={anchorHover.x + hz(3.5)} y2={anchorHover.y} stroke="#0ea5e9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <line x1={anchorHover.x} y1={anchorHover.y - hz(3.5)} x2={anchorHover.x} y2={anchorHover.y + hz(3.5)} stroke="#0ea5e9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </g>
            )}
          </svg>
        </div>
      </div>

      <ZoomBar
        zoom={zoom}
        onZoom={(factor) => {
          // Button/keyboard zoom anchors on the viewport centre, which is what
          // the eye is on — unlike the wheel, which anchors on the cursor.
          const el = scrollRef.current;
          if (!el) return zoomBy(factor);
          const b = el.getBoundingClientRect();
          zoomAt(factor, b.left + b.width / 2, b.top + b.height / 2);
        }}
        onFit={() => setZoom(fitZoom())}
        onReset={() => setZoom(1)}
      />
    </div>
  );
}

/** Floating zoom control (bottom-right of the canvas area). */
function ZoomBar({
  zoom,
  onZoom,
  onFit,
  onReset,
}: {
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  onReset: () => void;
}) {
  const btn =
    "flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-slate-300 bg-white/95 p-1 shadow-sm backdrop-blur">
      <button className={btn} onClick={() => onZoom(1 / 1.25)} disabled={zoom <= MIN_ZOOM} title="Zoom out (Ctrl -)" aria-label="Zoom out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        className="min-w-[3.25rem] rounded px-1 py-1 text-xs font-medium tabular-nums text-slate-700 transition hover:bg-slate-100"
        onClick={onReset}
        title="Reset to 100% (Ctrl 0)"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className={btn} onClick={() => onZoom(1.25)} disabled={zoom >= MAX_ZOOM} title="Zoom in (Ctrl +)" aria-label="Zoom in">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <div className="mx-0.5 h-4 w-px bg-slate-200" />
      <button
        className="rounded px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
        onClick={onFit}
        title="Fit the page in the window (Ctrl 9)"
      >
        Fit
      </button>
    </div>
  );
}
