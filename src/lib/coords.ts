import type { Point } from "./types";

/** Logical drawing space (SVG viewBox units == screen px at 1:1). */
export const CANVAS_W = 800;
export const CANVAS_H = 600;
/** Pixels (logical units) per TikZ centimeter. */
export const PX_PER_CM = 40;
/** Grid spacing in logical units (0.5 cm). */
export const GRID = 20;

export const round = (n: number): number => Number(n.toFixed(3));

/** Output unit for generated TikZ coordinates / ruler. */
export type Unit = "cm" | "mm" | "pt";

/** How many of each unit make up 1 cm (pt = TeX point, 1cm = 28.4527pt). */
export const UNIT_PER_CM: Record<Unit, number> = { cm: 1, mm: 10, pt: 28.4527559 };

/** Format a length given in cm as a value in `unit` with its suffix. */
export const fmtUnit = (cm: number, unit: Unit): string => `${round(cm * UNIT_PER_CM[unit])}${unit}`;

/** Convert a canvas X (px, origin top-left) to TikZ cm. */
export const pxToCmX = (x: number): number => round(x / PX_PER_CM);

/**
 * Convert a canvas Y (px, origin top-left, growing down) to TikZ cm.
 * TikZ Y grows up, so we flip around the canvas height.
 */
export const pxToCmY = (y: number): number => round((CANVAS_H - y) / PX_PER_CM);

/** Convert a length (px) to cm (no flip). */
export const lenToCm = (n: number): number => round(n / PX_PER_CM);

export const snapToGrid = (n: number): number => Math.round(n / GRID) * GRID;

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
