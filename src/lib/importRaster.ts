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
// Step 5 paints by CONTAINMENT DEPTH (shallow enclosures first), which is what
// makes holes and nested content work without even-odd fills: a ring's traced
// outline is a solid polygon, so whatever it encloses — the white counter of an
// "O", a box's fill and label — must be painted after it, regardless of area.
// Enclosed transparent areas become white shapes for the same reason.
//
// Good on line art, logos, icons and diagrams. A photograph has no flat regions
// to find, so it degrades into a few hundred colour blobs — usable as a poster
// effect, not as a faithful copy. Use "Place as image" for those.
//
// The pure part (`traceRgba`) takes raw RGBA and runs anywhere; `traceImage`
// adds browser decoding via <img> + canvas.

import { CANVAS_H, CANVAS_W, pxToPt } from "./coords";
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
  // 6, not 4: screenshots and infographics carry accent colours (a green
  // stat, a red error count) that need their own slots — the importance-
  // based trim keeps only genuinely distinct entries anyway, so simple
  // logos are unaffected.
  colors: 6,
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

/**
 * Longest side the image is resampled to before tracing. The detail slider
 * raises it (512 → 1024): a dense infographic's small text is 2–3px tall at
 * 512 and traces to unreadable blobs — resolution, not simplification, is
 * what limits fine features. Cost grows with the square of the size.
 */
const WORK_BASE = 512;
const WORK_EXTRA = 512;
export const workMax = (detail: number): number =>
  Math.round(WORK_BASE + Math.max(0, Math.min(1, detail)) * WORK_EXTRA);

/** Hard caps so a photograph can't produce an unusable (or unrenderable) doc. */
const MAX_SHAPES = 600;
const MAX_VERTICES_PER_SHAPE = 500;

/* ------------------------------- quantise -------------------------------- */

// Colours are histogrammed into a 32×32×32 cube (5 bits per channel) so median
// cut works on at most 32768 buckets instead of every pixel. 5 bits, not 4:
// a white card on an off-white page differs by ~10 per channel, which a
// 16-unit bucket collapses — median cut can never separate what the
// histogram already merged. The extra noise splits 8-unit buckets produce
// are folded back by the interleaving-aware merge.
const BITS = 5;
const LEVELS = 1 << BITS; // 32
const CUBE = LEVELS ** 3; // 32768
/** Channel value → bucket: DROP the low bits, i.e. shift by 8−BITS. (Shifting
 *  by BITS was a lurking bug that only happened to be right when BITS was 4.) */
const BUCKET_SHIFT = 8 - BITS;

type Hist = { count: Uint32Array; sum: Float64Array };

function histogram(data: Uint8ClampedArray): Hist {
  const count = new Uint32Array(CUBE);
  const sum = new Float64Array(CUBE * 3);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // transparent pixels belong to no region
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const k = ((r >> BUCKET_SHIFT) << (BITS * 2)) | ((g >> BUCKET_SHIFT) << BITS) | (b >> BUCKET_SHIFT);
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
    // Split the box with the largest count × spread². Raw count-first is the
    // classic median-cut bias: it spends every split subdividing a huge but
    // TIGHT cluster (a white page) and never reaches a small saturated one
    // (a green stat, a red error count) sitting in a wide mixed box.
    let bi = -1;
    let biScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].keys.length <= 1) continue;
      const span = spanOf(boxes[i].keys);
      const score = boxes[i].count * (1 + span * span);
      if (score > biScore) { biScore = score; bi = i; }
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

  function spans(ks: number[]): [number, number, number] {
    const lo = [LEVELS, LEVELS, LEVELS];
    const hi = [-1, -1, -1];
    for (const k of ks) {
      const v = [(k >> (BITS * 2)) & (LEVELS - 1), (k >> BITS) & (LEVELS - 1), k & (LEVELS - 1)];
      for (let c = 0; c < 3; c++) {
        if (v[c] < lo[c]) lo[c] = v[c];
        if (v[c] > hi[c]) hi[c] = v[c];
      }
    }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }

  function spanOf(ks: number[]): number {
    const s = spans(ks);
    return Math.max(s[0], s[1], s[2]);
  }

  function widestChannel(ks: number[]): 0 | 1 | 2 {
    const span = spans(ks);
    if (span[0] >= span[1] && span[0] >= span[2]) return 0;
    return span[1] >= span[2] ? 1 : 2;
  }
}

/**
 * Merge near-duplicate palette entries — but only when their pixels are
 * spatially INTERLEAVED. Colour distance alone cannot make this call: JPEG
 * noise splits one flat area into shades ~17 apart that MUST merge (their
 * boundary traces as ragged garbage), while a white card on an off-white
 * page sits at the same ~17 — and merging those deleted the cards along
 * with the background. The tell is adjacency: noise shades are salt-and-
 * pepper mixed (adjacency ≈ their pixel count), design layers touch only
 * along clean outlines (adjacency ≈ a perimeter, far smaller). Stats come
 * from a stride-2 provisional assignment; entries < 8 apart are true
 * duplicates and merge unconditionally.
 */
function mergeInterleaved(
  entries: PaletteEntry[],
  data: Uint8ClampedArray,
  w: number,
  h: number,
): PaletteEntry[] {
  const k = entries.length;
  if (k < 2) return entries;

  // Provisional nearest-entry assignment on a stride-2 grid.
  const gw = Math.ceil(w / 2);
  const gh = Math.ceil(h / 2);
  const prov = new Int16Array(gw * gh).fill(-1);
  const cnt = new Uint32Array(k);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const p = (gy * 2 * w + gx * 2) * 4;
      if (data[p + 3] < 128) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - entries[c].color[0], dg = g - entries[c].color[1], db = b - entries[c].color[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      prov[gy * gw + gx] = best;
      cnt[best]++;
    }
  }
  const adj = new Uint32Array(k * k);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const a = prov[gy * gw + gx];
      if (a < 0) continue;
      const rgt = gx + 1 < gw ? prov[gy * gw + gx + 1] : -1;
      const dwn = gy + 1 < gh ? prov[(gy + 1) * gw + gx] : -1;
      if (rgt >= 0 && rgt !== a) { adj[a * k + rgt]++; adj[rgt * k + a]++; }
      if (dwn >= 0 && dwn !== a) { adj[a * k + dwn]++; adj[dwn * k + a]++; }
    }
  }

  // Union-find over entries: pairs merge when identical-ish, or when close
  // in colour AND heavily interleaved on the grid.
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const a = entries[i].color, b = entries[j].color;
      const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d2 >= 32 * 32) continue;
      // Salt-and-pepper noise gives ratios well above 1 (every pixel of the
      // smaller shade touches the other repeatedly); a blur/gradient ramp is a
      // 1-D contact band at ~0.1-0.3. The threshold must sit between them, or
      // a card chains to the page through its own drop shadow and vanishes
      // with the background.
      const interleaved = adj[i * k + j] / Math.max(1, Math.min(cnt[i], cnt[j])) > 0.6;
      if (d2 < 8 * 8 || interleaved) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, PaletteEntry>();
  for (let i = 0; i < k; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (!g) {
      groups.set(root, { color: [...entries[i].color], count: entries[i].count });
    } else {
      const n = g.count + entries[i].count;
      g.color = g.color.map((v, c) => (v * g.count + entries[i].color[c] * entries[i].count) / n);
      g.count = n;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
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

/* ------------------------------ centerline ------------------------------- */

/** Widest (work px) a region's mean stroke width can be and still be read as
 *  a drawn LINE rather than a filled shape. Chart lines, borders and small
 *  text sit at 2–4; BOLD display glyphs measure ~6 and must stay filled so
 *  they keep their weight. */
const STROKE_MAX_W = 4.5;

type StrokeFit = { paths: Point[][]; loops: boolean[]; width: number };

/**
 * Try to read a region as a STROKE — a drawn line — instead of a filled shape.
 *
 * For an elongated band, length+width ≈ half the perimeter and length×width ≈
 * the area, so both are roots of x² − (P/2)x + A = 0. If that solves to a
 * thin, elongated band, the region is thinned to a 1px skeleton (Zhang–Suen)
 * and the skeleton walked into polylines split at junctions. Outline tracing
 * would instead produce two parallel wiggly edges and a filled sliver — the
 * classic reason chart axes and arrows trace badly in every outline tracer.
 *
 * Returns null when the region is not stroke-like; the caller falls back to
 * the outline fill, so there is no regression risk for solid shapes.
 */
function traceStroke(
  labels: Int32Array,
  w: number,
  reg: { label: number; area: number; x0: number; y0: number; x1: number; y1: number },
): StrokeFit | null {
  const bw = reg.x1 - reg.x0 + 3; // 1px pad each side, so ZS needs no bounds checks
  const bh = reg.y1 - reg.y0 + 3;
  if (bw * bh > 1_500_000) return null; // pathological; outline mode is fine

  // Build the padded mask and count the exposed 4-edges (staircase perimeter).
  const mask = new Uint8Array(bw * bh);
  let perimeter = 0;
  for (let y = reg.y0; y <= reg.y1; y++) {
    for (let x = reg.x0; x <= reg.x1; x++) {
      if (labels[y * w + x] !== reg.label) continue;
      mask[(y - reg.y0 + 1) * bw + (x - reg.x0 + 1)] = 1;
      if (x === 0 || labels[y * w + x - 1] !== reg.label) perimeter++;
      if (labels[y * w + x + 1] !== reg.label || x === w - 1) perimeter++;
      if (y === 0 || labels[(y - 1) * w + x] !== reg.label) perimeter++;
      if (labels[(y + 1) * w + x] !== reg.label) perimeter++;
    }
  }
  const half = perimeter / 2;
  const disc = half * half - 4 * reg.area;
  if (disc <= 0) return null; // blobby, not band-like
  const width = (half - Math.sqrt(disc)) / 2;
  const length = half - width;
  if (length < 3 * Math.max(1, width)) return null;
  // Thin ink is always a stroke. In the boundary zone up to ~8px, elongation
  // decides: a data curve is hundreds of times longer than wide, while a bold
  // glyph ("W", "e") measures 5–7px wide but only ~10× as long — glyphs must
  // stay FILLED to keep their weight.
  if (width > STROKE_MAX_W && !(width <= 8 && length >= 20 * width)) return null;

  thinToSkeleton(mask, bw, bh);

  // Walk the skeleton into polylines: nodes are endpoints/junctions (degree
  // ≠ 2); paths run node-to-node; whatever remains is a pure loop.
  const NB = [-bw - 1, -bw, -bw + 1, -1, 1, bw - 1, bw, bw + 1];
  const degree = (i: number): number => {
    let d = 0;
    for (const o of NB) if (mask[i + o]) d++;
    return d;
  };
  const isNode = (i: number): boolean => mask[i] === 1 && degree(i) !== 2;
  const used = new Uint8Array(bw * bh); // interior pixels consumed by a path
  const paths: Point[][] = [];
  const loops: boolean[] = [];
  const toPoint = (i: number): Point => ({
    x: (i % bw) - 1 + reg.x0 + 0.5,
    y: Math.floor(i / bw) - 1 + reg.y0 + 0.5,
  });

  const walk = (from: number, into: number): number[] => {
    const px = [from];
    let prev = from;
    let cur = into;
    while (mask[cur] && !isNode(cur) && !used[cur]) {
      used[cur] = 1;
      px.push(cur);
      let next = -1;
      for (const o of NB) {
        const n = cur + o;
        if (mask[n] && n !== prev && (isNode(n) || !used[n])) { next = n; break; }
      }
      if (next < 0) return px; // dead end (shouldn't happen off a clean skeleton)
      prev = cur;
      cur = next;
    }
    px.push(cur);
    return px;
  };

  for (let i = 0; i < bw * bh; i++) {
    if (!isNode(i)) continue;
    for (const o of NB) {
      const n = i + o;
      if (!mask[n] || used[n] || (isNode(n) && n < i)) continue;
      const px = isNode(n) ? [i, n] : walk(i, n);
      // Prune short spurs (skeletonisation nubs), keep real segments.
      if (px.length >= Math.max(4, 1.5 * width)) {
        paths.push(px.map(toPoint));
        loops.push(false);
      }
    }
  }
  // Pure loops (a ring skeleton has no nodes at all).
  for (let i = 0; i < bw * bh; i++) {
    if (!mask[i] || used[i] || isNode(i)) continue;
    const px = [i];
    used[i] = 1;
    let prev = i;
    let cur = -1;
    for (const o of NB) if (mask[i + o]) { cur = i + o; break; }
    while (cur >= 0 && cur !== i && !used[cur]) {
      used[cur] = 1;
      px.push(cur);
      let next = -1;
      for (const o of NB) {
        const n = cur + o;
        if (mask[n] && n !== prev && !used[n]) { next = n; break; }
        if (n === i && px.length > 2) next = n; // closed the loop
      }
      if (next === i || next < 0) break;
      prev = cur;
      cur = next;
    }
    if (px.length >= 6) {
      paths.push(px.map(toPoint));
      loops.push(true);
    }
  }

  // Thinning erodes rounded line ends by about half the stroke width, and a
  // crossing line steals its own width plus anti-aliasing from both sides —
  // together that reads as a dash gap wherever lines intersect. Extend each
  // open end back out along its local tangent far enough to bridge a typical
  // crossing; overshoot tucks under the crossing stroke, which paints later.
  const ext = width / 2 + 2.5;
  for (let k = 0; k < paths.length; k++) {
    if (loops[k]) continue;
    const path = paths[k];
    if (path.length < 2) continue;
    const grow = (tip: Point, ref: Point): Point => {
      const len = Math.hypot(tip.x - ref.x, tip.y - ref.y) || 1;
      return { x: tip.x + ((tip.x - ref.x) / len) * ext, y: tip.y + ((tip.y - ref.y) / len) * ext };
    };
    const a = Math.min(3, path.length - 1);
    path.unshift(grow(path[0], path[a]));
    path.push(grow(path[path.length - 1], path[path.length - 1 - a]));
  }

  return paths.length ? { paths, loops, width: Math.max(1, width) } : null;
}

/** Zhang–Suen thinning: erode the mask down to a 1px-wide skeleton. */
function thinToSkeleton(mask: Uint8Array, bw: number, bh: number): void {
  const toClear: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toClear.length = 0;
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          if (!mask[i]) continue;
          const p2 = mask[i - bw], p3 = mask[i - bw + 1], p4 = mask[i + 1], p5 = mask[i + bw + 1];
          const p6 = mask[i + bw], p7 = mask[i + bw - 1], p8 = mask[i - 1], p9 = mask[i - bw - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          let a = 0;
          if (!p2 && p3) a++;
          if (!p3 && p4) a++;
          if (!p4 && p5) a++;
          if (!p5 && p6) a++;
          if (!p6 && p7) a++;
          if (!p7 && p8) a++;
          if (!p8 && p9) a++;
          if (!p9 && p2) a++;
          if (a !== 1) continue;
          if (step === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          toClear.push(i);
        }
      }
      if (toClear.length) {
        changed = true;
        for (const i of toClear) mask[i] = 0;
      }
    }
  }
}

/**
 * Reconnect stroke fragments. A line interrupted by a crossing (a curve over
 * a gridline) quantises into separate regions, so its centerline arrives in
 * pieces. Join open strokes of the same colour and similar width whose free
 * ends sit close together with aligned tangents — the standard endpoint-
 * linking pass of line vectorisation. Ticks meeting an axis at right angles
 * fail the tangent test and stay separate.
 */
function joinStrokes(strokes: Extract<Shape, { kind: "polygon" }>[]): void {
  // Two tiers: modest gaps join at ~30° tolerance; a shallow crossing steals
  // a LONG stretch (grid width ÷ sin of the crossing angle), so longer jumps
  // are allowed only when both tangents line up almost perfectly.
  const JOIN_DIST = 20; // canvas px
  const ALIGN = 0.86; // cos ~30°
  const FAR_DIST = 36;
  const FAR_ALIGN = 0.95; // cos ~18°
  const outward = (pts: Point[], atEnd: boolean): Point => {
    const tip = atEnd ? pts[pts.length - 1] : pts[0];
    const ref = atEnd ? pts[Math.max(0, pts.length - 3)] : pts[Math.min(pts.length - 1, 2)];
    const len = Math.hypot(tip.x - ref.x, tip.y - ref.y) || 1;
    return { x: (tip.x - ref.x) / len, y: (tip.y - ref.y) / len };
  };
  let joined = true;
  while (joined) {
    joined = false;
    outer: for (let i = 0; i < strokes.length; i++) {
      const a = strokes[i];
      if (a.closed) continue;
      for (let j = i + 1; j < strokes.length; j++) {
        const b = strokes[j];
        if (b.closed || a.style.stroke !== b.style.stroke) continue;
        const ratio = a.style.lineWidth / b.style.lineWidth;
        if (ratio > 1.8 || ratio < 0.55) continue;
        for (const aEnd of [false, true]) {
          for (const bEnd of [false, true]) {
            const pa = aEnd ? a.points[a.points.length - 1] : a.points[0];
            const pb = bEnd ? b.points[b.points.length - 1] : b.points[0];
            const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (d > FAR_DIST) continue;
            const ta = outward(a.points, aEnd);
            const tb = outward(b.points, bEnd);
            if (d < 0.75) {
              // Coincident ends — the two pieces meet AT a skeleton junction
              // pixel (a tiny spur split the line there). Continue straight
              // through when the outward tangents oppose each other.
              if (ta.x * tb.x + ta.y * tb.y > -ALIGN) continue;
            } else {
              const need = d > JOIN_DIST ? FAR_ALIGN : ALIGN;
              const gap = { x: (pb.x - pa.x) / d, y: (pb.y - pa.y) / d };
              if (ta.x * gap.x + ta.y * gap.y < need) continue;
              if (tb.x * -gap.x + tb.y * -gap.y < need) continue;
            }
            const head = aEnd ? a.points : [...a.points].reverse();
            const tail = bEnd ? [...b.points].reverse() : b.points;
            a.points = [...head, ...tail];
            strokes.splice(j, 1);
            joined = true;
            continue outer;
          }
        }
      }
    }
  }
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
  // Over-split, then merge interleaved near-duplicates: without the head-room,
  // median cut wastes splits on anti-aliasing shades that merge right back,
  // and genuinely distinct colours (a red bar, a border blue) never get their
  // own entry — they averaged into mud.
  const entries = mergeInterleaved(medianCut(histogram(data), colors + 10), data, w, h);
  // Reduce to the requested count by greedy farthest-point selection
  // (k-means++-style): start from the dominant entry, then repeatedly keep
  // the entry with the largest coverage × distance²-to-the-kept-set. Judging
  // redundancy against the FINAL kept set is what earlier attempts got
  // wrong: scoring against entries that themselves get dropped collapses a
  // cluster of similar whites to one even when card-vs-page needs two, while
  // pure coverage ranking starves small accents (a green stat, a red curve).
  let kept = entries;
  if (entries.length > colors) {
    kept = [entries[0]];
    const rest = entries.slice(1);
    while (kept.length < colors && rest.length) {
      let best = 0;
      let bestScore = -1;
      for (let i = 0; i < rest.length; i++) {
        let nearest = Infinity;
        for (const s of kept) {
          const a = rest[i].color, b = s.color;
          nearest = Math.min(nearest, (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
        }
        // Sublinear coverage: a saturated accent covering 700 px must beat a
        // fourth band of the same gradient covering 5000 — distinctness
        // matters more than sheer area once the majors are in.
        const score = Math.pow(rest[i].count, 0.7) * nearest;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      kept.push(rest.splice(best, 1)[0]);
    }
    kept.sort((a, b) => b.count - a.count);
  }
  const palette = kept.map((e) => e.color);
  if (!palette.length) return { shapes: [], regions: 0, dropped: 0, vertices: 0, palette: [] };

  // Snap pixels to the palette in two stages. A pixel is CONFIDENT when it
  // clearly belongs to one entry — a close match, or markedly closer to its
  // best entry than to the runner-up. An AMBIGUOUS pixel — an anti-aliased
  // blend sitting BETWEEN two entries — takes the local majority of settled
  // neighbours instead: snapping blends to whichever entry is numerically
  // nearest minted thin fringe regions along every edge (the faint halo
  // outlining dark text on a light ground). Confidence must be relative,
  // not an absolute radius: a thin curve's palette entry is itself an
  // AA-polluted average, so its core pixels sit "far" from it while still
  // being far closer to it than to anything else.
  // Encoding: settled ≥ 0, transparent −1, pending = −2 − nearestEntry.
  const idx = new Int16Array(w * h);
  const CONF2 = 40 * 40;
  const RATIO2 = 2.25; // runner-up at least 1.5× as distant → clearly best
  let pending: number[] = [];
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) { idx[p] = -1; continue; }
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let best = 0;
    let bestD = Infinity;
    let secondD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const dr = r - palette[c][0], dg = g - palette[c][1], db = b - palette[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { secondD = bestD; bestD = d; best = c; }
      else if (d < secondD) secondD = d;
    }
    if (bestD <= CONF2 || bestD * RATIO2 <= secondD) idx[p] = best;
    else {
      idx[p] = -2 - best;
      pending.push(p);
    }
  }
  const tally = new Int32Array(palette.length);
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const settle: number[] = []; // [pixel, colour] pairs, applied after the scan
    const next: number[] = [];
    for (const p of pending) {
      const x = p % w, y = (p / w) | 0;
      tally.fill(0);
      let any = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const v = idx[ny * w + nx];
          if (v >= 0) { tally[v]++; any = true; }
        }
      }
      if (!any) { next.push(p); continue; }
      let c = 0;
      for (let k = 1; k < palette.length; k++) if (tally[k] > tally[c]) c = k;
      settle.push(p, c);
    }
    for (let k = 0; k < settle.length; k += 2) idx[settle[k]] = settle[k + 1];
    pending = next;
  }
  // Anything still unsettled (a wide gradient, a photo) falls back to nearest.
  for (const p of pending) if (idx[p] <= -2) idx[p] = -2 - idx[p];

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
  // the stack on a large uniform area). Transparent runs are labelled too
  // (color -1): an ENCLOSED transparent area is a hole in the artwork, and
  // without a region of its own it would silently vanish under the shape that
  // surrounds it.
  const labels = new Int32Array(w * h).fill(-1);
  type Region = {
    label: number; color: number; area: number; sx: number; sy: number; border: boolean;
    x0: number; y0: number; x1: number; y1: number;
  };
  const regions: Region[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1) continue;
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

  // Containment depth via the parent chain: the pixel above a region's
  // topmost-leftmost pixel belongs to the region "outside" it (or to a sibling
  // stacked above — harmless, they don't overlap). Any region enclosed by a
  // ring is strictly deeper than the ring, so painting shallow-to-deep puts
  // enclosed content ON TOP of its enclosure. Sorting by raw area (the old
  // scheme) broke whenever a thin border ring had LESS area than the fill it
  // enclosed: the ring's solid outer-contour polygon painted over the fill.
  const depths = new Int32Array(regions.length).fill(-1);
  const depthOf = (label: number): number => {
    if (depths[label] >= 0) return depths[label];
    const r = regions[label];
    // Parents start strictly higher up, so the chain terminates at row 0.
    const d = r.sy === 0 ? 0 : depthOf(labels[(r.sy - 1) * w + r.sx]) + 1;
    depths[label] = d;
    return d;
  };
  for (let i = 0; i < regions.length; i++) depthOf(i);

  const keep = regions.filter((r) => {
    if (r.area < opts.minArea) return false;
    // Transparent regions: the border-touching one is the outside world; an
    // enclosed one is a genuine hole and becomes a white shape (the canvas
    // and the rendered page are white, so this reads as a cut-out).
    if (r.color < 0) return !r.border;
    return !(opts.dropBackground && r.color === bg && r.border);
  });
  keep.sort((a, b) => depths[a.label] - depths[b.label] || b.area - a.area);

  const sx = target.w / w;
  const sy = target.h / h;
  // The tolerance is spent in *canvas* pixels, so the detail slider means the
  // same thing whatever the working resolution or how far the trace is scaled
  // up. The 0.5 work-px floor lets DP collapse the smoothed staircase into
  // clean diagonals instead of keeping every half-step.
  const detail = Math.max(0, Math.min(1, opts.detail));
  const eps = Math.max(0.5, (0.5 + (1 - detail) * (1 - detail) * 6) / sx);

  const shapes: Shape[] = [];
  // Centerlined strokes paint AFTER every fill (drawing convention: lines sit
  // on top), so a box's fill never half-covers its own centerlined border.
  const strokes: Shape[] = [];
  let vertices = 0;
  const toCanvas = (p: Point): Point => ({
    x: Math.round((target.x + p.x * sx) * 100) / 100,
    y: Math.round((target.y + p.y * sy) * 100) / 100,
  });

  for (const reg of keep) {
    if (shapes.length + strokes.length >= MAX_SHAPES) break;

    // A thin, elongated region is a drawn LINE: emit its centerline as a
    // stroked path instead of a filled outline sliver.
    if (reg.color >= 0) {
      const fit = traceStroke(labels, w, reg);
      if (fit) {
        const colour = toHex(palette[reg.color]);
        const widthPt = Math.max(0.4, Math.round(pxToPt(fit.width * sx) * 100) / 100);
        fit.paths.forEach((path, i) => {
          const pts = simplify(path, Math.max(0.8, eps * 0.75)).map(toCanvas);
          if (pts.length < 2) return;
          strokes.push({
            id: uid(),
            kind: "polygon",
            closed: fit.loops[i],
            rounded: true,
            style: { ...DEFAULT_STYLE, stroke: colour, fill: "none", lineWidth: widthPt },
            points: pts,
          });
          vertices += pts.length;
        });
        continue;
      }
    }

    // Cap the tolerance against the region's own size: a global epsilon large
    // enough to clean up big shapes would collapse small ones to nothing.
    const regEps = Math.min(eps, 0.25 * Math.max(1, Math.min(reg.x1 - reg.x0 + 1, reg.y1 - reg.y0 + 1)));
    const ring = capVertices(
      simplifyRing(smoothRing(traceContour(labels, w, h, reg.label, reg.sx, reg.sy)), regEps),
      MAX_VERTICES_PER_SHAPE,
    );
    if (ring.length < 3) continue;
    const fill = reg.color < 0 ? "#ffffff" : toHex(palette[reg.color]);
    // Stroke matches the fill: a hairline outline hides the seams that would
    // otherwise show between neighbouring regions in the rendered PDF.
    const style: Style = { ...DEFAULT_STYLE, stroke: fill, fill, lineWidth: 0.4 };
    shapes.push({
      id: uid(),
      kind: "polygon",
      closed: true,
      // Rendered as smooth curves through gentle vertices (sharp corners
      // stay exact), so far fewer points are needed than straight segments.
      rounded: true,
      style,
      points: ring.map(toCanvas),
    });
    vertices += ring.length;
  }

  joinStrokes(strokes as Extract<Shape, { kind: "polygon" }>[]);
  shapes.push(...strokes);
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
export function decode(dataUrl: string, maxDim: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
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
  const { data, w, h } = await decode(dataUrl, workMax(opts.detail));
  return traceRgba(data, w, h, opts);
}
