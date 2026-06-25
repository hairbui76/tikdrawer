# MEMORY.md

A running log of decisions, changes, and gotchas for the **TikDrawer** project.

> **Rule:** every action in this repo must add a dated entry here. Newest first.

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
