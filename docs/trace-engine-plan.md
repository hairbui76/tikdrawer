# Trace Engine Plan

Why traced images disappointed, what production tracers do differently, and the
phased plan that closed the gap — grounded in visual tests run against the real
dialog in headless Chrome. **All four phases are landed** (2026-08-22).

Engine: `src/lib/importRaster.ts` · Tests: `src/lib/__tests__/importRaster.test.ts` (`npm test`)

## Where quality stands

| Failure | Cause | Status |
| --- | --- | --- |
| Boxes became solid slabs | Paint order by area — a thin border ring encloses a larger fill, so its solid polygon covered fill and text | Fixed — containment-depth painting |
| Transparent holes vanished | Transparent areas had no regions; enclosed holes were swallowed | Fixed — holes become white shapes |
| Small features → mush | Everything downscaled to 512px before tracing | Fixed — Detail slider scales resolution to 1024 |
| Accent colours vanish (chart's red/blue traced grey) | Palette trimmed by coverage — chromatically vital but pixel-tiny colours got cut | Fixed — trim by coverage × distinctiveness² |
| Curves heavy & faceted | Output was straight-segment polygons only | Fixed — Phase 1: rounded polygons render as Béziers |
| Thin strokes traced as blob outlines | Outline tracing doubles every stroke | Fixed — Phase 2: centerline strokes with endpoint linking |
| Tiny text is squiggles | Fundamental to outline tracing — every tracer does this | Limit — mitigated: "Skip tiny marks" toggle + hint; small text as pen strokes |

## What the good tracers do

- **Potrace** (binary images): optimal polygon via penalty minimisation, then
  Bézier fitting with an `alphamax` corner threshold, then curve joining. Its
  quality comes from curves, not denser polygons.
- **VTracer** (colour): hierarchical colour clustering into stacked layers (the
  model TikDrawer shares), per-layer spline fitting, `corner_threshold` ≈ 60°.
- **ImageTracer.js** (colour): error-threshold fitting — straight line
  (`ltres`), else quadratic spline (`qtres`), else split and recurse.
- **Centerline family** (autotrace centerline, skeleton-tracing): Zhang–Suen
  thinning → polyline graph — the only approach that turns a stroke into a
  *stroked path*. None of the three above do this.

Sources: Selinger, *Potrace: a polygon-based tracing algorithm*;
github.com/visioncortex/vtracer; github.com/jankovicsandras/imagetracerjs
(process_overview.md); github.com/LingDong-/skeleton-tracing; Disney,
*Topology-Driven Vectorization of Clean Line Drawings*.

## The phases (all landed 2026-08-22)

### Phase 1 — smooth curve output

`PolygonShape.rounded` renders smooth curves through gentle vertices (sharper
than 62° stay exact corners). The same Catmull-Rom control points drive the
canvas `<path>`, the trace preview, and the TikZ `.. controls ..` output, so
preview and PDF agree.

*Landed:* a traced circle reads round with ≤ 32 stored points (was 149);
rectangle corners stay sharp; the diamond still traces to exactly 4 vertices.

### Phase 2 — centerline strokes for thin regions

A thin elongated region is a drawn LINE: mean width from the quadratic whose
roots are length and width (L+W = perimeter/2, L·W = area); accepted when
W ≤ 4.5 work px (or up to 8 px when L ≥ 20·W — a curve is 100×+ longer than
wide, a bold glyph ~10×). Zhang–Suen thinning, skeleton walked into polylines
split at junctions, spurs pruned, loops kept closed. Emitted as rounded
stroked polylines with the measured line width; strokes paint after all fills.
Open ends re-extend W/2 + 2.5 px along their tangent (thinning erodes caps),
and an endpoint-linking pass rejoins same-colour fragments cut by crossings
(≤ 20 canvas px at cos 0.86, ≤ 36 px at cos 0.95; coincident junction ends
join when tangents oppose).

*Landed:* the chart traces to continuous smooth stroked curves + clean axes
(958 → ~400 pts); flowchart arrows are single lines; the logo's solid shapes
are untouched.

### Phase 3 — anti-alias assignment & halo cleanup

Two-stage palette snapping: CONFIDENT pixels (close match, or ≥ 1.5× closer to
best than runner-up) keep their entry; AMBIGUOUS blends take the local majority
of settled neighbours (≤ 4 parallel passes). Kills the fringe halo around text.
Confidence must be **relative** — an absolute radius silently ate thin curves
whose palette entry is itself an AA-polluted average (caught by the test
suite).

*Landed:* logo 25 → 16 shapes, wordmark fringe gone.

### Phase 4 — worker, tests, and text guidance

- `trace.worker.ts` + `traceClient.traceImageOffThread`: decode on the main
  thread, transfer RGBA to a Web Worker, inline fallback. Worst main-thread
  gap during a max-detail 1024px trace: 48–66 ms measured (was ~1.5 s).
- Vitest suite (pinned v2 — vitest 4's rolldown binding fails npm install) +
  five PNG fixtures covering every failure class that actually occurred.
- Dialog: "Skip tiny marks (N)" toggle (infographic 378 → 192 shapes) and a
  hint when > 35% of > 50 shapes are tiny: probably text — place as image or
  retype labels with text nodes.

## Honest limits

Tiny raster text can never trace into readable text — outline tracing yields
letter-shaped marks at best (small text as pen strokes is deliberately kept:
more readable than blob outlines). Photographs degrade into a poster effect;
use "Place as image".
