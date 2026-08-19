# MEMORY.md

A running log of decisions, changes, and gotchas for the **TikDrawer** project.

> **Rule:** every action in this repo must add a dated entry here. Newest first.

---

## 2026-08-19 — Fine-grained move/resize (Alt bypass + arrow nudge)

User: wants to move/scale in small units (px/pt); "it always transforms a
lot" = the default 0.5cm grid snap quantising every drag.

- **Alt held during a drag bypasses grid snap** for that gesture (move,
  resize, rotate's 15° steps, and drawing via `getPoint`) — `snapWith(e)`
  helper in CanvasStage reads `e.altKey` per pointer event.
- **Arrow keys nudge the selection by 1px** (= 0.025cm ≈ 0.71pt, the finest
  model unit); **Shift+arrow = one grid cell (20px)**. `nudgeSelected(dx,dy)`
  store action; each press is its own undo step. Without a selection the
  arrows keep native scrolling; handler skipped while typing.
- `translate` moved from CanvasStage to `geometry.ts` as **`translateShape`**
  so the store's nudge action and the canvas drag share one implementation.
- Snap checkbox tooltip documents both (Alt + arrows).
- Exact numeric W/H inputs already existed in PropertiesPanel (px units).
- Verified headless Chrome, production build: Alt-drag 7,3px → exactly
  (0.175,-0.075)cm; Alt-resize +5px → +0.125cm; arrows 3R2U → (0.075,0.05)cm;
  Shift+→ → 0.5cm; Ctrl+Z undoes one nudge; plain snap drag still lands the
  corner ON the grid; arrows without selection move nothing.
- **Snap semantics note:** with snap on, a plain drag aligns the shape's bbox
  corner TO the grid (draw.io style) — after off-grid fine adjustments, the
  next snapped drag re-aligns it. The *delta* is deliberately not the thing
  quantised.

## 2026-08-19 — Fix: snap teleported shapes on grab (the real "jump" bug)

User: still jumping after the wheel fix; asked if it depends on "the ratio of
the ruler". Systematic hunt (pointer travel vs model movement, all zooms ×
ruler on/off × DPR 1/1.25/2) showed pixel-perfect drags everywhere — the
earlier harness "failures" were the harness clicking scroll-clipped points.

- **Actual root cause — snap-on grab-point quantisation** (pre-dates zoom;
  zoom made it *look* worse because the hop scales with the zoom ratio —
  that was the "ratio" the user sensed; the ruler itself is irrelevant, the
  CTM absorbs the gutter): `drag.start` came from `getPoint(e)` which
  **snaps the pointer to the grid**. Grabbing a shape 9px past a grid line
  and nudging 2px applied a full-cell delta in a direction the mouse never
  travelled — reproduced: 2px nudge → 0.5cm diagonal teleport. Same flaw in
  resize: the grabbed handle's snapped pointer position replaced the corner,
  so grab-offset changed the size.
- **Fix (CanvasStage.tsx), the draw.io/Figma convention:** drags start from
  `getRawPoint` (clamped, unsnapped); deltas are raw; with snap on the grid
  is applied to the shape's *resulting position*, not the pointer:
  - move: `dx = snapToGrid(refCorner.x + rawDx) - refCorner.x` where
    `refCorner` = bbox origin of the grabbed shape (whole multi-selection
    moves rigidly; corner lands on grid; a click can never displace).
  - resize: new `corner0` field on the resize Drag = dragged handle's world
    position at grab; moved corner = `corner0 + rawDelta`, then snapped.
  - rotate uses the raw pointer (angle snap is separate).
- Verified headless-Chrome, production build: 2px nudge now at most aligns
  the corner to the nearest grid point (≤ half cell, no teleport); +100px
  snap drag = exactly +2.5cm in single-cell hops; 1px resize nudge = 0.000cm
  size change; snap resize +100px = exactly +2.5cm; snap-off drags stay
  pixel-perfect at 51–244% and DPR 1/1.25/2; wheel-mid-drag fix unregressed.

## 2026-08-19 — Fix: shapes jumped during move/resize (wheel scroll mid-drag)

User report after the zoom feature: moving or resizing a shape "sometimes
jumps to another position".

- **Root cause (reproduced, not guessed):** the zoom work made the canvas
  viewport scrollable. A wheel/trackpad scroll arriving *during* a drag —
  a grazed wheel, or two-finger inertia left over from a pan — scrolls the
  canvas under the stationary cursor. Drag positions are client coords mapped
  through the SVG CTM, so the shift reads as pointer movement: in the repro,
  a deltaY=150 wheel mid-drag teleported the shape 1.5 cm instantly. Resize
  uses the same `getPoint` path and jumped identically.
- **Fix (CanvasStage.tsx):** the native wheel listener now swallows *all*
  wheel events while `drag` or `startRef` is live (state mirrored into
  `dragStateRef`, because the native listener sees stale closures). The pan
  capture handler also refuses to start (middle-click or space) while another
  drag is active. Added `onPointerCancel={onUp}` so a browser-cancelled
  pointer can't leave `drag` latched with the shape following the bare cursor.
- Verified in headless Chrome: with the wheel fired mid-drag, move steps are a
  uniform 0.051 cm and resize steps 0.077 cm (before: 1.5 cm discontinuity);
  idle middle-drag pan still scrolls by exactly the dragged distance.
- **Testing gotcha for this app:** `page.$eval("pre", …)` grabs the *preview
  panel's* error `<pre>` ("pdflatex not found") once the render debounce
  fires — select the code panel by filtering for `tikzpicture` content.
  Also: with snap on, drags legitimately step by 0.5 cm (the grid), which a
  naive "jump detector" flags — disable snap when measuring smoothness.

## 2026-08-19 — Canvas zoom & pan

Asked for zoom in / zoom out on the canvas.

- **Key decision: zoom scales the rendered `<svg>` element, not the viewBox.**
  The viewBox stays `-M -M (CANVAS_W+M) (CANVAS_H+M)`; a wrapper div is sized to
  `viewBox × zoom` CSS px and the svg fills it. Because `clientToCanvas` already
  goes through `svg.getScreenCTM()`, **every** pointer path (draw, drag, resize,
  rotate, marquee, ports, hit-tests) stayed correct with no maths changes. The
  alternative — panning/scaling the viewBox — would have meant auditing all of
  it. Nothing downstream (model, TikZ output, coords.ts) is zoom-aware.
- **Panning is just scrolling** the wrapping viewport: middle-drag, or space +
  drag, both implemented by writing `scrollLeft/scrollTop`. Plain wheel scrolls
  natively; **Ctrl/Cmd + wheel zooms**.
- **Gotcha — passive wheel listener:** React's synthetic `onWheel` is passive,
  so `preventDefault()` there does *not* stop the browser's own page zoom. The
  wheel handler must be a native listener added with `{ passive: false }`.
- **Gotcha — centring vs. overflow:** `justify-content/align-items: center` puts
  the overflow out of scroll reach once the page is bigger than the viewport.
  Used `margin: auto` on the flex child instead, which centres while small and
  collapses to 0 when overflowing.
- **Cursor-anchored zoom** records the content fraction under the cursor, then
  corrects `scrollLeft/Top` in a `useLayoutEffect` on `zoom` (after layout,
  before paint, so there is no visible jump). Buttons/keys anchor on the
  viewport centre instead. Measured drift: **1 px**.
- **Screen-space vs model-space sizes.** Handles are authored in viewBox units,
  so they are divided by zoom (`hz()`) and given `vector-effect:
  non-scaling-stroke`; otherwise they'd balloon when zoomed in. The same applies
  to *pick tolerances* — connector/polygon hit tests (10), connect margin (16),
  polygon-close (10) and duplicate-click (6) are all screen distances and are
  now `hz()`-scaled. `ALIGN = 8` was left alone: aligning a bend to a neighbour
  is a model-space relationship, not a pick.
- Pan takes priority via `onPointerDownCapture` + `stopPropagation` on the
  viewport, so space-drag never draws even with a shape tool active.
- Zoom lives in the store (`zoom`, `setZoom`, `zoomBy`; `MIN_ZOOM` 0.1 /
  `MAX_ZOOM` 8 / `clampZoom` in `coords.ts`). Deliberately **not persisted** —
  `saveState` still stores only projects/templates.
- UI: floating `ZoomBar` (−, %, +, Fit) bottom-right. Shortcuts: `Ctrl +`,
  `Ctrl -`, `Ctrl 0` (100%) in `Editor.tsx`; `Ctrl 9` (fit) lives in
  `CanvasStage` because only it knows the viewport size.

Verified in headless Chrome (puppeteer, scratchpad scripts) against the
production build: shapes render exactly proportionally (159×120 px at 100% →
390×293 at 244% → 52×39 at 33%); **clicking a shape's rendered centre selects it
at 33/64/100/156/244%**, proving hit-testing and rendering agree; middle-drag and
space-drag pan by exactly the dragged distance; space-drag with the Rect tool
active creates nothing; plain wheel scrolls without changing zoom; Fit lands the
page inside the viewport. `npm run typecheck` and `npm run build` clean.
Note: the repo has **no test runner** — these were throwaway scripts, so a
regression here would not be caught by CI. Adding Playwright would be worthwhile.

## 2026-08-19 — Raster trace quality overhaul (`importRaster.ts`)

PNG/JPG tracing looked "really bad" (SVG import was fine): jagged staircase
edges, blocky outlines at the default detail, and JPEG noise / anti-alias halos
turning into speckle shapes and ragged colour boundaries. Five fixes, all in
`src/lib/importRaster.ts`:

- **Staircase smoothing (`smoothRing`)** — the crack-followed contour is
  replaced by its edge midpoints *before* Douglas-Peucker. 45° stairs become
  true diagonals (a synthetic diamond now traces to exactly 4 vertices at 45.0°,
  previously a staircase); real corners round by only half a work px.
- **Tolerance now in canvas px, not work px** — old eps was `0.5+(1-detail)*5.5`
  at work resolution, i.e. ~3.25 px *before* the ~1.5–2.6× upscale onto the
  canvas → chunky chords at the default. New: `max(0.5, (0.5+(1-detail)²*6)/sx)`
  so the detail slider means the same thing regardless of image size; the 0.5
  work-px floor lets DP collapse the smoothed staircase into clean diagonals.
- **`despeckle`** (2 majority-vote passes on the quantised index map) — a pixel
  with ≤1 same-colour 8-neighbour is noise/halo and snaps to the local mode.
  Continuous 1px lines have 2 allies and survive; only open line *ends* erode
  (by ≤2 px). This is the deliberate trade-off.
- **`mergeClose`** (coverage-weighted, threshold **32** Euclidean RGB, never
  below 2 colours) — median cut on a JPEG splits one flat area into
  near-identical colours whose boundary traces as garbage. Threshold 24 was too
  tight in testing (±15/channel noise → distance ~26 survived, 332 junk shapes);
  32 collapsed the same test to 2 shapes. `medianCut` now returns
  `{color,count}` entries to make the weighting possible.
- **Transparent-PNG background guard** — only drop the border-dominant colour as
  background if it covers ≥25% of the border samples; otherwise a logo touching
  the edge of a transparent PNG lost body parts.
- Also: `WORK_MAX` 400→512, `imageSmoothingQuality="high"` in `decode`.

Verified with synthetic tests (`tsx`, pure `traceRgba`): clean AA disc → 32
verts, radius deviation ~1 work px; noisy disc → 1 shape, 136 speckles dropped;
transparent-bg logo touching border → kept; 512² photo-like worst case 231 ms
(fine behind the dialog's 150 ms debounce). `npm run typecheck` clean. No
covering unit tests exist yet — `traceRgba` is pure and testable, a vitest
suite over these synthetic cases would be a good follow-up.

## 2026-08-19 — Adjustable label size (`Style.fontSize`) + measured text metrics

Follow-up to the SVG import fixes: labels all rendered at one hard-coded size,
so imported headings and table cells collapsed together. Asked for, with "text
proportions should be decent".

- **`Style.fontSize?: number`** — label size in **pt**, deliberately the same
  unit as `lineWidth` because both become TikZ dimensions (geometry stays px).
  Optional, and **absent from `DEFAULT_STYLE`**: that keeps drawings saved before
  today valid, keeps their JSON unchanged, and avoids a `types.ts` → `text.ts`
  circular import. `fontPtOf` supplies `DEFAULT_FONT_PT`.
- **`DEFAULT_FONT_PT = 11.4`** — picked so it renders at the 16 canvas px the app
  used before, i.e. existing drawings look identical.
- **`src/lib/text.ts` (new)** — the one place that knows about label metrics:
  `fontPtOf` / `fontPxOf`, `textWidthPx`, `labelHalfSize`, `CANVAS_FONT_FAMILY`.
  - **Must stay server-safe**: the render API pulls in generateTikz → geometry →
    text.ts, so the DOM is only touched lazily inside `textWidthPx` (cached
    `getContext("2d")`, `null` when unavailable) and never at module load.
    Verified by POSTing to `/api/render` on a running dev server.
  - `textWidthPx` measures with the **real font** when a canvas exists and falls
    back to 0.5em/char otherwise. Measuring is what makes the importer's
    anchor→centre conversion land correctly; the per-character guess drifts badly
    on all-narrow ("illli") or all-wide ("WWW") text. The fallback is the path
    jsdom tests exercise, so both branches stay covered.
- **Threaded through**: `generateTikz` (`font=\fontsize{pt}{1.2pt}\selectfont`),
  `CanvasStage` (two hard-coded `fontSize={16}` sites + the node bbox),
  `PropertiesPanel` ("Text size" in pt, shown for every TEXTABLE kind),
  `transformShape` (scales with the drawing, like `lineWidth`), and `importSvg`
  (`pxToPt(sourceSize × ctmScale)`).
- **`font=` is now always emitted.** Previously the canvas drew ~16 px text while
  LaTeX used the document's 10pt, so the preview never quite matched the editor.
  Costs some verbosity in the generated TikZ; buys WYSIWYG.
- **`importTikz` learned `font=`** (`\fontsize{…}` → pt), otherwise a `.tex`
  export/re-import silently reset every label to the default. Relative size
  commands (`\large`, `\small`) carry no absolute value and are ignored on
  purpose rather than guessed at.
- **Node hit box is no longer a fixed 24×12** — `NODE_HALF` became
  `nodeHalf(s)`, derived from the measured label. The old constant meant a large
  heading was unclickable past its first couple of characters while a tiny label
  grabbed clicks from far away; the selection rectangle now hugs the text too.
- **Result on the sample**: five distinct label sizes (8.0 / 6.4 / 5.44 / 5.12 /
  4.8 pt) instead of one, with the source's ratios intact (25/15 px = 8/4.8 pt),
  so the table cells fit their columns and headings read as headings.
  - Sizes look small in absolute pt only because the 1600×900 artwork is scaled
    to 0.45 to fit the canvas — that is the same factor the geometry gets.
  - The one still-tight cell ("10.0.0.1" next to "51514") **overlaps in the
    original SVG too** — 52 px columns holding ~55 px of 15 px Arial. Faithful,
    not a bug.
- `sizeOf()` returning `null` for `node` is intentional (nodes are not
  box-resizable) and unrelated to label metrics — noted because it looks like a
  gap when writing tests against it.
- **Verified**: **130 checks across four suites, all passing** — 26 new font
  checks (fallback defaults, px→pt per label, CTM scaling, fit scaling, TikZ
  emission, `.tex` round-trip incl. `\large` being ignored, metric fallback,
  hit-box growth and both hit-test directions) plus the existing 36 raster / 44
  SVG / 24 escaping checks. The sample compiles end-to-end through `pdflatex` +
  `dvisvgm` with all five sizes present, `/api/render` returns a valid SVG for a
  sized+escaped node, and `tsc --noEmit` + `next build` are clean.

---

## 2026-08-19 — Fix SVG import: stroke weight, curves, stylesheets, text anchors

Reported against `samples/structured_traffic_pipeline.svg` (1600×900, icon- and
text-heavy): after importing, "the strokes look extremely ugly and thick". Five
real defects, four in the importer and one that blocked rendering outright.

- **1. Stroke width was never converted or scaled** — the headline bug, two
  compounding mistakes:
  - `styleOf` assigned the SVG `stroke-width` (user units, i.e. px) straight to
    `style.lineWidth`, which is **TeX pt**. 1 px is only ~0.71 pt, so every
    stroke was ~1.4× too heavy before anything else happened.
  - `fitIntoCanvas` → `transformShape` scaled geometry (`r`, `rx`, `ry`, every
    point) but **left `style.lineWidth` untouched**. Fitting 1600×900 into the
    canvas uses scale 0.45, so a 4 px outline stayed 4 pt while the icon it
    traced shrank by more than half.
  - Combined: 4 px came out as **4 pt instead of 1.28 pt — 3.1× too thick**, and
    ~20 px icons filled in solid. Fixed with `pxToPt`/`ptToPx` in `coords.ts`
    plus lineWidth scaling in `transformShape` (also benefits `.tex` import).
- **2. Bézier curves were thrown away** — `parsePath` skipped the control points
  and kept only each segment's endpoint, so a shield became a pentagon. Rewrote
  the path parser: `pathScanner` reads numbers on demand and curves are
  *flattened* (`flattenCubic`/`flattenQuad`/`flattenArc`, ~1 segment per 4 user
  units, 3..48 per curve). `A` now works too, via the spec's endpoint→centre
  parameterisation (F.6.5) — including under-sized radii, which get scaled up.
  - **Why on-demand scanning**: minified arcs pack their flags without
    separators (`a5 5 0 0110 10`). A tokenise-everything-first pass reads `0110`
    as one number; only a reader that knows it wants a single 0-or-1 splits it.
  - `S`/`T` now reflect the previous control point instead of being treated as
    plain lineto.
- **3. `<style>` blocks were ignored entirely** — this file (like most exporter
  output) styles by class, so text came out in the default blue instead of
  `#111`. Added a small CSS resolver: flat `tag` / `.class` / `#id` selectors,
  comma lists, later rule wins. Precedence per element is inline `style` → sheet
  rule → presentation attribute, then inherit from the parent.
- **4. `text-anchor` / baseline were ignored** — SVG starts text to the *right*
  of `x` and anchors it on the baseline; our node centres on its point. Labels
  were therefore pulled half their width left, on top of the icons they
  described. Now offset by anchor and by ~0.36em vertically (skipped when
  `dominant-baseline` is middle/central). Text width is **estimated** at
  0.5em/char — no metrics exist at import time.
  - **Gotcha (found via a wrong bbox)**: the `font:` shorthand's size is the
    number *with a unit*. Matching the first number read `font:700 25px Arial`
    as **700px**, inflating offsets 28× and pushing text to x=3392 in a
    1600-wide document. `cssLength` now requires the unit in the shorthand and
    clamps to 1..400px.
- **5. Label text was never escaped for LaTeX** (pre-existing, in
  `generateTikz`) — a single `&` in "Observation &" aborts the compile with
  *Misplaced alignment tab character*, so **nothing rendered at all**. Added
  `escapeTexText`, applied at both node-emitting sites.
  - Balanced `$…$` spans pass through unescaped so labels can still hold real
    math (`$x^2$`, `$lpha$`); an unpaired `$` is escaped like anything else.
  - `importTikz` gained the inverse `unescapeTexText` so generate → re-import
    still round-trips to the text the user typed.
  - **This exposed another pre-existing bug**: `nodeToShape` grabbed its label
    with `lastIndexOf("{")`, which mangles any label containing a brace —
    `{\{ "a":1 \}}` came back as `"a":1 }` and `\textasciitilde{}` swallowed
    everything before its `{}`. Replaced with `braceBody`, a balanced scan that
    honours escaped braces; `tokenizePath`'s brace token now allows one level of
    nesting for the same reason.
- **⚠️ Existing imports stay wrong** — bad widths/geometry are baked into saved
  shapes. **Re-open the SVG** to get a corrected drawing.
- **Known limitation, now the main remaining gap**: `Style` has no font size, so
  every label renders at the canvas's fixed 16 px and TikZ's default size. In
  this sample the 15 px table cells therefore overlap ("src\_ipsportdport"),
  while the 25 px titles are undersized. Fixing it means adding `fontSize` to
  `Style` and threading it through `generateTikz` (`font=ontsize{..}{..}
  \selectfont`), `CanvasStage` (two hard-coded `fontSize={16}`),
  `PropertiesPanel`, and `transformShape` (must scale with the drawing) — a data
  model change affecting every drawing, not just imports, so it was left for an
  explicit decision.
- Also unresolved by design: no gradients, patterns, clip paths, `<use>`,
  `<image>`, `<tspan>` (only the concatenated text), or per-glyph positioning.
- **Verified**: three suites, **104 checks, all passing** — 44 new SVG-import
  checks (px→pt, fit scaling, cubic/quadratic/arc flattening with computed
  apexes, packed arc flags, largeArc/sweep sign logic, CSS class + tag
  selectors, `font:` shorthand, all three anchors, baseline, plus regressions
  for the 2026-07-02 text-fill fix, transforms and primitives), 24 escaping /
  round-trip checks, and the 36 raster-trace checks still green. The sample now
  imports to 194 shapes with 4 px strokes at 1.28 pt and compiles end-to-end
  through `pdflatex` + `dvisvgm` (it failed outright before). `tsc --noEmit` and
  `next build` clean.
  - **A robustness test earned its keep**: `d="zzz 1 2 3"` hung the new parser
    and killed the process with an out-of-memory error. `Z` takes no arguments,
    so it can't repeat — the loop re-ran it forever without consuming a number.
    Fixed by clearing `cmd` after `Z`.

---

## 2026-08-19 — Open PNG / JPG / WebP: place as image, or trace into shapes

- **Ask**: "SVG can be opened as editable shapes — can PNG/JPG do the same?"
  Answer: not directly. SVG import works because SVG *is* geometry; a bitmap is
  a pixel grid with nothing to read. So two paths were added, and the user picks
  per file.
- **`src/lib/importRaster.ts` (new)** — vectoriser. Pipeline: median-cut colour
  quantisation (4-bit histogram, ≤4096 buckets) → 4-connected region labelling →
  **crack following** on the pixel-corner lattice (exact staircase outline, no
  diagonal shortcuts) → Douglas-Peucker → one closed `polygon` shape per region.
  - `traceRgba(data, w, h, opts, target)` is **pure** (no DOM) and unit-testable;
    `traceImage(dataUrl, opts)` adds `<img>`+canvas decoding at a 400px working
    size.
  - **Holes without even-odd fills**: shapes are emitted **largest area first**.
    The white counter inside an "O" is its own region of the background colour
    and, being smaller, is painted *after* the ring — works on canvas AND in the
    generated TikZ because both draw in array order. Verified in the compiled
    SVG: fills come out navy → orange → teal → **#fff (the hole)** → navy.
  - Options: `colors` (2..16), `detail` (0..1 → DP epsilon 0.5..6), `minArea`
    (speckle cutoff), `dropBackground` (drops the border-touching region whose
    colour dominates the border pixels).
  - **Gotcha (fixed during development)**: median cut degenerated when the
    weighted median fell in the last bucket — the right half came out empty and
    the split loop broke early, leaving a 1-colour palette and **zero** traced
    shapes. `cut` is now clamped to `keys.length - 2`.
  - **Gotcha (fixed)**: a single global DP epsilon erased small regions at low
    detail. Epsilon is now also capped per region at `0.25 × min(bbox w,h)`.
  - Caps so a photo can't produce an unusable doc: 400 shapes, 500 vertices per
    shape, both reported via `dropped` / `vertices`.
- **`src/lib/files.ts`** — `openProjectFromFile` now accepts `.png/.jpg/.jpeg/
  .webp`. Bitmaps come back as `{ kind: "raster", name, file }` — **undecided**,
  because place-vs-trace is a user choice, not something the parser can infer.
  `OpenResult` is now a discriminated union. Raster detection matches the
  **filename first**: `image/svg+xml` also starts with `image/` and must stay on
  the vector path.
- **`src/components/OpenImageDialog.tsx` (new)** — place-or-trace chooser with a
  **live trace preview** beside the original (debounced 150 ms, stale runs
  discarded via a run counter). Shows shape/point counts, the detected palette,
  and warns when nothing was found or the geometry is heavy (>4000 points).
  Reused by the Image Library's **⤳** button to trace an already-uploaded asset
  into the current drawing.
- **`src/lib/images.ts`** — extracted `imageShapeFor(asset, maxDim, at)` (the
  store's `insertImageShape` now reuses it instead of duplicating the maths) plus
  `FILL_CANVAS_DIM` for "open as its own drawing".
- **Unchanged on purpose**: dropping an image on the canvas still places it
  straight away — that fast path predates this and the ⤳ button covers tracing.
- **Known limits**: anti-aliased edges become thin blended-colour slivers once
  `colors` is raised (visible at 6+); `minArea` is the remedy, and the default
  of 4 colours / 16px is clean. Photos are colour blobs by nature — the dialog
  says so and steers to "Place as image".
- **Verified**: 36/36 unit tests on `traceRgba` (exact corner rings for square /
  L-shape / ring+hole, 4-connectivity, transparency, minArea, detail, caps,
  placement); a synthetic 480×360 logo downscaled to 400×300 (anti-aliased)
  traced to 5 shapes / 39 points in ~25 ms with correct palette and hole, then
  compiled end-to-end through `pdflatex` + `dvisvgm --pdf --no-fonts`. `tsc
  --noEmit` and `next build` clean; dev server serves the page with no errors.
  Browser-driven UI testing wasn't possible (both entry points need a native
  file picker, and the Browser MCP extension was not connected).

---

## 2026-07-02 — Fix: SVG-imported text became solid boxes ("ô đen") in preview

- **Bug**: after importing an SVG, every text node rendered as a **solid filled
  rectangle** hiding the text. NOT a font/Unicode/dvisvgm issue (server SVG was
  fine; resvg rasterised it as text). Diagnosed by dumping the exact
  browser→server document: each node was `\node[text=C, fill=C, draw=C]{…}` —
  **fill == text color**, so the node box was painted the same color as its own
  text → text invisible inside a solid box.
- **Root cause** (`importSvg.ts`, `<text>` case): SVG `fill` on a `<text>` is the
  **glyph color**, not a background. `styleOf` correctly folds it into `stroke`
  (node text color) but ALSO left `style.fill` = that color, so generateTikz
  emitted a filled node box.
- **Fix**: text → node now forces `style.fill = "none"` (transparent node bg),
  keeping `stroke` as the text color. Real shapes (rect/etc.) keep their SVG
  fill — the override is text-only.
- **⚠️ Existing imports stay broken** (bad fill is baked into the saved shapes):
  **re-open the SVG** to get a corrected drawing. A node legitimately CAN have a
  fill (colored label bg), so we don't strip it retroactively/in generateTikz.
- Verified: import test (text node → `fill:none`, stroke keeps `#712b13`; rect
  fill preserved). `tsc` + `next build` clean. Removed the temp debug dumps that
  were added to `route.ts` for diagnosis.

---

## 2026-07-02 — Fix: Unicode/Vietnamese text render error (LaTeX)

- **Bug**: nodes with non-ASCII text (e.g. Vietnamese "So sánh với ngưỡng") made
  the render fail — `! LaTeX Error: Unicode character ớ (U+1EDB) not set up for
  use with LaTeX`, no PDF produced.
- **Cause**: `fullDocument` loaded no input/font encoding, so pdfLaTeX couldn't
  map Unicode characters.
- **Fix** (`generateTikz.ts` `fullDocument`): engine-aware Unicode setup via
  `iftex`. pdfLaTeX → `\usepackage[utf8]{inputenc}` + `[T1,T5]{fontenc}` (T5 =
  Vietnamese) + `lmodern`; XeLaTeX/LuaLaTeX → `fontspec` (full Unicode). No
  engine change, so the default pdflatex path keeps working.
- **Verified** end-to-end on the local toolchain: pdflatex compiles the
  Vietnamese sample (exit 0, PDF), dvisvgm → SVG; rasterised the SVG with resvg
  → text (incl. "ớ", en-dash "–", arrow "→") renders correctly, no tofu boxes.
  `tsc` clean.
- **⚠️ Gotcha (tofu boxes on first render)**: on MiKTeX the *first* render after
  this change draws **filled boxes** instead of glyphs, because MiKTeX is still
  auto-installing the newly-required `fontenc T5` / `lmodern` outline fonts and
  dvisvgm can't trace them yet. Once the packages finish installing, a fresh
  render is clean. Also note the **client only re-renders when the TikZ `code`
  string changes** (Editor effect dep), NOT when server-side `fullDocument`
  changes — so after editing render code you must nudge the drawing (or restart
  dev) to trigger a new compile; the preview otherwise shows the stale result.
- Note: covers Latin+Vietnamese under pdflatex; for other scripts (CJK, etc.)
  compile with lua/xelatex (set `TIKDRAWER_LATEX_ENGINE`), which fontspec covers.
  (LuaLaTeX failed to launch on this machine's MiKTeX, so pdflatex+T5 is the
  reliable default here.)

---

## 2026-07-02 — Open .tex (tikzpicture) / .svg as editable shapes (reverse import)

- **New feature**: the "📂 Open file" button now also opens **`.tex`/`.tikz`**
  files containing a `tikzpicture` and **`.svg`** files, parsing them into
  editable canvas shapes (a new drawing). Native `.tikz.json` still opens as
  before.
- **⚠️ Deliberate deviation from AGENTS.md**: this reverses the documented
  one-way data flow (`model → TikZ → render`, "do not parse TikZ back"). The
  user explicitly asked for editable import of both formats, so we now parse
  TikZ/SVG **into** the model. It's intentionally **lossy** — only the
  primitives this app emits + common variants are understood.
- **New modules**:
  - `src/lib/importTikz.ts` — `importTikz(src)`: extracts the tikzpicture body,
    strips comments, splits on top-level `;`, parses `\draw/\path/\fill/\filldraw`
    (line, rect, roundrect via `rounded corners`, circle, ellipse, polygon via
    `-- … -- cycle`, curved paths `.. controls .. and ..` → a free **curved
    connector**) and `\node`. Parses options (`draw=`/bare color, `fill=`,
    `line width`, thin/thick presets, dashed/dotted, `opacity`, arrow tips) and
    colors (`{rgb,255:…}`, named, `#hex`). Lengths honor cm/mm/pt/bp/in/px.
  - `src/lib/importSvg.ts` — `importSvg(src)` (browser-only, DOMParser): walks
    line/rect/circle/ellipse/polygon/polyline/path/text, applying element+ancestor
    **transforms** (translate/scale/rotate/matrix/skew). Axis-aligned transforms
    keep native kinds; rotated/skewed rects become polygons. Paths keep segment
    **endpoints** (curve control points dropped). Skips `defs/symbol/clipPath/mask`.
- **coords.ts**: added inverse conversions `cmToPxX`/`cmToPxY`/`cmToLen` (kept in
  the one coordinate module, per CLAUDE.md).
- **fitIntoCanvas** (in importTikz): if an import lands outside the 800×600
  canvas it's uniformly scaled + translated to fit (40px margin); in-bounds
  drawings are left exact so **round-trips are faithful**.
- **files.ts**: `openProjectFromFile` broadened to accept .json/.tex/.tikz/.svg;
  `parse(text, filename)` detects format by extension then by content sniff.
  Returns a `kind`; a file **handle is remembered only for `.json`** so Ctrl+S
  won't overwrite an imported .tex/.svg with JSON (imported docs stay "Unsaved"
  → next Save writes a fresh `.tikz.json`). ProjectBar alerts if nothing parsed.
- **Verified**: `tsc` + `next build` clean. Round-trip logic test
  (generateTikz → importTikz) **39/39**; jsdom SVG parser test **21/21**
  (primitives, styles, group transform, out-of-bounds fit).
- **Known limits**: no reverse of rotation-in-TikZ (`rotate around=`), diamonds
  import as polygons, cylinders/images not imported, dvisvgm glyph-path SVGs
  import as many polygons (not text). Fine for the intended hand-authored files.

---

## 2026-06-26 — Dynamic (floating) connector anchors

- `attach: "auto"` is now a **dynamic/floating** anchor: it snaps to the
  **centre of the side facing the next point** (other end or first/last
  waypoint) via `nearestCardinalSide` + `sidePoint`, instead of an arbitrary
  boundary point. So dragging the route (or moving a shape) makes the anchor
  hop to the appropriate edge (top→right→…), like draw.io floating connections.
- Tool X creates auto/auto (dynamic by default); set From/To = "Auto" in the
  panel to make a port-anchored end dynamic, or pick a named side to fix it.
- `tsc` + `next build` clean; logic test: auto picks E/N/S/W by route direction.

---

## 2026-06-26 — Ports always include corners+mids; Anchor-tool hover marker

- **Guaranteed ports**: `portsOf` now forces an **even** count per box edge (so
  corner t=0 AND mid t=0.5 are always present → the required 4 corners + 4
  edge-midpoints), and a **multiple of 8** around circle/ellipse (N/S/E/W + 4
  diagonals always present); extra points fill in for larger shapes. (Removed
  `clampInt`.) Logic test confirmed across sizes.
- **Anchor-tool hover**: hovering a connector/polygon with the Anchor tool now
  shows a blue "+" marker at the exact point a bend/vertex would be added
  (`anchorHover`, set in `onMove`; hit-tests return the projected world point so
  the inserted point snaps onto the line). Cleared on tool change.
- `tsc` + `next build` clean.

---

## 2026-06-26 — Anchor tool (A) + Shift-drag segment + polygon vertex editing

- New **Anchor tool (A)** next to Select. Click a **connector** to add a bend
  (`connectorHitTest` → `addWaypoint`); click a **polygon** edge to add a vertex
  (`polygonHitTest` → `addPolygonVertex`, rotation-aware, local coords). Replaces
  the old Shift-"+" add affordance (removed `shiftHeld`/`addMarker` + midpoint
  dots).
- **Select-tool drag mapping** (as requested): default drag of a square handle
  = move that anchor/vertex; **Shift + drag a connector line** = move the whole
  segment under the cursor (`onShapeDown` → `onSegmentDown` via
  `nearestOnPolyline`).
- **Polygon = customizable shape**: a selected polygon now shows **vertex
  handles** (squares: drag to move with align-snap, double-click to remove —
  keeps ≥2 pts) instead of bbox resize handles; rotate still shown; panel
  Width/Height still scales. New drag type `vertex`.
- Non-polygon shapes aren't vertex-editable yet (would need convert-to-polygon).
- `tsc` + `next build` clean.

---

## 2026-06-26 — Distinguish point-move vs segment-move handles

- The two connector handle types were both blue and confusing. Now: **white
  square** = a bend point (drag to move that single point freely / double-click
  to remove); **blue dot** at a segment midpoint = drag to move the whole
  segment perpendicular. (Behaviour unchanged; just clearer visuals + hint.)
- `tsc` + `next build` clean.

---

## 2026-06-26 — Connector segment-drag (move whole segment, draw.io style)

- Dragging a segment's **midpoint dot** now **translates the whole segment
  perpendicular** (horizontal segment moves up/down, vertical moves left/right)
  instead of creating a single peak. New drag type `segment` with `{axis,li,ri,
  origWp}`. Port-end segments insert a stub waypoint at the port so the shape
  stays connected while the segment moves (`onSegmentDown` builds the new
  waypoints + the two indices to move). Cursor shows ns/ew-resize per axis.
- Shift + hover still shows the "+" to add a single bend; waypoint squares still
  drag (align-snap) / double-click to remove.
- `tsc` + `next build` clean.

---

## 2026-06-26 — Connector bends: align-snap + Shift-to-add (draw.io style)

- **Waypoint drag aligns instead of grid-snapping**: dragging a bend now uses
  raw coords + `alignSnap` (snaps x/y to a neighbouring point within 8px) so
  zig-zag segments line up with the shape's connection ports (the grid-snap was
  making them miss the ports). New bends also align on insert.
- **Add-point UX**: by default a selected connector shows subtle **reshape dots**
  at segment midpoints (drag to bend, draw.io-like). Holding **Shift** while
  hovering the line shows a **"+"** at the projected point (`nearestOnPolyline`)
  to insert a bend exactly there. Shift hides the midpoint dots.
- `tsc` + `next build` clean; `nearestOnPolyline` logic test (3 cases) passed.

---

## 2026-06-26 — Connector waypoints (multi-bend, zig-zag or smooth) + ports only when unselected

- **Connector model**: replaced the single quadratic `control` with
  `waypoints: Point[]` + `curved`. Straight = polyline through points (zig-zag);
  curved = smooth Catmull-Rom→cubic Bézier through the same points (geometry
  `connectorPoints`, `smoothControls`, `svgPath` shared by canvas + TikZ so the
  preview matches output). Auto-attached ends now face the first/last waypoint.
  Old saved connectors (no `waypoints`) default to a straight line.
- **Editing** (selected connector): endpoint handles, a square handle per
  waypoint (drag to move, double-click to remove), and a translucent “+” at each
  segment midpoint to insert a bend (inserts + starts dragging). Drag type
  `control` → `waypoint{index}`.
- **PropertiesPanel**: "Straighten curve" button → a **Curved** checkbox
  (smooth vs zig-zag).
- **Ports on hover only when nothing is selected** (`portShape` now also
  requires `selectedIds.length === 0`) — selecting a shape shows just
  resize/rotate handles, as requested.
- `tsc` + `next build` clean; 6-case logic test (waypoints, straight/curved
  paths, TikZ joins/control segments) passed.

---

## 2026-06-26 — Fix dvisvgm PDF→SVG in Docker (install mutool)

- On the Docker/Railway image `dvisvgm --pdf` failed: "either Ghostscript <
  10.01.0 or mutool is required" — the TeX Live image ships Ghostscript 10.07.1
  (too new for dvisvgm's PDF path) and no `mutool`.
- Fix: Dockerfile now `apt-get install`s **mupdf-tools** (provides `mutool`),
  which dvisvgm uses for PDF→SVG instead of Ghostscript. Rebuild/redeploy the
  image. (The separate "pdflatex not found" was Vercel before
  `TIKDRAWER_RENDER_URL` was set.)

---

## 2026-06-26 — Render-service auth token + Railway deploy docs

- Added optional `TIKDRAWER_RENDER_TOKEN`: the proxy (Vercel) sends it as
  `x-tikdrawer-token`; the compiling instance (Railway) rejects mismatches with
  403 — guards the public LaTeX compiler. Only enforced on the compile path
  (after the proxy branch), so same-origin browser→Vercel calls are unaffected.
- README "Deploying" rewritten with concrete Railway (Docker render service) +
  Vercel (UI proxy) steps and the env-var table. `tsc` + `next build` clean.

---

## 2026-06-26 — Vercel render: proxy to external TeX service

- **Problem**: on Vercel (no TeX Live) `/api/render` fails with "pdflatex not
  found" — serverless can't run/install LaTeX (the long-noted constraint).
- **Fix (opt-in proxy)**: `/api/render` now checks `TIKDRAWER_RENDER_URL`; when
  set it **forwards** the request body to that URL and returns the response.
  Unset → original local `pdflatex` path. Intended deploy: Docker image (bundled
  TeX Live) on Railway/Fly/Render as the renderer; Vercel UI sets
  `TIKDRAWER_RENDER_URL=https://<host>/api/render` to proxy server-side (no
  CORS). README "Deploying" section documents it.
- Alternative noted: deploy the whole Docker image (skip Vercel), or client-side
  TikZJax (limited packages / no `\includegraphics`). `tsc` + `next build` clean.

---

## 2026-06-24 — Fix: double-click to edit shape text

- **Bug**: double-clicking a shape didn't start text editing. Cause: the
  selecting click calls `setPointerCapture` on the `<svg>`, so the synthesized
  `dblclick` fires on the `<svg>`, not the shape `<g>` — the per-shape
  `onDoubleClick` never ran.
- **Fix**: handle double-click at the `<svg>` level — hit-test the point with
  `shapeAtPoint` and `startEdit` the topmost TEXTABLE shape (rotation-aware).
  Removed the dead per-`<g>` handler. `tsc` + `next build` clean.

---

## 2026-06-24 — Ports on hover (draw.io style)

- Connection ports no longer show for the *selected* shape; they show on
  **hover** in the select tool (`portShape` now derives from `hoverId`, not
  `selected`). So a selected shape shows just resize + rotate handles; hovering
  any connectable shape reveals its ports to drag a connector from. Idle-hover
  tracking now runs in the select tool too (was connector-only). Hidden while
  dragging/drafting.
- `tsc` + `next build` clean.

---

## 2026-06-24 — Drag-to-resize handles on canvas

- A selected resizable shape (select tool) now shows **8 resize handles**
  (corner + edge-mid squares, `RESIZE_HANDLES`) in addition to the rotate
  handle. Dragging a handle scales the shape, keeping the **opposite
  corner/edge fixed** — computed in the shape's local axes (`u`,`v` from its
  rotation) so it works correctly for rotated shapes. Honors the aspect-lock
  (chain) toggle. New `geometry.setBox(shape, center, w, h)` rebuilds the shape
  (box→p1/p2, circle→r, ellipse→rx/ry, polygon→scaled points).
- Handles overlap the connection ports at the 8 box positions (squares render
  on top → those become resize; in-between port circles still connect; tool X
  always connects anywhere).
- `tsc` + `next build` clean; 6-case logic test: fixed corner stays (rotated +
  unrotated), dragged corner follows cursor, aspect-lock keeps ratio, setBox
  circle/ellipse correct.

---

## 2026-06-24 — Shape text labels + resize (with aspect lock)

- **Text in any shape**: optional `text?` on rect/diamond/roundrect/cylinder/
  circle/ellipse/polygon (node already had it). Editable inline (double-click,
  generalized from node — centered `foreignObject` input via `shapeCenter`) and
  via a Text field in PropertiesPanel. Rendered centered on canvas; `generateTikz`
  appends a `\node[text=…]{...}` label (rotation-aware) after the shape, skipping
  node (its text is the node itself).
- **Resize (scale)**: `geometry.sizeOf` / `resizeShape` (box keeps its min
  corner; circle→r; ellipse→rx/ry; polygon scales its points). PropertiesPanel
  `SizeControls` = Width + Height inputs with a **chain (aspect-lock) toggle**
  (store `lockAspect` + `setLockAspect`); when locked, editing one dimension
  scales the other by the current ratio. Circle's height is linked to width.
  Replaced the image panel's manual W/H with the same control.
- `tsc` + `next build` clean; logic test confirmed sizeOf/resizeShape + that
  shape text emits a label node in the TikZ.

---

## 2026-06-24 — Drag & drop + copy/paste for images (and shapes)

- **Drag & drop onto canvas** (`CanvasStage`): drop OS image files → upload
  (downscale) + place at the drop point; or drag a thumbnail from the library
  (dataTransfer `application/x-tikdrawer-image`) → place at the drop point.
  Wrapper shows a blue tint while dragging. `getPoint` refactored to share
  `clientToCanvas` (CTM-based) so drop positions are exact.
- `insertImageShape(asset, at?)` now accepts a drop position (defaults to
  canvas center). `ImageLibrary` thumbnails are `draggable`.
- **Clipboard** (`Editor`): a `paste` listener inserts a clipboard **image**
  (e.g. a screenshot) at center; otherwise it pastes the **internal shape
  clipboard**. `Ctrl/Cmd+C` copies the current selection (deep clone in a ref);
  `Ctrl/Cmd+V` (paste event) duplicates them via `insertShapes` (fresh ids +
  offset). Both skip when focus is in a form field.
- `tsc` + `next build` clean.

---

## 2026-06-24 — Image library + image-as-shape

- **Image library** (managed separately from drawings): store `images:
  ImageAsset[]` (`{id,name,dataUrl,ext,w,h}`) with `addImage`/`deleteImage`/
  `setImages`/`insertImageShape`; persisted in its **own** localStorage key
  `tikdrawer:images:v1` (kept out of the projects entry; fails silently on
  quota). `src/lib/images.ts`: `fileToAsset` (reads + downscales to ≤1100px via
  canvas, PNG/JPEG) and `imageFileName` (stable `img_<id8>.<ext>`).
  `ImageLibrary.tsx` panel in the left sidebar: Upload, thumbnail grid, click to
  insert, hover-× to delete (deleting also removes shapes that used it).
- **Image shape** (`kind:"image"`, box-defined, references `imageId`): geometry
  treats it as a box (anchors/ports/rotation all work); renders as SVG
  `<image>` on canvas (placeholder box if the asset is missing); resize via
  Width/Height in PropertiesPanel (plus opacity + rotation).
- **TikZ + real preview**: `generateTikz(shapes, unit, imagesById)` emits
  `\node[inner sep=0]{\includegraphics[width,height]{img_<id8>.ext}}`. The render
  API now accepts an `images` array (validated `img_*.png|jpg`, ≤8MB, base64
  decoded) and **writes them into the compile dir** so `\includegraphics` finds
  them → the SVG preview shows the real image. Added `\usepackage{graphicx}`.
- Verified: `tsc` + `next build` clean; LaTeX pipeline embeds a real PNG →
  pdflatex + dvisvgm → SVG. NOTE: the first image render may trigger MiKTeX to
  auto-install graphics packages (graphicx/supp-pdf/epstopdf); libpng rejects
  malformed PNGs — browser-encoded uploads are always valid.

---

## 2026-06-24 — Adaptive ports + output unit (pt/mm/cm)

- **Adaptive connection ports**: `portsOf` now scales port count to size —
  `PORT_SPACING≈48px`, clamped `MIN_PER_EDGE=2` (→ 8 ports: corners + mids for
  small shapes) up to `MAX_PER_EDGE=6`; circle/ellipse `8..24` by circumference.
  Each edge sized independently. Verified: tiny rect → 8, large rect → more.
- **Output unit** (`cm` | `mm` | `pt`): `coords.ts` adds `Unit`, `UNIT_PER_CM`
  (pt = TeX point, 1cm=28.4527pt), `fmtUnit`. Store gains `unit` + `setUnit`.
  `generateTikz(shapes, unit)` formats every coordinate/length with the unit
  suffix (e.g. `(1cm,1cm)` / `(10mm,10mm)` / `(28.45pt,…)`); line width stays pt.
  Editor passes the unit; ProjectBar has a Unit dropdown; the ruler labels +
  corner show the chosen unit.
- `tsc` + `next build` clean; logic test confirmed unit conversion + adaptive
  port counts.

---

## 2026-06-24 — More connection ports (evenly distributed, 16)

- Replaced the 8 fixed side ports with `portsOf(shape)` — **16 ports evenly
  distributed around the outline**: box-like shapes subdivide each edge into 4
  (`PORTS_PER_EDGE`) → corners + edge midpoints + quarter points; circle/ellipse
  use 16 even angles. Rotation-aware. Each port carries `{point, attach}` where
  `attach` is the local angle that reproduces the point via `boundaryAtAngle`
  (verified: every port's attach round-trips to its point, incl. rotated).
- `nearestPort(shape, p)` snaps a port drag's drop end to the closest port.
- CanvasStage: ports render from `portsOf`; `onPortDown` takes a `PortPoint`;
  `endpointAtPort` uses `nearestPort`. Tool X stays free (any point).
- `tsc` + `next build` clean; 8-case port logic test passed.

---

## 2026-06-24 — Port drags snap target to the 8 ports

- Re-split connector attach behaviour by source (a `portDrag` ref):
  - **Port drag** (from a selected shape's 8 ports): the destination end now
    snaps to the **target's nearest of 8 ports** (`endpointAtPort` →
    `sideOf8` + `sidePoint`), instead of an arbitrary grid-quantized point.
  - **Connector tool (X)**: still attaches anywhere (`endpointAt`, arbitrary
    boundary angle).
- Restored `sideOf8` in geometry (rotation-aware via `angleOf`).
- `tsc` + `next build` clean.

---

## 2026-06-24 — Ctrl+S, unsaved status, coordinate ruler, easier connect

- **Ctrl/Cmd+S** saves the current drawing to its file (Editor keydown → a ref'd
  save closure; marks the project saved).
- **Unsaved status**: store gained `savedSig: Record<projectId,string>` +
  `markSaved`; `files.ts` exports `signatureOf(name, shapes)`. ProjectBar shows
  a badge — amber "● Unsaved" vs green "✓ Saved" — by comparing the current
  signature to the saved one. Save/open update it.
- **Coordinate ruler** (cm, TikZ frame: x→right, y→up with 0 at bottom-left):
  store `showRuler` (+ Ruler checkbox toggle). Canvas viewBox gets a top/left
  gutter (`RULER=24`) with tick marks + cm labels; drawing area stays white.
  `getPoint` rewritten to use `svg.getScreenCTM().inverse()` so it's correct
  regardless of viewBox/margin.
- **Connector improvements**:
  - `connectTarget` snaps to a shape under the cursor OR the nearest one within
    16px — no longer need to hit it exactly (fixes the "line lands a bit off").
  - **Hover highlight**: in the connector tool, the shape under the cursor (idle
    or mid-drag) gets a blue `drop-shadow` glow on its border so you can see
    where it'll attach.
  - Endpoints still attach at the exact boundary point in the cursor direction
    (any position).
- `tsc` + `next build` clean.

---

## 2026-06-24 — Save/open drawings to local files

- New `src/lib/files.ts`: save the current drawing to a real file on disk and
  open one back.
  - Uses the **File System Access API** (`showSaveFilePicker`/`showOpenFilePicker`)
    on Chromium browsers — picks a location and **overwrites the same file**
    on subsequent saves (handles remembered per project id, runtime only).
  - Falls back to a normal **download** / `<input type=file>` on other browsers.
  - File format: JSON `{ format:"tikdrawer", version:1, name, shapes }`,
    suggested name `<slug>.tikz.json`.
- `ProjectBar`: **💾 Save file**, **Save as…**, **📂 Open file** buttons.
  Opening creates a new project from the file and remembers its handle so later
  saves overwrite it.
- Note: this is separate from the existing localStorage autosave (which still
  holds projects/templates); files are explicit, portable, user-controlled.
- `tsc` + `next build` clean.

---

## 2026-06-24 — Diamond anchor fix + shape rotation

- **Diamond connection fix**: `anchorOnShape` (now `localAnchor`) intersects the
  ray with the **rhombus** (`|dx|/hw + |dy|/hh = 1`) instead of the bbox, so
  connection points sit on the diamond's actual edges (diagonals no longer fly
  to the bbox corners).
- **Shape rotation** added for rect / diamond / roundrect / cylinder / ellipse /
  node / polygon (optional `rotation` in degrees; circle/line/connector aren't
  rotatable).
  - geometry: `rotationOf`, `rotatePoint`; `anchorOnShape` wraps `localAnchor`
    (transform target into the shape's frame, solve, rotate back);
    `boundaryAtAngle` treats `attach` as a LOCAL angle and rotates the result to
    world (so attach points stick to the shape as it rotates); `angleOf` returns
    a local angle; `shapeContains` tests in the local frame.
  - Canvas: each shape's `<g>` gets `transform="rotate(deg cx cy)"` (rotates both
    render and hit area); a rotate handle (blue dot above the shape) with a
    `rotate` drag type; snaps to 15° when grid-snap is on.
  - TikZ: paths emit `rotate around={-deg:(cx,cy)}`, nodes emit `rotate=-deg`
    (negated because screen y-down/clockwise vs TikZ y-up/CCW).
  - PropertiesPanel: a Rotation° number input for rotatable shapes.
- **Verified**: `tsc` + `next build` clean; a 7-case Node logic test passed
  (diamond point on rhombus L1 edge; rotated east port lands at bottom; local
  attach sticks through rotation; rotation-aware hit-test; `rotate around`
  emitted); rotated TikZ (rect/diamond/cylinder/node) compiled to SVG.

---

## 2026-06-24 — Connectors: free attachment at any position (model refactor)

- **Problem**: connections only landed on fixed spots (8 ports / auto side), so
  "connect anywhere" wasn't possible.
- **Fix**: replaced `Endpoint.side: Side` with `Endpoint.attach: Attach`
  (`"auto"` | a **fixed angle in radians**). `attach` as a number = the boundary
  point in that direction → ANY position around the perimeter. `Side`/`SIDES_8`
  kept only for the 8 named port handles + templates.
  - geometry: `sideToAngle`, `boundaryAtAngle`, `angleOf`, `attachPoint`;
    `sidePoint` = `boundaryAtAngle(sideToAngle(side))`; `resolveConnector` uses
    `attachPoint`. Removed `sideOf8`.
  - CanvasStage: `endpointAt` now anchors at `angleOf(target, cursor)` — exact
    arbitrary point — for BOTH tool X and the moving end of a port drag (removed
    `connectMode`/`endpointAtPort`). Port drags fix only the *start* angle.
  - Bug fix: a stray click on a shape with tool X used to create a zero-length
    connector — `isValid` now needs two anchored ends OR drag distance > 6.
  - PropertiesPanel From/To dropdowns map `attach`↔named side, showing
    "Custom (free)" for arbitrary angles.
  - Backward compatible: old saved endpoints (no `attach`) resolve as `auto`.
- **Verified**: `tsc` + `next build` clean; a 9-case Node logic test
  (compiled lib → CJS) passed — arbitrary attach lands on boundary, endpoints
  follow moved shapes, free ends fixed, interiors clickable, angle round-trip;
  the generated TikZ compiled to SVG via pdflatex+dvisvgm.

---

## 2026-06-24 — Easier selection + 8 connection ports

- **Border-only shapes clickable**: `ShapeView` now renders closed shapes with a
  transparent (not `none`) fill so the interior captures clicks; open shapes
  (line / open polyline) get a fat transparent hit stroke (width 12).
- **8 connection ports**: `Side` extended to 8 (`n/s/e/w/ne/nw/se/sw`, plus
  `SIDES_8`). Selecting a connectable shape (Select tool) shows 8 port dots
  (`sidePoint` projects round shapes onto their boundary; box shapes use bbox
  corners/edges). Dragging a port starts a connector anchored at that exact side
  and, on drop, snaps the other end to the nearest of the target's 8 ports
  (`sideOf8`, `endpointAtPort`).
- **Tool X = arbitrary**: the connector tool now anchors with side `auto`
  (boundary toward the other end), i.e. free position — not snapped to a port.
  Connector-creation snap behaviour is chosen by `connectMode` ref
  ("auto" for tool X, "port" for port drags).
- `PropertiesPanel` From/To side dropdowns now list all 8 sides + auto.
- `tsc` + `next build` clean.

---

## 2026-06-24 — Preset shapes, polygon tool, multi-select + grouping

- **Preset shapes** (new kinds, box-defined like rect): `diamond` (TikZ path
  rhombus), `roundrect` (`rounded corners=4pt` rectangle), `cylinder` (emitted
  as a TikZ `\node[cylinder, shape border rotate=90, aspect=0.3, inner sep=0]`).
  Geometry (`halfExtents`/`shapeCenter`/`anchorOnShape`/`shapeContains`) treats
  them as boxes. Toolbar "Presets" group (D/U/Y keys). Verified all compile.
- **Polygon / freeform** (`polygon` kind: points[] + closed). Polygon tool:
  click to add vertices, click first vertex / Enter / double-click to finish,
  Esc cancels; live preview with vertex dots. TikZ: `(p0) -- … -- cycle`.
- **Multi-select + grouping** (bigger refactor):
  - Store: `selectedId` → `selectedIds: string[]`; added `toggleSelect`,
    `selectMany`, `deleteSelected`, `groupSelectionAsTemplate(name)` (saves
    selection as a user symbol/template), `insertShapes(shapes)` (clone+offset
    into current drawing). `shiftShape` helper for translation.
  - Canvas: rubber-band marquee (drag on empty canvas) selects by bbox overlap;
    Shift-click toggles; dragging a selected shape moves the whole group;
    connector handles only show for a single selected connector.
  - `PropertiesPanel`: multi-select view = "Group as symbol" + "Delete
    selection"; single-select = the usual editor.
  - `Editor`: Delete/Backspace deletes the selection (ignored in form fields).
  - `ProjectBar`: template dropdown now has **New from** (new drawing) and
    **Add to canvas** (insert as a block) for built-in + user symbols.
- `tsc` + `next build` clean.

---

## 2026-06-24 — Fix canvas text-selection + user-saved templates

- **Bug fix**: dragging on the canvas was highlighting (selecting) SVG text.
  Added `select-none` / `user-select:none` to the canvas wrapper + `<svg>`; the
  inline edit `<input>` re-enables `user-select:text` so editing still works.
- **User templates**: store gained `templates: UserTemplate[]` plus
  `saveTemplate(name)`, `deleteTemplate(id)`, `instantiateTemplate(id)`,
  `setTemplates`. `cloneShapes()` deep-copies + reassigns ids and remaps
  connector anchors so instances are independent. Persisted in localStorage
  (`PersistedState.templates`), loaded/saved in `Editor`.
- **ProjectBar** templates UI rebuilt: a Template `<select>` (Built-in optgroup +
  "My templates" optgroup) with **Insert** / **Delete** (user-only) / **Save as
  template** (prompts for a name) buttons.
- `tsc` + `next build` clean.
- **Pending clarification**: user asked for "custom shape" — meaning ambiguous
  (preset shapes like diamond/cylinder vs. polygon/freeform vs. group-as-symbol).
  Asked the user to choose before implementing.

---

## 2026-06-24 — Side anchors, grouped tools + shortcuts, templates, inline node edit

- **Connector side anchors**: `Endpoint` gained `side: Side`
  (`auto|n|s|e|w`). `geometry.ts` adds `sidePoint` / `sideOf` / `halfExtents`;
  `resolveConnector` honors the side (fixed west/east/north/south point) or
  falls back to `auto` (boundary toward the other end). Dropping a connector end
  on a shape snaps to the nearest side; `PropertiesPanel` has From/To side
  dropdowns. Bending still via the draggable control dot (quadratic→cubic in
  TikZ). Backward compatible: missing `side` treated as `auto`.
- **Toolbar grouped**: Select is its own group; "Shapes" (line/rect/circle/
  ellipse/text) and "Connect" (connector) groups; each button shows a shortcut
  badge. `TOOL_BY_KEY` exported for the handler.
- **Keyboard shortcuts** (in `Editor`, ignored while a field is focused):
  V select, L line, R rect, C circle, E ellipse, T text node, X connector;
  Ctrl/Cmd+Z/Y still undo/redo.
- **Templates**: `src/lib/templates.ts` (`TEMPLATES`: Flowchart vertical,
  Pipeline horizontal, Client⇄Server). Store action `newProjectFromShapes`
  creates a new drawing from a template; "+ Template…" dropdown in `ProjectBar`.
- **Inline node editing**: replaced `window.prompt` with a `foreignObject`
  `<input>` overlay. Node tool creates an empty node and edits immediately;
  double-click a node (Select tool) to edit; Enter/blur commits, Esc reverts,
  empty text deletes the node. `addShape` now keeps a caller-supplied id so the
  new node can be targeted for editing.
- `tsc` clean, `next build` clean.

---

## 2026-06-24 — Toolbar icons + kill-port dev script

- **Toolbar** now shows SVG **icons** instead of text labels (`ToolIcon` in
  `Toolbar.tsx`), laid out as a 3-column grid of square buttons; the text label +
  hint moved to `title`/`aria-label` for tooltips & a11y.
- **`npm run dev` kills the port first**: `dev` script now runs
  `node scripts/dev.mjs`, which frees `PORT` (default 3000) before starting
  `next dev`. Cross-platform: Windows uses `netstat`/`taskkill`, Unix uses
  `lsof`/`kill`. Verified it logs `[dev] killed PID … on port 3000` and takes
  over a busy port. Used a single-string `spawn("next dev", {shell:true})` to
  avoid Node's DEP0190 (args + shell) warning.
- `tsc` clean.

---

## 2026-06-24 — Connectors between shapes (attach + bend)

- New shape kind **`connector`** + tool. A connector has two `Endpoint`s
  (`{ point, anchor }`): when `anchor` holds a shape id its live position is the
  shape's boundary point toward the other end, so connectors **follow shapes**
  as they move. Free ends sit at `point`.
- New `src/lib/geometry.ts`: `shapeCenter`, `anchorOnShape` (rect/node box,
  circle, ellipse boundary intersection), `resolveConnector`, `connectorControl`,
  `quadToCubic`, `shapeContains`, `shapeAtPoint` (hit-test for anchoring).
- **Bending**: connector stores a quadratic control point + `curved` flag.
  SVG renders `Q` (quadratic); `generateTikz` converts it to a cubic
  (`quadToCubic`) so the TikZ `.. controls .. and .. ..` curve matches the
  on-screen preview exactly. Straight connectors emit `--`.
- `generateTikz` / `shapeToTikz` now take a `Map<id,Shape>` so connectors can
  resolve their anchored endpoints; verified both straight + curved compile.
- **Canvas UX** (`CanvasStage` rewritten): connector tool drags shape→shape (or
  free points); when selected, a connector shows two endpoint handles (drag to
  re-anchor / detach) and a blue control dot (drag to bend). A fat transparent
  hit-path makes thin lines easy to select. History records once per drag.
- `deleteShape` now also removes connectors attached to the deleted shape.
- `PropertiesPanel`: connectors show stroke/width/dashed/arrow/opacity (no
  fill), a "Straighten curve" button, and a bend hint; arrow control now applies
  to lines **and** connectors. Connectors default to arrow `->`.
- `tsc` clean, `next build` clean, render API verified with a curved connector.

---

## 2026-06-24 — Undo/redo + .tex export + storage clarification

- **Undo/redo** added to the Zustand store: per-current-project `past`/`future`
  snapshot stacks (limit 100), with `beginChange()` to snapshot before
  continuous interactions, plus `undo()`/`redo()`. History clears on project
  switch/new/delete/hydrate; `pushPast` dedupes consecutive identical snapshots.
  - Discrete actions (add/delete/clear, checkboxes, arrow select) auto-record.
  - Continuous interactions record once: canvas drag records lazily on first
    actual movement (`dragRecorded` ref); property color/number/range/text
    inputs record on `onFocus`.
  - Keyboard in `Editor`: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z =
    redo; ignored while focus is in INPUT/TEXTAREA/SELECT/contentEditable.
  - Undo/Redo buttons added to `ProjectBar` (disabled via `past`/`future` len).
- **.tex export**: already existed in `CodePanel` ("Download .tex" via
  `fullDocument`); improved the filename to a slug of the drawing name.
- **Storage location (answer to user's question):** drawings live in the
  browser's `localStorage` under key `tikdrawer:v1` — per browser+origin, not on
  server/disk, no cross-device sync. Defined in `src/lib/storage.ts`, wired in
  `Editor`.
- `tsc --noEmit` passes clean.

---

## 2026-06-24 — Initial full-stack scaffold (frontend + backend)

- Scaffolded a working Next.js 15 (App Router) + React 19 + TypeScript app with
  Tailwind v4. `npm run build` and `tsc --noEmit` both pass clean.
- **Frontend** (`src/components`): `Editor` (layout + persistence + debounced
  render), `CanvasStage` (SVG drawing: line/rect/circle/ellipse/node, grid +
  snap, select/move/delete), `Toolbar`, `ProjectBar`, `PropertiesPanel`,
  `CodePanel`, `PreviewPanel`.
- **Core lib** (`src/lib`): `types.ts`, `coords.ts` (px↔cm + Y-flip),
  `generateTikz.ts` (pure model→TikZ, inline `{rgb,255:...}` colors),
  `store.ts` (Zustand, multi-project state), `storage.ts` (localStorage).
- **Backend**: `POST /api/render` shells out to the host LaTeX toolchain
  (`pdflatex` → `dvisvgm --pdf --no-fonts`), returns SVG. shell-escape disabled,
  timeout + input-size limits.
- **Save mechanism**: multiple named drawings (projects) persisted in
  localStorage (`tikdrawer:v1`); switch / new / rename / delete via ProjectBar.
- **Docker**: `Dockerfile` (FROM `texlive/texlive` + Node 20) and
  `docker-compose.yml` for a bundled-TeX deployment needing no host LaTeX.
- **Decisions / deviations from AGENTS.md plan:**
  - Skipped shadcn/ui and CodeMirror for the MVP — plain Tailwind components and
    a `<pre>` code view to keep deps minimal. Revisit later.
  - Shape coordinates are stored in canvas px (origin top-left); the px→cm +
    Y-flip conversion happens only in `generateTikz` / `coords.ts`.
- **Gotcha (verified & fixed):** `dvisvgm` on Windows/MiKTeX fails with
  "Windows API error 87" when given an **absolute** `--output=` path. Fix: run
  dvisvgm with `cwd` = temp dir and **relative** filenames (`main.pdf` →
  default `main.svg`). End-to-end render verified: API returned valid SVG.
- **Verified present on this machine:** MiKTeX `pdflatex` + `dvisvgm`, so local
  render mode works out of the box here.
- **Next steps / ideas:** undo/redo, bezier/polygon tools, PNG/SVG export, a
  "current style" for new shapes, render result caching by TikZ hash.

---

## 2026-06-24 — Project kickoff & conventions

- Defined the project: **TikDrawer**, a web app to draw TikZ pictures visually
  and get generated LaTeX `tikzpicture` code with a live rendered preview.
- **Decisions locked in:**
  - Interaction: visual canvas drawing → generated TikZ (one-way data flow).
  - Rendering: server-side LaTeX (TeX Live + dvisvgm → SVG).
  - Stack: Next.js 15 + React + TypeScript, Tailwind + shadcn/ui, Zustand,
    CodeMirror 6.
- Created project docs: `AGENTS.md` (full context), `CLAUDE.md` (rules pointer),
  `MEMORY.md` (this log).
- **Convention established:** always update `MEMORY.md` when doing anything in
  the repo. Docs are written in English.
- **Open question / next step:** decide whether to start with client-only phases
  1–3 (bootstrap + canvas + generator, no Docker yet) or build the Docker render
  backend in parallel from the start.
- **Known risk:** server-side LaTeX needs Docker + TeX Live (~GBs); cannot deploy
  on plain Vercel serverless. Sandboxing user LaTeX (no shell-escape, timeouts,
  size limits) is mandatory.
