import { importSvg } from "./importSvg";
import { importTikz } from "./importTikz";
import type { Shape } from "./types";

const FORMAT = "tikdrawer";
const VERSION = 1;

export type ProjectFile = { format: string; version: number; name: string; shapes: Shape[] };

/** Browsers that expose the File System Access API (Chrome/Edge) can write
 *  directly to a chosen file and overwrite it in place. */
type FilePickerWindow = Window & {
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
};

const fsWindow = (): FilePickerWindow => window as FilePickerWindow;
const supportsFS = (): boolean => typeof fsWindow().showSaveFilePicker === "function";

// Remember the file handle per project (runtime only) so "Save" overwrites the
// same file the user previously chose, without prompting again.
const handles = new Map<string, FileSystemFileHandle>();

function serialize(name: string, shapes: Shape[]): string {
  const data: ProjectFile = { format: FORMAT, version: VERSION, name, shapes };
  return JSON.stringify(data, null, 2);
}

/** Stable signature of a drawing's saveable content (for unsaved-change checks). */
export function signatureOf(name: string, shapes: Shape[]): string {
  return serialize(name, shapes);
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "drawing";
}

function pickerOpts(name: string) {
  return {
    suggestedName: `${slug(name)}.tikz.json`,
    types: [{ description: "TikDrawer drawing", accept: { "application/json": [".json"] } }],
  };
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** File kinds the "Open file" action accepts. `json` is a native drawing;
 *  `tex`/`svg` are external files parsed into (editable) shapes; `raster` is a
 *  bitmap, which has no geometry to read and so is handed back undecided — the
 *  caller asks whether to place it or trace it (see importRaster). */
type OpenKind = "json" | "tex" | "svg" | "raster";

/** Bitmap formats. Matched on the filename first because `image/svg+xml` also
 *  starts with `image/`, and SVG must keep going down the vector path. */
const RASTER_EXT = /\.(png|jpe?g|webp)$/i;
const isRaster = (file: File): boolean =>
  RASTER_EXT.test(file.name) || /^image\/(png|jpeg|webp)$/i.test(file.type);

/** Drop an extension and turn a filename into a drawing name. */
function nameFromFile(filename: string): string {
  return filename
    .replace(/\.(json|tex|tikz|svg|png|jpe?g|webp)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() || "Imported";
}

type ParsedFile = { name: string; shapes: Shape[]; kind: Exclude<OpenKind, "raster"> };

/**
 * Parse an opened text file into a drawing. Detects the format from the filename
 * and, as a fallback, the contents:
 * - `.json` (TikDrawer native)   → shapes verbatim.
 * - `.tex` / `.tikz` (tikzpicture) → parsed into editable shapes (importTikz).
 * - `.svg`                         → parsed into editable shapes (importSvg).
 *
 * Bitmaps never reach here — `openProjectFromFile` splits them off first.
 */
function parse(text: string, filename: string): ParsedFile | null {
  const ext = /\.(json|tex|tikz|svg)$/i.exec(filename)?.[1]?.toLowerCase();

  // Native JSON drawing.
  if (ext === "json" || (!ext && text.trimStart().startsWith("{"))) {
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.shapes)) {
        return { name: typeof data.name === "string" ? data.name : nameFromFile(filename), shapes: data.shapes as Shape[], kind: "json" };
      }
    } catch {
      /* not valid JSON — fall through to sniffing */
    }
  }

  // SVG (by extension or a leading <svg>/<?xml … svg).
  if (ext === "svg" || /<svg[\s>]/i.test(text.slice(0, 500))) {
    const shapes = importSvg(text);
    if (shapes.length) return { name: nameFromFile(filename), shapes, kind: "svg" };
  }

  // TeX / TikZ (by extension or a tikzpicture / \draw / \node in the body).
  if (ext === "tex" || ext === "tikz" || /\\begin\{tikzpicture\}|\\draw|\\node/.test(text)) {
    const shapes = importTikz(text);
    if (shapes.length) return { name: nameFromFile(filename), shapes, kind: "tex" };
  }

  return null;
}

const OPEN_ACCEPT_TYPES = [
  {
    description: "Drawing / TikZ / SVG / image",
    accept: {
      "application/json": [".json"],
      "text/x-tex": [".tex", ".tikz"],
      "image/svg+xml": [".svg"],
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
    },
  },
];

const OPEN_ACCEPT_ATTR =
  ".json,.tex,.tikz,.svg,.png,.jpg,.jpeg,.webp,application/json,image/svg+xml,image/png,image/jpeg,image/webp";

export type SaveResult = "saved" | "cancelled" | "downloaded";

/**
 * Save a drawing to a local file. With the File System Access API it writes to
 * the chosen file (reusing the remembered handle unless `saveAs`); otherwise it
 * falls back to a normal browser download.
 */
export async function saveProjectToFile(
  projectId: string,
  name: string,
  shapes: Shape[],
  saveAs = false,
): Promise<SaveResult> {
  const json = serialize(name, shapes);
  if (supportsFS()) {
    try {
      let handle = saveAs ? undefined : handles.get(projectId);
      if (!handle) {
        handle = await fsWindow().showSaveFilePicker!(pickerOpts(name));
        handles.set(projectId, handle);
      }
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return "saved";
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return "cancelled";
      // Fall through to a plain download on any other failure.
    }
  }
  downloadText(`${slug(name)}.tikz.json`, json);
  return "downloaded";
}

export type OpenResult =
  /** A vector source that was parsed straight into shapes. */
  | { kind: "json" | "tex" | "svg"; name: string; shapes: Shape[]; handle?: FileSystemFileHandle }
  /** A bitmap: how to turn it into a drawing is the caller's (user's) choice. */
  | { kind: "raster"; name: string; file: File };

/**
 * Open a drawing / TikZ / SVG / image file from disk. Vector sources come back
 * parsed into shapes; a bitmap comes back as the raw `File` because it can be
 * either placed as-is or traced, and only the user can decide which.
 *
 * A file handle is returned only for native `.json` drawings (so a later Save
 * overwrites the same file); imported files get no handle, so saving them
 * prompts for a new `.tikz.json` instead of clobbering the source.
 */
export async function openProjectFromFile(): Promise<OpenResult | null> {
  if (supportsFS()) {
    try {
      const [handle] = await fsWindow().showOpenFilePicker!({ types: OPEN_ACCEPT_TYPES });
      const file = await handle.getFile();
      if (isRaster(file)) return { kind: "raster", name: nameFromFile(file.name), file };
      const parsed = parse(await file.text(), file.name);
      if (!parsed) return null;
      return { ...parsed, handle: parsed.kind === "json" ? handle : undefined };
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return null;
      // Fall through to the <input type=file> fallback.
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = OPEN_ACCEPT_ATTR;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (isRaster(file)) return resolve({ kind: "raster", name: nameFromFile(file.name), file });
      resolve(parse(await file.text(), file.name));
    };
    input.click();
  });
}

/** Associate a file handle with a project id (e.g. after opening a file). */
export function rememberHandle(projectId: string, handle?: FileSystemFileHandle): void {
  if (handle) handles.set(projectId, handle);
}
