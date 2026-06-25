"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saveProjectToFile, signatureOf } from "@/lib/files";
import { generateTikz } from "@/lib/generateTikz";
import { fileToAsset, imageFileName } from "@/lib/images";
import { useCurrentProject, useShapes, useStore } from "@/lib/store";
import { loadImages, loadState, saveImages, saveState } from "@/lib/storage";
import type { Shape } from "@/lib/types";
import { CanvasStage } from "./CanvasStage";
import { CodePanel } from "./CodePanel";
import { ImageLibrary } from "./ImageLibrary";
import { PreviewPanel, type RenderState } from "./PreviewPanel";
import { ProjectBar } from "./ProjectBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { Toolbar, TOOL_BY_KEY } from "./Toolbar";

export function Editor() {
  const shapes = useShapes();
  const hydrate = useStore((s) => s.hydrate);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);

  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setTool = useStore((s) => s.setTool);
  const deleteSelected = useStore((s) => s.deleteSelected);
  const markSaved = useStore((s) => s.markSaved);
  const templates = useStore((s) => s.templates);
  const setTemplates = useStore((s) => s.setTemplates);
  const project = useCurrentProject();
  const unit = useStore((s) => s.unit);
  const images = useStore((s) => s.images);
  const setImages = useStore((s) => s.setImages);
  const addImage = useStore((s) => s.addImage);
  const insertImageShape = useStore((s) => s.insertImageShape);
  const insertShapes = useStore((s) => s.insertShapes);
  const selectedIds = useStore((s) => s.selectedIds);

  const [ready, setReady] = useState(false);
  const [render, setRender] = useState<RenderState>({ status: "idle" });

  const imagesById = useMemo(() => new Map(images.map((im) => [im.id, im])), [images]);
  const code = useMemo(() => generateTikz(shapes, unit, imagesById), [shapes, unit, imagesById]);

  // Latest save closure (kept in a ref so the key handler stays stable).
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = async () => {
    const res = await saveProjectToFile(project.id, project.name, shapes);
    if (res !== "cancelled") markSaved(project.id, signatureOf(project.name, shapes));
  };

  // Internal clipboard for copy/paste of shapes. `copyRef` returns whether it
  // captured a selection (so the key handler knows to preventDefault).
  const clipboardRef = useRef<Shape[]>([]);
  const copyRef = useRef<() => boolean>(() => false);
  copyRef.current = () => {
    const sel = shapes.filter((s) => selectedIds.includes(s.id));
    if (!sel.length) return false;
    clipboardRef.current = JSON.parse(JSON.stringify(sel)) as Shape[];
    return true;
  };

  // Keyboard shortcuts. Skip entirely while typing in a form field so native
  // editing (and inline node editing) works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (key === "s") {
          e.preventDefault();
          saveRef.current();
        } else if (key === "c") {
          if (copyRef.current()) e.preventDefault();
        } else if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          redo();
        }
        return;
      }
      if (e.altKey) return;
      if (key === "delete" || key === "backspace") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      // Plain single-key tool shortcuts (V/L/R/C/E/T/X…).
      const tool = TOOL_BY_KEY[key];
      if (tool) {
        e.preventDefault();
        setTool(tool);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, setTool, deleteSelected]);

  // Paste: an image from the clipboard (e.g. a screenshot) → add + place it;
  // otherwise paste the internal shape clipboard (Ctrl+V after Ctrl+C).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      let imageFile: File | null = null;
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          break;
        }
      }
      if (imageFile) {
        e.preventDefault();
        fileToAsset(imageFile)
          .then((asset) => {
            addImage(asset);
            insertImageShape(asset);
          })
          .catch(() => {});
        return;
      }
      if (clipboardRef.current.length) {
        e.preventDefault();
        insertShapes(clipboardRef.current);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addImage, insertImageShape, insertShapes]);

  // Load persisted drawings + images once on mount.
  useEffect(() => {
    const saved = loadState();
    if (saved?.projects?.length) hydrate(saved.projects, saved.currentProjectId);
    if (saved?.templates?.length) setTemplates(saved.templates);
    const imgs = loadImages();
    if (imgs.length) setImages(imgs);
    setReady(true);
  }, [hydrate, setTemplates, setImages]);

  // Persist drawings + templates whenever they change (after hydration).
  useEffect(() => {
    if (!ready) return;
    saveState({ projects, currentProjectId, templates });
  }, [ready, projects, currentProjectId, templates]);

  // Persist the image library separately (kept out of the projects entry).
  useEffect(() => {
    if (!ready) return;
    saveImages(images);
  }, [ready, images]);

  // Debounced server-side LaTeX render.
  useEffect(() => {
    if (!ready) return;
    if (shapes.length === 0) {
      setRender({ status: "idle" });
      return;
    }
    const handle = window.setTimeout(async () => {
      setRender({ status: "loading" });
      try {
        // Collect images referenced by the drawing so the server can embed them.
        const usedIds = new Set(shapes.filter((s) => s.kind === "image").map((s) => s.imageId));
        const payloadImages = images
          .filter((im) => usedIds.has(im.id))
          .map((im) => ({ name: imageFileName(im), dataUrl: im.dataUrl }));
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tikz: code, images: payloadImages }),
        });
        const data = await res.json();
        if (data.ok) setRender({ status: "ok", svg: data.svg });
        else setRender({ status: "error", log: data.log ?? "Unknown error" });
      } catch (e) {
        setRender({ status: "error", log: e instanceof Error ? e.message : String(e) });
      }
    }, 700);
    return () => window.clearTimeout(handle);
  }, [code, ready, shapes, images]);

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white px-4 py-2">
        <ProjectBar />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-52 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
          <Toolbar />
          <div className="border-t border-slate-200 pt-3">
            <PropertiesPanel />
          </div>
          <div className="border-t border-slate-200 pt-3">
            <ImageLibrary />
          </div>
        </aside>

        <main className="flex-1 overflow-hidden">
          <CanvasStage />
        </main>

        <aside className="flex w-[28rem] flex-col border-l border-slate-200 bg-white">
          <div className="h-1/2 min-h-0 border-b border-slate-200">
            <PreviewPanel state={render} />
          </div>
          <div className="h-1/2 min-h-0">
            <CodePanel code={code} />
          </div>
        </aside>
      </div>
    </div>
  );
}
