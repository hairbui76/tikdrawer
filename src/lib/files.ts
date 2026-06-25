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

function parse(text: string): { name: string; shapes: Shape[] } | null {
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.shapes)) {
      return { name: typeof data.name === "string" ? data.name : "Imported", shapes: data.shapes as Shape[] };
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

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

/** Open a drawing file from disk. Returns its contents (and a handle when the
 *  File System Access API is available, so later saves overwrite that file). */
export async function openProjectFromFile(): Promise<{ name: string; shapes: Shape[]; handle?: FileSystemFileHandle } | null> {
  if (supportsFS()) {
    try {
      const [handle] = await fsWindow().showOpenFilePicker!({
        types: [{ description: "TikDrawer drawing", accept: { "application/json": [".json"] } }],
      });
      const file = await handle.getFile();
      const parsed = parse(await file.text());
      return parsed ? { ...parsed, handle } : null;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return null;
      // Fall through to the <input type=file> fallback.
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? parse(await file.text()) : null);
    };
    input.click();
  });
}

/** Associate a file handle with a project id (e.g. after opening a file). */
export function rememberHandle(projectId: string, handle?: FileSystemFileHandle): void {
  if (handle) handles.set(projectId, handle);
}
