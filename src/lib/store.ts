import { create } from "zustand";
import { CANVAS_H, CANVAS_W, type Unit } from "./coords";
import { DEFAULT_STYLE, type ImageAsset, type Point, type Shape, type Style, type TikzDoc, type Tool } from "./types";

export type Project = {
  id: string;
  name: string;
  doc: TikzDoc;
  updatedAt: number;
};

/** A user-saved reusable drawing. */
export type UserTemplate = { id: string; name: string; shapes: Shape[] };

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);

/** Deep-copy shapes and give them fresh ids, remapping connector anchors. */
function cloneShapes(shapes: Shape[]): Shape[] {
  const copy: Shape[] = JSON.parse(JSON.stringify(shapes));
  const idMap = new Map<string, string>();
  for (const s of copy) idMap.set(s.id, uid());
  return copy.map((s) => {
    const next = { ...s, id: idMap.get(s.id)! } as Shape;
    if (next.kind === "connector") {
      next.from = { ...next.from, anchor: next.from.anchor ? idMap.get(next.from.anchor) ?? null : null };
      next.to = { ...next.to, anchor: next.to.anchor ? idMap.get(next.to.anchor) ?? null : null };
    }
    return next;
  });
}

const HISTORY_LIMIT = 100;

function newDoc(): TikzDoc {
  return { shapes: [] };
}

export function makeProject(name: string): Project {
  return { id: uid(), name, doc: newDoc(), updatedAt: Date.now() };
}

type State = {
  projects: Project[];
  currentProjectId: string;
  tool: Tool;
  selectedIds: string[];
  snap: boolean;
  showRuler: boolean;
  unit: Unit;
  /** Keep width:height ratio when resizing via the size inputs. */
  lockAspect: boolean;
  /** Per-project signature of the last state saved to a file (for dirty checks). */
  savedSig: Record<string, string>;
  /** Undo/redo stacks hold snapshots of the *current* project's shapes. */
  past: Shape[][];
  future: Shape[][];
  /** User-saved reusable templates. */
  templates: UserTemplate[];
  /** Uploaded image library (managed separately from drawings). */
  images: ImageAsset[];

  setTool: (t: Tool) => void;
  setSnap: (b: boolean) => void;
  setShowRuler: (b: boolean) => void;
  setUnit: (u: Unit) => void;
  setLockAspect: (b: boolean) => void;
  markSaved: (projectId: string, signature: string) => void;
  selectShape: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;
  deleteSelected: () => void;
  /** Save the current selection as a reusable symbol/template. */
  groupSelectionAsTemplate: (name: string) => void;
  /** Insert shapes into the current drawing (cloned + offset), selecting them. */
  insertShapes: (shapes: Shape[]) => void;

  /** Snapshot current shapes before a continuous interaction (drag, slider). */
  beginChange: () => void;
  undo: () => void;
  redo: () => void;

  addShape: (s: Shape) => void;
  updateShape: (id: string, patch: Partial<Shape>) => void;
  updateShapeStyle: (id: string, patch: Partial<Style>) => void;
  deleteShape: (id: string) => void;
  clearShapes: () => void;

  newProject: (name?: string) => void;
  newProjectFromShapes: (name: string, shapes: Shape[]) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  selectProject: (id: string) => void;
  hydrate: (projects: Project[], currentId: string | null) => void;

  saveTemplate: (name: string) => void;
  deleteTemplate: (id: string) => void;
  instantiateTemplate: (id: string) => void;
  setTemplates: (templates: UserTemplate[]) => void;

  addImage: (asset: ImageAsset) => void;
  deleteImage: (id: string) => void;
  setImages: (images: ImageAsset[]) => void;
  /** Insert an image as a shape on the current drawing, sized from the asset,
   *  centered at `at` (defaults to canvas center). */
  insertImageShape: (asset: ImageAsset, at?: Point) => void;
};

const initial = makeProject("Untitled");

function currentShapes(st: State): Shape[] {
  return st.projects.find((p) => p.id === st.currentProjectId)?.doc.shapes ?? [];
}

/** Replace the current project's shapes (bumps updatedAt). */
function setShapes(st: State, shapes: Shape[]): Pick<State, "projects"> {
  return {
    projects: st.projects.map((p) =>
      p.id === st.currentProjectId
        ? { ...p, doc: { shapes }, updatedAt: Date.now() }
        : p,
    ),
  };
}

/** Push current shapes onto the undo stack, skipping consecutive duplicates. */
function pushPast(st: State): Shape[][] {
  const cur = currentShapes(st);
  const last = st.past[st.past.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(cur)) return st.past;
  return [...st.past, cur].slice(-HISTORY_LIMIT);
}

export const useStore = create<State>((set) => ({
  projects: [initial],
  currentProjectId: initial.id,
  tool: "select",
  selectedIds: [],
  snap: true,
  showRuler: true,
  unit: "cm",
  lockAspect: false,
  savedSig: {},
  past: [],
  future: [],
  templates: [],
  images: [],

  setTool: (t) => set({ tool: t, selectedIds: [] }),
  setSnap: (b) => set({ snap: b }),
  setShowRuler: (b) => set({ showRuler: b }),
  setUnit: (u) => set({ unit: u }),
  setLockAspect: (b) => set({ lockAspect: b }),
  markSaved: (projectId, signature) =>
    set((st) => ({ savedSig: { ...st.savedSig, [projectId]: signature } })),
  selectShape: (id) => set({ selectedIds: id ? [id] : [] }),

  toggleSelect: (id) =>
    set((st) => ({
      selectedIds: st.selectedIds.includes(id)
        ? st.selectedIds.filter((x) => x !== id)
        : [...st.selectedIds, id],
    })),

  selectMany: (ids) => set({ selectedIds: ids }),

  beginChange: () => set((st) => ({ past: pushPast(st), future: [] })),

  undo: () =>
    set((st) => {
      if (!st.past.length) return {};
      const prev = st.past[st.past.length - 1];
      return {
        ...setShapes(st, prev),
        past: st.past.slice(0, -1),
        future: [currentShapes(st), ...st.future].slice(0, HISTORY_LIMIT),
        selectedIds: [],
      };
    }),

  redo: () =>
    set((st) => {
      if (!st.future.length) return {};
      const next = st.future[0];
      return {
        ...setShapes(st, next),
        future: st.future.slice(1),
        past: [...st.past, currentShapes(st)].slice(-HISTORY_LIMIT),
        selectedIds: [],
      };
    }),

  addShape: (s) =>
    set((st) => {
      // Keep a caller-supplied id (e.g. so a new node can be edited inline);
      // otherwise assign a fresh one.
      const shape = { ...s, id: s.id && s.id !== "draft" ? s.id : uid() } as Shape;
      return {
        past: pushPast(st),
        future: [],
        ...setShapes(st, [...currentShapes(st), shape]),
        selectedIds: [shape.id],
      };
    }),

  updateShape: (id, patch) =>
    set((st) =>
      setShapes(
        st,
        currentShapes(st).map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)),
      ),
    ),

  updateShapeStyle: (id, patch) =>
    set((st) =>
      setShapes(
        st,
        currentShapes(st).map((s) =>
          s.id === id ? ({ ...s, style: { ...s.style, ...patch } } as Shape) : s,
        ),
      ),
    ),

  deleteShape: (id) =>
    set((st) => ({
      past: pushPast(st),
      future: [],
      // Drop the shape and any connector attached to it.
      ...setShapes(
        st,
        currentShapes(st).filter(
          (s) =>
            s.id !== id &&
            !(s.kind === "connector" && (s.from.anchor === id || s.to.anchor === id)),
        ),
      ),
      selectedIds: st.selectedIds.filter((x) => x !== id),
    })),

  deleteSelected: () =>
    set((st) => {
      const ids = new Set(st.selectedIds);
      if (!ids.size) return {};
      return {
        past: pushPast(st),
        future: [],
        ...setShapes(
          st,
          currentShapes(st).filter(
            (s) =>
              !ids.has(s.id) &&
              !(s.kind === "connector" && ((s.from.anchor && ids.has(s.from.anchor)) || (s.to.anchor && ids.has(s.to.anchor)))),
          ),
        ),
        selectedIds: [],
      };
    }),

  clearShapes: () =>
    set((st) => ({
      past: pushPast(st),
      future: [],
      ...setShapes(st, []),
      selectedIds: [],
    })),

  newProject: (name) =>
    set((st) => {
      const p = makeProject(name?.trim() || `Drawing ${st.projects.length + 1}`);
      return {
        projects: [...st.projects, p],
        currentProjectId: p.id,
        selectedIds: [],
        past: [],
        future: [],
      };
    }),

  newProjectFromShapes: (name, shapes) =>
    set((st) => {
      const p: Project = { id: uid(), name, doc: { shapes }, updatedAt: Date.now() };
      return {
        projects: [...st.projects, p],
        currentProjectId: p.id,
        selectedIds: [],
        past: [],
        future: [],
      };
    }),

  deleteProject: (id) =>
    set((st) => {
      const remaining = st.projects.filter((p) => p.id !== id);
      const projects = remaining.length ? remaining : [makeProject("Untitled")];
      const currentProjectId =
        st.currentProjectId === id ? projects[0].id : st.currentProjectId;
      return { projects, currentProjectId, selectedIds: [], past: [], future: [] };
    }),

  renameProject: (id, name) =>
    set((st) => ({
      projects: st.projects.map((p) =>
        p.id === id ? { ...p, name: name.trim() || p.name } : p,
      ),
    })),

  selectProject: (id) =>
    set({ currentProjectId: id, selectedIds: [], past: [], future: [] }),

  hydrate: (projects, currentId) =>
    set(() => {
      if (!projects.length) {
        const p = makeProject("Untitled");
        return { projects: [p], currentProjectId: p.id, selectedIds: [], past: [], future: [] };
      }
      const valid = projects.some((p) => p.id === currentId);
      return {
        projects,
        currentProjectId: valid ? (currentId as string) : projects[0].id,
        selectedIds: [],
        past: [],
        future: [],
      };
    }),

  saveTemplate: (name) =>
    set((st) => ({
      templates: [
        ...st.templates,
        { id: uid(), name: name.trim() || `Template ${st.templates.length + 1}`, shapes: cloneShapes(currentShapes(st)) },
      ],
    })),

  deleteTemplate: (id) =>
    set((st) => ({ templates: st.templates.filter((t) => t.id !== id) })),

  instantiateTemplate: (id) =>
    set((st) => {
      const t = st.templates.find((x) => x.id === id);
      if (!t) return {};
      const p: Project = { id: uid(), name: t.name, doc: { shapes: cloneShapes(t.shapes) }, updatedAt: Date.now() };
      return {
        projects: [...st.projects, p],
        currentProjectId: p.id,
        selectedIds: [],
        past: [],
        future: [],
      };
    }),

  setTemplates: (templates) => set({ templates }),

  groupSelectionAsTemplate: (name) =>
    set((st) => {
      const ids = new Set(st.selectedIds);
      const picked = currentShapes(st).filter((s) => ids.has(s.id));
      if (!picked.length) return {};
      return {
        templates: [
          ...st.templates,
          { id: uid(), name: name.trim() || `Symbol ${st.templates.length + 1}`, shapes: cloneShapes(picked) },
        ],
      };
    }),

  insertShapes: (shapes) =>
    set((st) => {
      if (!shapes.length) return {};
      // Clone (fresh ids) + offset so the insert doesn't overlap exactly.
      const clones = cloneShapes(shapes).map((s) => shiftShape(s, 24, 24));
      return {
        past: pushPast(st),
        future: [],
        ...setShapes(st, [...currentShapes(st), ...clones]),
        selectedIds: clones.map((s) => s.id),
      };
    }),

  addImage: (asset) => set((st) => ({ images: [...st.images, asset] })),

  setImages: (images) => set({ images }),

  deleteImage: (id) =>
    set((st) => ({
      images: st.images.filter((im) => im.id !== id),
      // Drop any image shapes (in any drawing) that referenced it.
      projects: st.projects.map((p) => ({
        ...p,
        doc: { shapes: p.doc.shapes.filter((s) => !(s.kind === "image" && s.imageId === id)) },
      })),
    })),

  insertImageShape: (asset, at) =>
    set((st) => {
      const maxDim = 240;
      const scale = Math.min(1, maxDim / Math.max(asset.w, asset.h || 1));
      const w = asset.w * scale || 120;
      const h = asset.h * scale || 120;
      const cx = at?.x ?? CANVAS_W / 2;
      const cy = at?.y ?? CANVAS_H / 2;
      const shape: Shape = {
        id: uid(),
        kind: "image",
        imageId: asset.id,
        p1: { x: cx - w / 2, y: cy - h / 2 },
        p2: { x: cx + w / 2, y: cy + h / 2 },
        style: { ...DEFAULT_STYLE },
      };
      return {
        past: pushPast(st),
        future: [],
        ...setShapes(st, [...currentShapes(st), shape]),
        selectedIds: [shape.id],
      };
    }),
}));

/** Translate any shape by (dx, dy). */
function shiftShape(s: Shape, dx: number, dy: number): Shape {
  const mv = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  switch (s.kind) {
    case "line":
    case "rect":
    case "diamond":
    case "roundrect":
    case "cylinder":
    case "image":
      return { ...s, p1: mv(s.p1), p2: mv(s.p2) };
    case "circle":
    case "ellipse":
      return { ...s, center: mv(s.center) };
    case "node":
      return { ...s, at: mv(s.at) };
    case "polygon":
      return { ...s, points: s.points.map(mv) };
    case "connector":
      return {
        ...s,
        from: { ...s.from, point: mv(s.from.point) },
        to: { ...s.to, point: mv(s.to.point) },
        control: mv(s.control),
      };
  }
}

/** Selectors */
export const useCurrentProject = (): Project =>
  useStore((s) => s.projects.find((p) => p.id === s.currentProjectId) ?? s.projects[0]);

export const useShapes = (): Shape[] => useCurrentProject().doc.shapes;
