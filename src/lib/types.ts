export type Tool =
  | "select"
  | "anchor"
  | "line"
  | "rect"
  | "circle"
  | "ellipse"
  | "node"
  | "connector"
  | "diamond"
  | "roundrect"
  | "cylinder"
  | "polygon";

export type Point = { x: number; y: number };

export type ArrowStyle = "none" | "->" | "<-" | "<->";

export type Style = {
  /** stroke / draw color, hex like "#1d4ed8" */
  stroke: string;
  /** fill color hex, or "none" */
  fill: string;
  /** line width in pt */
  lineWidth: number;
  dashed: boolean;
  /** arrow tips (only meaningful for line) */
  arrow: ArrowStyle;
  /** 0..1 */
  opacity: number;
  /**
   * Label text size in pt (same unit as `lineWidth`, since both become TikZ
   * dimensions). Optional: drawings saved before this existed have no value and
   * fall back to `DEFAULT_FONT_PT` — see `fontPtOf` in `text.ts`.
   */
  fontSize?: number;
};

export type LineShape = { id: string; kind: "line"; p1: Point; p2: Point; style: Style };
export type RectShape = { id: string; kind: "rect"; p1: Point; p2: Point; style: Style; rotation?: number; text?: string };
/** Box-defined preset shapes (bounding box p1..p2), like rect. */
export type DiamondShape = { id: string; kind: "diamond"; p1: Point; p2: Point; style: Style; rotation?: number; text?: string };
export type RoundRectShape = { id: string; kind: "roundrect"; p1: Point; p2: Point; style: Style; rotation?: number; text?: string };
export type CylinderShape = { id: string; kind: "cylinder"; p1: Point; p2: Point; style: Style; rotation?: number; text?: string };
/** Polyline / polygon defined by a list of vertices. */
export type PolygonShape = {
  id: string;
  kind: "polygon";
  points: Point[];
  closed: boolean;
  /**
   * Render as a smooth curve through gentle vertices (sharp corners stay
   * exact) — set by the raster tracer so curves need far fewer points. Both
   * the canvas and the TikZ output honour it; absent = straight segments.
   */
  rounded?: boolean;
  style: Style;
  rotation?: number;
  text?: string;
};
export type CircleShape = { id: string; kind: "circle"; center: Point; r: number; style: Style; text?: string };
export type EllipseShape = { id: string; kind: "ellipse"; center: Point; rx: number; ry: number; style: Style; rotation?: number; text?: string };
export type NodeShape = { id: string; kind: "node"; at: Point; text: string; style: Style; rotation?: number };
/** An image placed on the canvas (box-defined), referencing a library asset. */
export type ImageShape = { id: string; kind: "image"; imageId: string; p1: Point; p2: Point; style: Style; rotation?: number };

/** An uploaded image kept in the image library (managed separately from shapes). */
export type ImageAsset = { id: string; name: string; dataUrl: string; ext: string; w: number; h: number };

/** The 8 common connection ports (named sides) shown as drag handles. */
export type Side = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const SIDES_8: Side[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/**
 * How a connector end attaches to its shape:
 * - `"auto"`: boundary point facing the other end (moves with the layout).
 * - a number: a fixed angle (radians, screen coords, 0 = east, +y = down) — the
 *   boundary point in that direction. This allows attaching at ANY position.
 */
export type Attach = "auto" | number;

/**
 * One end of a connector. `anchor` is the id of the shape it is attached to
 * (the live position is computed from that shape's boundary); when `anchor` is
 * null the connector floats at `point`. `attach` decides where on the shape it
 * connects (auto, or a fixed angle = any position). `point` is the fallback /
 * free position.
 */
export type Endpoint = { point: Point; anchor: string | null; attach: Attach };

export type ConnectorShape = {
  id: string;
  kind: "connector";
  from: Endpoint;
  to: Endpoint;
  /** Intermediate bend points between `from` and `to` (canvas px). */
  waypoints: Point[];
  /** true = smooth curve through the points; false = straight segments (zig-zag). */
  curved: boolean;
  style: Style;
};

export type Shape =
  | LineShape
  | RectShape
  | CircleShape
  | EllipseShape
  | NodeShape
  | ConnectorShape
  | DiamondShape
  | RoundRectShape
  | CylinderShape
  | PolygonShape
  | ImageShape;

export type TikzDoc = { shapes: Shape[] };

export const DEFAULT_STYLE: Style = {
  stroke: "#1d4ed8",
  fill: "none",
  lineWidth: 1,
  dashed: false,
  arrow: "none",
  opacity: 1,
};
