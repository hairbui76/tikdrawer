"use client";

import { useRef, useState } from "react";
import { fileToAsset } from "@/lib/images";
import { useStore } from "@/lib/store";
import type { ImageAsset } from "@/lib/types";
import { OpenImageDialog } from "./OpenImageDialog";

export function ImageLibrary() {
  const images = useStore((s) => s.images);
  const addImage = useStore((s) => s.addImage);
  const deleteImage = useStore((s) => s.deleteImage);
  const insertImageShape = useStore((s) => s.insertImageShape);
  const insertShapes = useStore((s) => s.insertShapes);
  const inputRef = useRef<HTMLInputElement>(null);
  // The asset whose trace settings are being tuned, if any.
  const [tracing, setTracing] = useState<ImageAsset | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        addImage(await fileToAsset(file));
      } catch {
        /* skip unreadable file */
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Images</h2>
        <button
          onClick={() => inputRef.current?.click()}
          className="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700"
        >
          Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {images.length === 0 ? (
        <p className="px-1 text-xs text-slate-400">
          Upload images, then click one to place it on the canvas — or trace it into editable shapes with ⤳.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {images.map((im) => (
            <div key={im.id} className="group relative">
              <button
                onClick={() => insertImageShape(im)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-tikdrawer-image", im.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                title={`Click or drag to place ${im.name}`}
                className="block aspect-square w-full overflow-hidden rounded border border-slate-200 bg-white hover:ring-2 hover:ring-blue-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={im.dataUrl} alt={im.name} className="h-full w-full object-contain" draggable={false} />
              </button>
              <button
                onClick={() => setTracing(im)}
                title={`Trace ${im.name} into editable shapes`}
                className="absolute bottom-0 left-0 hidden rounded-tr bg-slate-700 px-1 text-xs leading-tight text-white group-hover:block"
              >
                ⤳
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Delete image "${im.name}"? Shapes using it will be removed.`)) deleteImage(im.id);
                }}
                title="Delete image"
                className="absolute right-0 top-0 hidden rounded-bl bg-red-600 px-1 text-xs leading-tight text-white group-hover:block"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {tracing && (
        // The asset is already in the library, so placing it is a click away —
        // this dialog only offers the trace.
        <OpenImageDialog
          name={tracing.name}
          dataUrl={tracing.dataUrl}
          allowPlace={false}
          onPlace={() => setTracing(null)}
          onTrace={(traced) => {
            insertShapes(traced);
            setTracing(null);
          }}
          onCancel={() => setTracing(null)}
        />
      )}
    </div>
  );
}
