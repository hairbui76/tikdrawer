// Vectorise a raster image (PNG/JPG/WebP) into editable polygon shapes.
//
// Unlike importSvg, a bitmap carries no geometry — there is nothing to read,
// only pixels — so the shapes have to be *inferred*:
//
//   1. quantise the pixels down to a small palette (median cut), merging
//      near-duplicate colours and despeckling the result — JPEG noise and
//      anti-alias halos otherwise become thousands of junk regions,
//   2. label 4-connected regions of each palette colour,
//   3. trace each region's outline by crack following (walk the boundary
//      between inside/outside pixels on the corner lattice),
//   4. smooth the staircase (edge midpoints) and simplify with Douglas-Peucker,
//   5. emit one closed `polygon` shape per region, largest first.
//
// Step 5's ordering is what makes holes work without even-odd fills: the white
// counter inside an "O" is its own region of the background colour, and being
// smaller it is painted *after* (on top of) the black ring — both on canvas and
// in the generated TikZ, which draw in array order.
//
// Good on line art, logos, icons and diagrams. A photograph has no flat regions
// to find, so it degrades into a few hundred colour blobs — usable as a poster
// effect, not as a faithful copy. Use "Place as image" for those.
//
// The pure part (`traceRgba`) takes raw RGBA and runs anywhere; `traceImage`
// adds browser decoding via <img> + canvas.

import { CANVAS_H, CANVAS_W } from "./coords";
import { DEFAULT_STYLE, type Point, type Shape, type Style } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

export type TraceOptions = {
  /** Palette size the image is quantised to (2..16). Fewer = flatter, cleaner. */
  colors: number;
  /** 0..1 outline fidelity: 0 = few vertices/blocky, 1 = follows every wiggle. */
  detail: number;
  /** Regions smaller than this (in traced pixels) are discarded as speckle. */
  minArea: number;
  /** Drop the border-touching background so the drawing isn't a filled sheet. */
  dropBackground: boolean;
};

export const DEFAULT_TRACE: TraceOptions = {
  colors: 4,
  detail: 0.5,
  minArea: 16,
  dropBackground: true,
};

export type TraceResult = {
  shapes: Shape[];
  /** Regions actually emitted. */
  regions: number;
  /** Regions found but discarded (speckle, background, or over the cap). */
  dropped: number;
  /** Total vertices across the emitted shapes — a rough cost of the drawing. */
  vertices: number;
  /** The palette that was used, as hex, largest coverage first. */
  palette: string[];
};

/** Longest side the image is resampled to before tracing. Bigger means slower
 *  and far more vertices, without much visible gain after simplification. */
const WORK_MAX = 512;

/** Hard caps so a photograph can't produce an unusable (or unrenderable) doc. */
const MAX_SHAPES = 400;
const MAX_VERTICES_PER_SHAPE = 500;

/* ------------------------------- quantise -------------------------------- */

// Colours are histogrammed into a 16×16×16 cube (4 bits per channel) so median
// cut works on at most 4096 buckets instead of every pixel.
const BITS = 4;
const LEVELS = 1 << BITS; // 16
const CUBE = LEVELS ** 3; // 4096

type Hist = { count: Uint32Array; sum: Float64Array };

function histogram(data: Uint8ClampedArray): Hist {
  const count = new Uint32Array(CUBE);
  const sum = new Float64Array(CUBE * 3);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // transparent pixels belong to no region
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const k = ((r >> BITS) << (BITS * 2)) | ((g >> BITS) << BITS) | (b >> BITS);
    count[k]++;
    sum[k * 3] += r;
    sum[k * 3 + 1] += g;
    sum[k * 3 + 2] += b;
  }
  return { count, sum };
}

type Box = { keys: number[]; count: number };

type PaletteEntry = { color: number[]; count: number };

/** Median-cut quantisation → up to `n` representative colours with coverage. */
function medianCut(hist: Hist, n: number): PaletteEntry[] {
  const keys: number[] = [];
  let total = 0;
  for (let k = 0; k < CUBE; k++) {
    if (hist.count[k]) {
      keys.push(k);
      total += hist.count[k];
    }
  }
  if (!keys.length) return [];

  const boxes: Box[] = [{ keys, count: total }];
  while (boxes.length < n) {
    // Split the heaviest box that still has something to split.
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].keys.length > 1 && (bi < 0 || boxes[i].count > boxes[bi].count)) bi = i;
    }
    if (bi < 0) break;
    const box = boxes[bi];

    // Cut along the channel with the widest spread, at the weighted median so
    // both halves carry a similar number of pixels.
    const chan = widestChannel(box.keys);
    const shift = (2 - chan) * BITS;
    box.keys.sort((a, b) => ((a >> shift) & (LEVELS - 1)) - ((b >> shift) & (LEVELS - 1)));
    let acc = 0;
    let cut = 0;
    for (; cut < box.keys.length - 1; cut++) {
      acc += hist.count[box.keys[cut]];
      if (acc * 2 >= box.count) break;
    }
    // One dominant bucket can hold the median (or the loop can run off the
    // end); keep at least one bucket on each side so the split makes progress.
    cut = Math.min(cut, box.keys.length - 2);
    const left = box.keys.slice(0, cut + 1);
    const right = box.keys.slice(cut + 1);
    const leftCount = left.reduce((s, k) => s + hist.count[k], 0);
    boxes.splice(bi, 1, { keys: left, count: leftCount }, { keys: right, count: box.count - leftCount });
  }

  // Heaviest boxes first, so palette[0] is the dominant colour.
  boxes.sort((a, b) => b.count - a.count);
  return boxes.map((box) => {
    let c = 0, r = 0, g = 0, b = 0;
    for (const k of box.keys) {
      c += hist.count[k];
      r += hist.sum[k * 3];
      g += hist.sum[k * 3 + 1];
      b += hist.sum[k * 3 + 2];
    }
    return { color: c ? [r / c, g / c, b / c] : [0, 0, 0], count: c };
  });

  function widestChannel(ks: number[]): 0 | 1 | 2 {
    const lo = [LEVELS, LEVELS, LEVELS];
    const hi = [-1, -1, -1];
    for (const k of ks) {
      const v = [(k >> (BITS * 2)) & (LEVELS - 1), (k >> BITS) & (LEVELS - 1), k & (LEVELS - 1)];
      for (let c = 0; c < 3; c++) {
        if (v[c] < lo[c]) lo[c] = v[c];
        if (v[c] > hi[c]) hi[c] = v[c];
      }
    }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (span[0] >= span[1] && span[0] >= span[2]) return 0;
    return span[1] >= span[2] ? 1 : 2;
  }
}

/**
 * Merge palette entries closer than `dist` (Euclidean RGB), coverage-weighted.
 * Median cut on a JPEG readily produces two near-identical colours for one flat
 * area (compression noise pushes pixels across a bucket boundary); the boundary
 * between them then traces as a ragged, meaningless region edge. Never merges
 * below two colours so the background/foreground split survives.
 */
function mergeClose(entries: PaletteEntry[], dist: number): PaletteEntry[] {
  const d2 = dist * dist;
  let merged = true;
  while (merged && entries.length > 2) {
    merged = false;
    outer: for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        const dr = a.color[0] - b.color[0];
        const dg = a.color[1] - b.color[1];
        const db = a.color[2] - b.color[2];
        if (dr * dr + dg * dg + db * db < d2) {
          const n = a.count + b.count;
          a.color = a.color.map((v, k) => (v * a.count + b.color[k] * b.count) / n);
          a.count = n;
          entries.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

/**
 * Majority-vote cleanup of the quantised index map. A pixel with at most one
 * 8-neighbour of its own colour is JPEG noise or an anti-alias halo speck —
 * reassign it to the dominant colour around it. A continuous 1px line keeps two
 * same-colour neighbours along its length, so deliberate line art survives.
 */
function despeckle(idx: Int16Array, w: number, h: number, passes: number): void {
  const counts = new Int32Array(18); // palette indices -1..16, offset by 1
  for (let pass = 0; pass < passes; pass++) {
    const prev = Int16Array.from(idx);
    let changed = false;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        counts.fill(0);
        for (let yy = y0; yy <= y1; yy++)
          for (let xx = x0; xx <= x1; xx++) counts[prev[yy * w + xx] + 1]++;
        const c = prev[y * w + x];
        if (counts[c + 1] > 2) continue; // itself + ≥2 allies → keep
        let mode = c, modeN = 0;
        for (let k = 0; k < 18; k++) if (counts[k] > modeN) { modeN = counts[k]; mode = k - 1; }
        if (mode !== c) { idx[y * w + x] = mode; changed = true; }
      }
    }
    if (!changed) break;
  }
}

const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const toHex = (c: number[]): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

/* ------------------------------- contours -------------------------------- */

// Walk directions on the corner lattice: 0=+x, 1=+y, 2=-x, 3=-y.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Trace the outline of the region labelled `label` by crack following.
 *
 * The walk lives on pixel *corners*, keeping the region on its right, so the
 * result is a closed clockwise ring of lattice points (staircase edges, exact —
 * no diagonal shortcuts). Starting at the region's topmost-leftmost pixel makes
 * the initial corner and direction unambiguous.
 */
function traceContour(
  labels: Int32Array,
  w: number,
  h: number,
  label: number,
  sx: number,
  sy: number,
): Point[] {
  const inside = (px: number, py: number): boolean =>
    px >= 0 && py >= 0 && px < w && py < h && labels[py * w + px] === label;

  const pts: Point[] = [];
  let x = sx, y = sy, dir = 0;
  // Bound the walk: every (corner, direction) state is visited at most once.
  const limit = (w + 1) * (h + 1) * 4;
  do {
    pts.push({ x, y });
    x += DX[dir];
    y += DY[dir];
    // Decide the next direction from the two pixels flanking the edge we would
    // traverse by carrying straight on: `l` is to the left of travel (outside
    // if we stay on the boundary), `r` is to the right (inside).
    let lx: number, ly: number, rx: number, ry: number;
    switch (dir) {
      case 0: lx = x; ly = y - 1; rx = x; ry = y; break;
      case 1: lx = x; ly = y; rx = x - 1; ry = y; break;
      case 2: lx = x - 1; ly = y; rx = x - 1; ry = y - 1; break;
      default: lx = x - 1; ly = y - 1; rx = x; ry = y - 1; break;
    }
    if (inside(lx, ly)) dir = (dir + 3) % 4;      // region wraps left → turn left
    else if (!inside(rx, ry)) dir = (dir + 1) % 4; // ran off the region → turn right
    // else: region still on our right → carry straight on.
  } while ((x !== sx || y !== sy || dir !== 0) && pts.length < limit);

  return pts;
}

/* ------------------------------- simplify -------------------------------- */

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.sqrt(len2);
}

/** Douglas-Peucker on an open polyline (both endpoints are kept). */
function simplify(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let idx = -1;
    let max = eps;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Replace each lattice point with the midpoint of its outgoing edge. Crack
 * following yields a staircase of unit steps with only 90° turns; midpoints
 * halve the step amplitude and turn 45° stairs into true diagonals, so the
 * simplification pass afterwards produces clean slanted edges instead of either
 * jagged steps (small eps) or blocky chords (large eps). True corners only
 * round by half a work pixel — invisible at canvas scale.
 */
function smoothRing(ring: Point[]): Point[] {
  const n = ring.length;
  if (n < 3) return ring;
  const out = new Array<Point>(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out[i] = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return out;
}

/** Simplify a closed ring: temporarily reopen it so DP has fixed endpoints. */
function simplifyRing(ring: Point[], eps: number): Point[] {
  if (ring.length < 4) return ring;
  const open = simplify([...ring, ring[0]], eps);
  open.pop(); // drop the duplicated start point
  return open;
}

/** Evenly thin an over-long ring down to `max` vertices, keeping its shape. */
function capVertices(ring: Point[], max: number): Point[] {
  if (ring.length <= max) return ring;
  const step = ring.length / max;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(ring[Math.floor(i * step)]);
  return out;
}

/* --------------------------------- trace --------------------------------- */

/** Where the traced drawing is placed on the canvas. */
type Target = { x: number; y: number; w: number; h: number };

/** Aspect-preserving box that fits a w×h image into the canvas with a margin. */
function fitTarget(w: number, h: number, margin = 40): Target {
  const scale = Math.min((CANVAS_W - 2 * margin) / w, (CANVAS_H - 2 * margin) / h);
  const tw = w * scale, th = h * scale;
  return { x: (CANVAS_W - tw) / 2, y: (CANVAS_H - th) / 2, w: tw, h: th };
}

/**
 * Trace raw RGBA pixels into polygon shapes. Pure — no DOM — so it can be
 * unit-tested and reused off the main thread.
 */
export function traceRgba(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: TraceOptions = DEFAULT_TRACE,
  target: Target = fitTarget(w, h),
): TraceResult {
  const colors = Math.max(2, Math.min(16, Math.round(opts.colors)));
  const palette = mergeClose(medianCut(histogram(data), colors), 32).map((e) => e.color);
  if (!palette.length) return { shapes: [], regions: 0, dropped: 0, vertices: 0, palette: [] };

  // Snap every pixel to its nearest palette entry (-1 = transparent).
  const idx = new Int16Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) { idx[p] = -1; continue; }
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const dr = r - palette[c][0], dg = g - palette[c][1], db = b - palette[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = c; }
    }
    idx[p] = best;
  }

  despeckle(idx, w, h, 2);

  // The background is whatever colour dominates the border pixels.
  let bg = -1;
  if (opts.dropBackground) {
    const tally = new Uint32Array(palette.length);
    const bump = (p: number) => { if (idx[p] >= 0) tally[idx[p]]++; };
    for (let x = 0; x < w; x++) { bump(x); bump((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { bump(y * w); bump(y * w + w - 1); }
    let bestN = 0;
    for (let c = 0; c < palette.length; c++) if (tally[c] > bestN) { bestN = tally[c]; bg = c; }
    // On a transparent-background PNG the border is mostly alpha; whatever few
    // coloured pixels touch it are artwork, not a backdrop — don't drop them.
    if (bestN * 4 < 2 * (w + h)) bg = -1;
  }

  // Label 4-connected regions (iterative flood fill — deep recursion would blow
  // the stack on a large uniform area).
  const labels = new Int32Array(w * h).fill(-1);
  type Region = {
    label: number; color: number; area: number; sx: number; sy: number; border: boolean;
    x0: number; y0: number; x1: number; y1: number;
  };
  const regions: Region[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || idx[start] < 0) continue;
    const color = idx[start];
    const label = regions.length;
    const sx0 = start % w, sy0 = (start / w) | 0;
    const reg: Region = {
      label, color, area: 0, sx: sx0, sy: sy0, border: false,
      x0: sx0, y0: sy0, x1: sx0, y1: sy0,
    };
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p / w) | 0;
      reg.area++;
      if (x < reg.x0) reg.x0 = x; else if (x > reg.x1) reg.x1 = x;
      if (y > reg.y1) reg.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) reg.border = true;
      // Scanning top-to-bottom means `start` is already the topmost-leftmost
      // pixel of the region, which is exactly where the contour walk begins.
      if (x > 0 && labels[p - 1] === -1 && idx[p - 1] === color) { labels[p - 1] = label; stack.push(p - 1); }
      if (x < w - 1 && labels[p + 1] === -1 && idx[p + 1] === color) { labels[p + 1] = label; stack.push(p + 1); }
      if (y > 0 && labels[p - w] === -1 && idx[p - w] === color) { labels[p - w] = label; stack.push(p - w); }
      if (y < h - 1 && labels[p + w] === -1 && idx[p + w] === color) { labels[p + w] = label; stack.push(p + w); }
    }
    regions.push(reg);
  }

  const keep = regions.filter(
    (r) => r.area >= opts.minArea && !(opts.dropBackground && r.color === bg && r.border),
  );
  // Largest first: smaller regions are drawn on top, which is what turns an
  // enclosed background region back into a visible hole.
  keep.sort((a, b) => b.area - a.area);

  const sx = target.w / w;
  const sy = target.h / h;
  // The tolerance is spent in *canvas* pixels, so the detail slider means the
  // same thing whatever the working resolution or how far the trace is scaled
  // up. The 0.5 work-px floor lets DP collapse the smoothed staircase into
  // clean diagonals instead of keeping every half-step.
  const detail = Math.max(0, Math.min(1, opts.detail));
  const eps = Math.max(0.5, (0.5 + (1 - detail) * (1 - detail) * 6) / sx);

  const shapes: Shape[] = [];
  let vertices = 0;
  for (const reg of keep) {
    if (shapes.length >= MAX_SHAPES) break;
    // Cap the tolerance against the region's own size: a global epsilon large
    // enough to clean up big shapes would collapse small ones to nothing.
    const regEps = Math.min(eps, 0.25 * Math.max(1, Math.min(reg.x1 - reg.x0 + 1, reg.y1 - reg.y0 + 1)));
    const ring = capVertices(
      simplifyRing(smoothRing(traceContour(labels, w, h, reg.label, reg.sx, reg.sy)), regEps),
      MAX_VERTICES_PER_SHAPE,
    );
    if (ring.length < 3) continue;
    const fill = toHex(palette[reg.color]);
    // Stroke matches the fill: a hairline outline hides the seams that would
    // otherwise show between neighbouring regions in the rendered PDF.
    const style: Style = { ...DEFAULT_STYLE, stroke: fill, fill, lineWidth: 0.4 };
    shapes.push({
      id: uid(),
      kind: "polygon",
      closed: true,
      style,
      points: ring.map((p) => ({
        x: Math.round((target.x + p.x * sx) * 100) / 100,
        y: Math.round((target.y + p.y * sy) * 100) / 100,
      })),
    });
    vertices += ring.length;
  }

  return {
    shapes,
    regions: shapes.length,
    dropped: regions.length - shapes.length,
    vertices,
    palette: palette.map(toHex),
  };
}

/* --------------------------------- decode -------------------------------- */

/** Decode a data URL to RGBA at a working resolution (browser only). */
function decode(dataUrl: string, maxDim: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("Could not decode the image"));
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return reject(new Error("no 2d context"));
      // Smoothing averages away single-pixel noise before quantisation; "high"
      // avoids the aliasing a naive box-filter downscale adds on big photos.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ data: ctx.getImageData(0, 0, w, h).data, w, h });
    };
    img.src = dataUrl;
  });
}

/**
 * Trace an image (data URL) into editable polygon shapes, laid out to fill the
 * canvas. Browser-only — needs <img> + canvas to decode the pixels.
 */
export async function traceImage(dataUrl: string, opts: TraceOptions = DEFAULT_TRACE): Promise<TraceResult> {
  const { data, w, h } = await decode(dataUrl, WORK_MAX);
  return traceRgba(data, w, h, opts);
}
