import type { Project, UserTemplate } from "./store";
import type { ImageAsset } from "./types";

const KEY = "tikdrawer:v1";
const IMAGES_KEY = "tikdrawer:images:v1";

export type PersistedState = {
  projects: Project[];
  currentProjectId: string | null;
  templates?: UserTemplate[];
};

export function loadState(): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

export function saveState(data: PersistedState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // ignore quota / serialization errors
  }
}

export function loadImages(): ImageAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IMAGES_KEY);
    return raw ? (JSON.parse(raw) as ImageAsset[]) : [];
  } catch {
    return [];
  }
}

export function saveImages(images: ImageAsset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IMAGES_KEY, JSON.stringify(images));
  } catch {
    // Image data can exceed the localStorage quota — fail silently.
  }
}
