// Text metrics shared by the canvas, the geometry helpers and the SVG importer.
//
// Label size lives in `Style.fontSize` in **pt**, the same unit as `lineWidth`,
// because both end up as TikZ dimensions. Canvas px is the geometry unit, so
// rendering converts with `ptToPx`.
//
// Everything here must stay safe to import on the server: the render API pulls
// in generateTikz → geometry → this module, so the DOM is only touched lazily
// inside `textWidthPx`, never at module load.

import { ptToPx, pxToPt } from "./coords";
import type { Style } from "./types";

/** Default label size in pt. Chosen so it renders at the 16 canvas px the app
 *  used before font size was adjustable — existing drawings look unchanged. */
export const DEFAULT_FONT_PT = 11.4;

/**
 * The font the canvas renders labels in. Latin Modern Roman (@font-face in
 * globals.css) is the web build of LaTeX's Computer Modern, so canvas metrics
 * track the compiled PDF: with a browser sans here, labels that fit their box
 * on canvas overflowed it in the PDF (CM glyphs run wider). Georgia is the
 * closest common fallback while the face loads.
 */
export const CANVAS_FONT_FAMILY = '"Latin Modern Roman", Georgia, "Times New Roman", serif';

/** A style's label size in pt, falling back for drawings saved before it existed. */
export const fontPtOf = (style: Pick<Style, "fontSize">): number =>
  style.fontSize && style.fontSize > 0 ? style.fontSize : DEFAULT_FONT_PT;

/** A style's label size in canvas px. */
export const fontPxOf = (style: Pick<Style, "fontSize">): number => ptToPx(fontPtOf(style));

/** Average glyph advance as a fraction of the font size, for the no-DOM path. */
const FALLBACK_ADVANCE = 0.5;

// One reusable measuring context. `null` means measurement is unavailable (SSR,
// or a DOM without canvas support such as bare jsdom) and we use the estimate.
let ctx: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Width of `text` in the same units as `sizePx`, measured with the real font
 * when a canvas is available and estimated otherwise.
 *
 * Measuring matters for placement: the SVG importer has to know how wide a label
 * was in order to convert SVG's start/end anchoring into our centre anchoring,
 * and a per-character guess drifts badly on text that is mostly narrow ("illli")
 * or wide ("WWW").
 */
export function textWidthPx(text: string, sizePx: number, family = CANVAS_FONT_FAMILY): number {
  if (!text) return 0;
  const c = measureCtx();
  if (c) {
    // Measure at a fixed size and scale, so the value is exact in proportion
    // even when `sizePx` is fractional after an import rescale.
    const BASE = 100;
    c.font = `${BASE}px ${family}`;
    const w = c.measureText(text).width;
    if (w > 0) return (w / BASE) * sizePx;
  }
  return text.length * sizePx * FALLBACK_ADVANCE;
}

/** Half-extent of a text label's box in canvas px, used for hit-testing,
 *  selection handles and connector attachment. Padding keeps short labels
 *  comfortably clickable. */
export function labelHalfSize(text: string, style: Pick<Style, "fontSize">): { hw: number; hh: number } {
  const sizePx = fontPxOf(style);
  return {
    hw: Math.max(8, textWidthPx(text, sizePx) / 2 + sizePx * 0.25),
    hh: Math.max(7, sizePx * 0.72),
  };
}

/** Convert a font size in source px (e.g. SVG user units) to the stored pt. */
export const fontPxToPt = (px: number): number => pxToPt(px);
