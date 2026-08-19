"use client";

import { useState } from "react";
import { openProjectFromFile, rememberHandle, saveProjectToFile, signatureOf } from "@/lib/files";
import { FILL_CANVAS_DIM, fileToAsset, imageShapeFor } from "@/lib/images";
import { useCurrentProject, useShapes, useStore } from "@/lib/store";
import { TEMPLATES } from "@/lib/templates";
import type { ImageAsset, Shape } from "@/lib/types";
import { OpenImageDialog } from "./OpenImageDialog";

export function ProjectBar() {
  const projects = useStore((s) => s.projects);
  const current = useCurrentProject();
  const selectProject = useStore((s) => s.selectProject);
  const newProject = useStore((s) => s.newProject);
  const newProjectFromShapes = useStore((s) => s.newProjectFromShapes);
  const userTemplates = useStore((s) => s.templates);
  const saveTemplate = useStore((s) => s.saveTemplate);
  const deleteTemplate = useStore((s) => s.deleteTemplate);
  const instantiateTemplate = useStore((s) => s.instantiateTemplate);
  const insertShapes = useStore((s) => s.insertShapes);
  const markSaved = useStore((s) => s.markSaved);
  const savedSig = useStore((s) => s.savedSig);
  const showRuler = useStore((s) => s.showRuler);
  const setShowRuler = useStore((s) => s.setShowRuler);
  const unit = useStore((s) => s.unit);
  const setUnit = useStore((s) => s.setUnit);
  const texLayout = useStore((s) => s.texLayout);
  const setTexLayout = useStore((s) => s.setTexLayout);
  const addImage = useStore((s) => s.addImage);
  const shapes = useShapes();
  const [tpl, setTpl] = useState("");
  // A bitmap picked in "Open file", waiting for the place-or-trace choice.
  const [pendingImage, setPendingImage] = useState<{ name: string; asset: ImageAsset } | null>(null);

  const dirty = savedSig[current.id] !== signatureOf(current.name, shapes);

  async function saveToFile(saveAs: boolean) {
    // On non-Chromium browsers this falls back to a normal download.
    const res = await saveProjectToFile(current.id, current.name, shapes, saveAs);
    if (res !== "cancelled") markSaved(current.id, signatureOf(current.name, shapes));
  }

  async function openFromFile() {
    const res = await openProjectFromFile();
    if (!res) {
      window.alert("Nothing to import — the file wasn't a TikDrawer drawing, a tikzpicture, or a recognisable SVG.");
      return;
    }
    // A bitmap can't be read as geometry, so ask whether to place or trace it.
    if (res.kind === "raster") {
      try {
        setPendingImage({ name: res.name, asset: await fileToAsset(res.file) });
      } catch {
        window.alert("That image could not be read.");
      }
      return;
    }
    newProjectFromShapes(res.name, res.shapes);
    const id = useStore.getState().currentProjectId;
    if (res.kind === "json") {
      // Native drawing: remember its handle and mark it as matching disk.
      rememberHandle(id, res.handle);
      markSaved(id, signatureOf(res.name, res.shapes));
    }
    // Imported .tex/.svg stay "unsaved" so the next Save writes a .tikz.json
    // rather than overwriting the source file.
  }

  /** Open an image as a new drawing — the picture itself, or its traced shapes. */
  function openImageAs(name: string, asset: ImageAsset, traced: Shape[] | null) {
    if (traced) {
      newProjectFromShapes(name, traced);
    } else {
      // Only register the asset when it is actually used, so tracing doesn't
      // leave an unused image behind in the library.
      addImage(asset);
      newProjectFromShapes(name, [imageShapeFor(asset, FILL_CANVAS_DIM)]);
    }
    setPendingImage(null);
  }

  const tplShapes = () => {
    if (tpl.startsWith("builtin:")) return TEMPLATES.find((x) => x.id === tpl.slice(8))?.build();
    if (tpl.startsWith("user:")) return userTemplates.find((x) => x.id === tpl.slice(5))?.shapes;
    return undefined;
  };
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const clearShapes = useStore((s) => s.clearShapes);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-lg font-bold text-slate-800">TikDrawer</span>
      <span className="text-slate-300">|</span>

      <label className="text-sm text-slate-500">Drawing</label>
      <select
        value={current.id}
        onChange={(e) => selectProject(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span
        title={dirty ? "Unsaved changes (Ctrl+S to save to file)" : "Saved to file"}
        className={`rounded px-2 py-0.5 text-xs font-medium ${
          dirty ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
        }`}
      >
        {dirty ? "● Unsaved" : "✓ Saved"}
      </span>

      <button
        onClick={() => newProject()}
        className="rounded bg-blue-600 px-2 py-1 text-sm text-white hover:bg-blue-700"
      >
        + New
      </button>

      <span className="text-slate-300">|</span>
      <button
        onClick={() => saveToFile(false)}
        title="Save this drawing to a file on your computer (overwrites the same file next time)"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        💾 Save file
      </button>
      <button
        onClick={() => saveToFile(true)}
        title="Save to a new file / location"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        Save as…
      </button>
      <button
        onClick={openFromFile}
        title="Open a drawing (.tikz.json), a TikZ file (.tex/.tikz), an SVG, or an image (.png/.jpg/.webp)"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        📂 Open file
      </button>

      <span className="text-slate-300">|</span>
      <label className="text-sm text-slate-500">Template</label>
      <select
        value={tpl}
        onChange={(e) => setTpl(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        title="Pick a template, then Insert"
      >
        <option value="">— choose —</option>
        <optgroup label="Built-in">
          {TEMPLATES.map((t) => (
            <option key={t.id} value={`builtin:${t.id}`}>{t.name}</option>
          ))}
        </optgroup>
        {userTemplates.length > 0 && (
          <optgroup label="My templates">
            {userTemplates.map((t) => (
              <option key={t.id} value={`user:${t.id}`}>{t.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        onClick={() => {
          if (tpl.startsWith("builtin:")) {
            const t = TEMPLATES.find((x) => x.id === tpl.slice(8));
            if (t) newProjectFromShapes(t.name, t.build());
          } else if (tpl.startsWith("user:")) {
            instantiateTemplate(tpl.slice(5));
          }
        }}
        disabled={!tpl}
        className="rounded bg-blue-600 px-2 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
        title="Create a new drawing from this template"
      >
        New from
      </button>
      <button
        onClick={() => {
          const s = tplShapes();
          if (s) insertShapes(s);
        }}
        disabled={!tpl}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
        title="Add this template's shapes into the current drawing"
      >
        Add to canvas
      </button>
      <button
        onClick={() => {
          if (!tpl.startsWith("user:")) return;
          const t = userTemplates.find((x) => x.id === tpl.slice(5));
          if (t && window.confirm(`Delete template "${t.name}"?`)) {
            deleteTemplate(t.id);
            setTpl("");
          }
        }}
        disabled={!tpl.startsWith("user:")}
        title="Delete the selected custom template"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
      >
        Delete
      </button>
      <button
        onClick={() => {
          if (shapes.length === 0) {
            window.alert("Draw something first, then save it as a template.");
            return;
          }
          const name = window.prompt("Template name:", current.name);
          if (name) saveTemplate(name);
        }}
        title="Save the current drawing as a reusable template"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        Save as template
      </button>
      <button
        onClick={() => {
          const name = window.prompt("Rename drawing:", current.name);
          if (name) renameProject(current.id, name);
        }}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        Rename
      </button>
      <button
        onClick={() => {
          if (window.confirm(`Delete "${current.name}"?`)) deleteProject(current.id);
        }}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-red-600 hover:bg-red-50"
      >
        Delete
      </button>

      <span className="text-slate-300">|</span>
      <button
        onClick={undo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
      >
        ↶ Undo
      </button>
      <button
        onClick={redo}
        disabled={!canRedo}
        title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
      >
        ↷ Redo
      </button>

      <span className="text-slate-300">|</span>
      <label
        className="flex items-center gap-1 text-sm text-slate-600"
        title="Drags land on the 0.5cm grid. Hold Alt while dragging for pixel precision; arrow keys nudge the selection by 1px (Shift = one grid cell)."
      >
        <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
        Snap to grid
      </label>
      <label className="flex items-center gap-1 text-sm text-slate-600">
        <input type="checkbox" checked={showRuler} onChange={(e) => setShowRuler(e.target.checked)} />
        Ruler
      </label>
      <label className="flex items-center gap-1 text-sm text-slate-600" title="Unit for generated TikZ coordinates + ruler">
        Unit
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value as "cm" | "mm" | "pt")}
          className="rounded border border-slate-300 bg-white px-1 py-1 text-sm"
        >
          <option value="cm">cm</option>
          <option value="mm">mm</option>
          <option value="pt">pt</option>
        </select>
      </label>
      <label
        className="flex items-center gap-1 text-sm text-slate-600"
        title="Where the figure goes in your paper. '1 column' wraps the TikZ in \resizebox{\columnwidth}{!}{…} so it fits one column of a two-column layout (needs graphicx, which paper templates load)."
      >
        Output
        <select
          value={texLayout}
          onChange={(e) => setTexLayout(e.target.value as "full" | "column")}
          className="rounded border border-slate-300 bg-white px-1 py-1 text-sm"
        >
          <option value="full">Full page</option>
          <option value="column">1 column (2-col paper)</option>
        </select>
      </label>
      <button
        onClick={() => {
          if (window.confirm("Clear all shapes in this drawing?")) clearShapes();
        }}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm hover:bg-slate-100"
      >
        Clear
      </button>

      {pendingImage && (
        <OpenImageDialog
          name={pendingImage.name}
          dataUrl={pendingImage.asset.dataUrl}
          onPlace={() => openImageAs(pendingImage.name, pendingImage.asset, null)}
          onTrace={(traced) => openImageAs(pendingImage.name, pendingImage.asset, traced)}
          onCancel={() => setPendingImage(null)}
        />
      )}
    </div>
  );
}
