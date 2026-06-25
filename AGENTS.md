# AGENTS.md

Guidance for AI agents (and humans) working in the **TikDrawer** repository.

## What this project is

TikDrawer is a web application for **drawing TikZ pictures visually**. Users draw
shapes on a canvas (drag-and-drop, like a diagram editor); the app generates the
corresponding LaTeX `tikzpicture` code and renders a live preview by compiling
that code with a real LaTeX engine on the server.

## Core design decisions

- **Interaction model:** visual canvas → generated TikZ code (one-way:
  `model → TikZ code → rendered SVG`). The drawing is the source of truth; we do
  **not** parse TikZ back into the model.
- **Rendering:** server-side LaTeX (TeX Live + `dvisvgm`) producing SVG previews.
  This supports the full TikZ package ecosystem.
- **Stack:** Next.js 15 (App Router) + React + TypeScript, Tailwind CSS +
  shadcn/ui for UI, Zustand for state, CodeMirror 6 for showing generated code.
- **Canvas:** SVG-based rendering (Konva.js only if performance demands it),
  because SVG maps cleanly 1:1 onto TikZ primitives.

## Architecture (one-way data flow)

```
Canvas editor → TikzDoc (abstract shape tree, Zustand state)
              → generateTikz(doc): string  (pure function)
              → POST /api/render { tikz }
              → server: wrap in .tex → pdflatex/lualatex → dvisvgm → SVG
              → preview pane
```

### Coordinate system
- Model coordinates are in TikZ centimeters.
- Canvas is in pixels. Convert pixel ↔ cm with a scale factor and **flip the Y
  axis** (TikZ Y points up, screen Y points down). This conversion is a common
  source of bugs — keep it in one module and unit-test it.

## Code generator

`generateTikz(doc)` is a **pure function** mapping each shape to TikZ:
`line → \draw .. -- ..`, `rect → rectangle`, `circle → circle (r)`,
`node → \node at (x,y) {text}`, `bezier → .. controls .. and .. ..`.
Keep it side-effect free and well tested.

## Server rendering — security is mandatory

Running user-controlled LaTeX is dangerous. Always:
- Run the compiler inside a sandboxed Docker container (TeX Live).
- Disable shell-escape / `\write18`.
- Enforce timeouts and input-size limits.
- Cache results by hash of the TikZ source.

The render service requires Docker + TeX Live (~GBs) and **cannot run on plain
Vercel serverless** — host it separately (Railway / Fly.io / VPS).

## Implementation phases

1. Bootstrap: Next.js + TS + Tailwind + Zustand; 3-column layout
   (toolbar / canvas / code+preview).
2. Basic canvas drawing: SVG shapes (line/rect/circle), grid + snap-to-grid.
3. TikZ generator: model → code, shown live.
4. Backend render: Docker TeX Live + `/api/render` → SVG preview.
5. Properties panel + select/move/resize + undo/redo.
6. Node text, bezier, file export (.tex / SVG / PNG / PDF).
7. Save/load projects + UX polish.

## Conventions

- TypeScript everywhere; prefer pure functions for model→code logic.
- Match surrounding code style; keep components small.
- Write tests for the coordinate conversion and the TikZ generator.

## ⚠️ Working rule — keep MEMORY.md current

**Whenever you do anything in this repo** (add a feature, make a decision, change
a dependency, hit a gotcha), append a dated entry to `MEMORY.md`. Treat updating
`MEMORY.md` as part of the task, not an afterthought.
