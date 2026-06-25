import type { ImageAsset } from "./types";

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

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
