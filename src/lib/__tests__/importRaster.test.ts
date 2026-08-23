// Regression suite for the raster tracer. The engine regressed silently
// several times while it had no tests; every class of image that broke once
// is pinned here — synthetic patterns for exact geometry, PNG fixtures for
// the failure modes that only real images exposed (palette collapse, hole
// loss, stroke handling, bold text weight).
//
// Assertions are deliberately tolerant ranges: the tracer is tuned by visual
// inspection, and these tests exist to catch structural breakage (a colour
// vanishing, holes filling in, strokes reverting to slivers), not to freeze
// exact vertex counts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { PolygonShape } from "../types";
import { DEFAULT_TRACE, traceRgba, type TraceResult } from "../importRaster";

const FIXTURES = join(__dirname, "fixtures");

function tracePng(name: string, opts = DEFAULT_TRACE): TraceResult {
  const png = PNG.sync.read(readFileSync(join(FIXTURES, name)));
  const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  return traceRgba(data, png.width, png.height, opts);
}

const polys = (r: TraceResult): PolygonShape[] =>
  r.shapes.filter((s): s is PolygonShape => s.kind === "polygon");
const fills = (r: TraceResult): PolygonShape[] => polys(r).filter((s) => s.style.fill !== "none");
const strokes = (r: TraceResult): PolygonShape[] => polys(r).filter((s) => s.style.fill === "none");

const dist = (hex: string, rgb: [number, number, number]): number => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return Math.hypot(r - rgb[0], g - rgb[1], b - rgb[2]);
};
const paletteHas = (r: TraceResult, rgb: [number, number, number], tol = 60): boolean =>
  r.palette.some((c) => dist(c, rgb) < tol);

/* ------------------------------- synthetic -------------------------------- */

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function makeImage(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  return data;
}

describe("synthetic patterns", () => {
  it("traces an anti-aliased disc to one compact rounded shape", () => {
    const img = makeImage(200, 200, (x, y) => {
      const d = Math.hypot(x - 100, y - 100) - 60;
      const v = Math.max(0, Math.min(1, (d + 1) / 2)) * 255;
      return [v, v, v, 255];
    });
    const r = traceRgba(img, 200, 200, { ...DEFAULT_TRACE, colors: 2 });
    expect(r.shapes.length).toBe(1);
    const disc = polys(r)[0];
    expect(disc.rounded).toBe(true);
    expect(disc.points.length).toBeGreaterThanOrEqual(8);
    expect(disc.points.length).toBeLessThanOrEqual(48);
  });

  it("keeps a 45° diamond as exactly 4 sharp vertices", () => {
    const img = makeImage(200, 200, (x, y) =>
      Math.abs(x - 100) + Math.abs(y - 100) < 70 ? [200, 30, 30, 255] : [255, 255, 255, 255],
    );
    const r = traceRgba(img, 200, 200, { ...DEFAULT_TRACE, colors: 2 });
    expect(r.shapes.length).toBe(1);
    expect(polys(r)[0].points.length).toBe(4);
  });

  it("does not drop a shape touching the border of a transparent PNG", () => {
    const img = makeImage(200, 200, (x, y) =>
      x < 40 && y > 60 && y < 140 ? [20, 60, 200, 255] : [0, 0, 0, 0],
    );
    const r = traceRgba(img, 200, 200, DEFAULT_TRACE);
    expect(r.shapes.length).toBe(1);
  });

  it("merges noisy near-duplicate shades into one flat colour each", () => {
    const img = makeImage(200, 200, (x) => {
      const v = (x < 100 ? 240 : 40) + (rand() - 0.5) * 30;
      return [v, v, v, 255];
    });
    const r = traceRgba(img, 200, 200, { ...DEFAULT_TRACE, colors: 8, dropBackground: false });
    expect(r.palette.length).toBe(2);
    expect(r.shapes.length).toBeLessThanOrEqual(4);
  });
});

/* ----------------------------- real fixtures ------------------------------ */

describe("logo (solid shapes, bold wordmark)", () => {
  const r = tracePng("logo.png");

  it("keeps every brand colour despite tiny coverage of some", () => {
    expect(paletteHas(r, [29, 78, 216])).toBe(true); // disc blue
    expect(paletteHas(r, [220, 60, 60])).toBe(true); // accent red — was lost by coverage-capping
    expect(paletteHas(r, [30, 41, 59])).toBe(true); // wordmark navy — was washed to grey
  });

  it("keeps bold glyphs as FILLED shapes, not centerline strokes", () => {
    const navyFills = fills(r).filter((s) => dist(s.style.fill, [30, 41, 59]) < 60);
    expect(navyFills.length).toBeGreaterThanOrEqual(5); // letterforms
    const navyStrokes = strokes(r).filter((s) => dist(s.style.stroke, [30, 41, 59]) < 60);
    expect(navyStrokes.length).toBeLessThanOrEqual(2);
  });

  it("stays compact", () => {
    expect(r.shapes.length).toBeLessThanOrEqual(40);
    expect(r.vertices).toBeLessThanOrEqual(600);
  });
});

describe("flowchart (fills enclosed by border rings, thin arrows)", () => {
  const r = tracePng("flowchart.png");

  it("keeps the pale box fills (the ring-over-fill paint-order bug)", () => {
    const pale = fills(r).filter((s) => dist(s.style.fill, [219, 234, 254]) < 60 && s.points.length >= 4);
    expect(pale.length).toBeGreaterThanOrEqual(4); // one per box
  });

  it("emits genuine stroked lines for borders and arrows", () => {
    expect(strokes(r).length).toBeGreaterThanOrEqual(8);
    const wide = strokes(r).filter((s) => s.style.lineWidth >= 1);
    expect(wide.length).toBeGreaterThanOrEqual(4);
  });
});

describe("icon (transparent hole)", () => {
  const r = tracePng("icon.png");

  it("keeps the enclosed transparent area as a white cut-out on top", () => {
    const white = r.shapes.findIndex((s) => s.kind === "polygon" && s.style.fill === "#ffffff");
    const red = r.shapes.findIndex(
      (s) => s.kind === "polygon" && s.style.fill !== "none" && dist(s.style.fill, [200, 30, 60]) < 70,
    );
    expect(red).toBeGreaterThanOrEqual(0);
    expect(white).toBeGreaterThan(red); // painted after → visible hole
  });

  it("stays tiny", () => {
    expect(r.shapes.length).toBeLessThanOrEqual(6);
    expect(r.vertices).toBeLessThanOrEqual(120);
  });
});

describe("chart (thin curves, axes, gridlines)", () => {
  const r = tracePng("chart.png");

  it("keeps the red data curve as a coloured centerline stroke", () => {
    const red = strokes(r).filter(
      (s) => dist(s.style.stroke, [214, 69, 65]) < 90 && s.points.length >= 5,
    );
    expect(red.length).toBeGreaterThanOrEqual(1);
    expect(red.length).toBeLessThanOrEqual(12); // joined, not 20+ confetti fragments
  });

  it("emits strokes with a real measured width", () => {
    const widths = strokes(r).map((s) => s.style.lineWidth);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(1);
  });

  it("is far lighter than outline tracing", () => {
    expect(r.vertices).toBeLessThanOrEqual(900); // outline mode produced ~1000+
  });
});

describe("infographic (dense, text-heavy)", () => {
  it("survives without collapsing or exploding", () => {
    const r = tracePng("infographic.png");
    expect(r.shapes.length).toBeGreaterThanOrEqual(80);
    expect(r.shapes.length).toBeLessThanOrEqual(600);
  });
});
