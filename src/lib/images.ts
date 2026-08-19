import { CANVAS_H, CANVAS_W } from "./coords";
import { DEFAULT_STYLE, type ImageAsset, type ImageShape, type Point } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/** Longest side for an image that should fill the canvas (leaves a margin on
 *  both axes whatever the aspect ratio). Used when a file is opened as a
 *  drawing of its own, rather than dropped into an existing one. */
export const FILL_CANVAS_DIM = Math.min(CANVAS_W, CANVAS_H) - 80;

/** Place an asset as a shape: aspect-preserving, at most `maxDim` px on its
 *  longest side, centred on `at` (canvas centre by default). */
export function imageShapeFor(asset: ImageAsset, maxDim = 240, at?: Point): ImageShape {
  const scale = Math.min(1, maxDim / Math.max(asset.w, asset.h || 1));
  const w = asset.w * scale || 120;
  const h = asset.h * scale || 120;
  const cx = at?.x ?? CANVAS_W / 2;
  const cy = at?.y ?? CANVAS_H / 2;
  return {
    id: uid(),
    kind: "image",
    imageId: asset.id,
    p1: { x: cx - w / 2, y: cy - h / 2 },
    p2: { x: cx + w / 2, y: cy + h / 2 },
    style: { ...DEFAULT_STYLE },
  };
}

/** Deterministic, filesystem-safe filename for an asset (used in TikZ + on the
 *  render server). Stable so the \includegraphics name matches the written file. */
export function imageFileName(asset: ImageAsset): string {
  return `img_${asset.id.slice(0, 8)}.${asset.ext}`;
}

/**
 * Read an uploaded image file, downscale it to keep storage reasonable, and
 * return an ImageAsset (data URL + dimensions).
 */
export function fileToAsset(file: File, maxDim = 1100): Promise<ImageAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no 2d context"));
        ctx.drawImage(img, 0, 0, w, h);
        const isJpeg = file.type === "image/jpeg";
        const ext = isJpeg ? "jpg" : "png";
        const dataUrl = canvas.toDataURL(isJpeg ? "image/jpeg" : "image/png", 0.85);
        resolve({ id: uid(), name: file.name, dataUrl, ext, w, h });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
