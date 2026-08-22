"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_TRACE, type TraceOptions, type TraceResult } from "@/lib/importRaster";
import { traceImageOffThread } from "@/lib/traceClient";
import { CANVAS_H, CANVAS_W, ptToPx } from "@/lib/coords";
import { polygonPathD } from "@/lib/geometry";
import type { PolygonShape, Shape } from "@/lib/types";

/**
 * Asks what to do with a bitmap: keep it as a picture, or trace it into editable
 * shapes. Tracing is a guess by nature — the settings that suit a logo ruin a
 * photo — so the result is previewed live next to the original and the user
 * tunes it before committing.
 */
export function OpenImageDialog({
  name,
  dataUrl,
  allowPlace = true,
  placeLabel = "Place as image",
  onPlace,
  onTrace,
  onCancel,
}: {
  name: string;
  dataUrl: string;
  /** Hidden when the image is already in the library and only tracing is new. */
  allowPlace?: boolean;
  placeLabel?: string;
  onPlace: () => void;
  onTrace: (shapes: Shape[]) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"place" | "trace">(allowPlace ? "place" : "trace");
  const [opts, setOpts] = useState<TraceOptions>(DEFAULT_TRACE);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-trace on every settings change, debounced. `run` guards against an
  // earlier (slower) trace landing after a newer one.
  const runRef = useRef(0);
  useEffect(() => {
    if (mode !== "trace") return;
    const run = ++runRef.current;
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const r = await traceImageOffThread(dataUrl, opts);
        if (runRef.current === run) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (runRef.current === run) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (runRef.current === run) setBusy(false);
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [dataUrl, opts, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const set = <K extends keyof TraceOptions>(k: K, v: TraceOptions[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  // Tiny marks are almost always rasterised text: tracing cannot rebuild
  // readable glyphs, so offer to skip them (and retype labels afterwards).
  const TINY = 14; // canvas px
  const [skipTiny, setSkipTiny] = useState(false);
  const isTiny = (s: Shape): boolean => {
    if (s.kind !== "polygon" || !s.points.length) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return Math.max(x1 - x0, y1 - y0) < TINY;
  };
  const tinyCount = useMemo(() => (result ? result.shapes.filter(isTiny).length : 0), [result]);
  const texty = !!result && result.shapes.length > 50 && tinyCount / result.shapes.length > 0.35;
  const effectiveShapes = useMemo(
    () => (result ? (skipTiny ? result.shapes.filter((s) => !isTiny(s)) : result.shapes) : []),
    [result, skipTiny],
  );

  const confirm = () => {
    if (mode === "place") return onPlace();
    if (effectiveShapes.length) onTrace(effectiveShapes);
  };

  const heavy = (result?.vertices ?? 0) > 4000;
  const empty = !busy && result !== null && result.shapes.length === 0;
  const canConfirm = mode === "place" || (!busy && effectiveShapes.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-full w-[52rem] max-w-full flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-baseline justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">
            Open <span className="font-normal text-slate-500">{name}</span>
          </h2>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600" title="Cancel (Esc)">
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {allowPlace && (
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              <ModeCard
                active={mode === "place"}
                onClick={() => setMode("place")}
                title={placeLabel}
                desc="Keeps the picture exactly as it is (\\includegraphics). Move, resize and rotate it — but the drawing inside can't be edited."
              />
              <ModeCard
                active={mode === "trace"}
                onClick={() => setMode("trace")}
                title="Trace to shapes"
                desc="Turns flat colour areas into editable polygons. Great for logos, icons and line art; a photo just becomes colour blobs."
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Panel label="Original">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={dataUrl} alt={name} className="max-h-56 w-full object-contain" />
            </Panel>
            <Panel label={mode === "trace" ? (busy ? "Tracing…" : "Traced result") : "Placed on the canvas"}>
              {mode === "trace" ? (
                <TracePreview shapes={effectiveShapes} busy={busy} empty={empty} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={dataUrl} alt="" className="max-h-56 w-full object-contain opacity-90" />
              )}
            </Panel>
          </div>

          {mode === "trace" && (
            <div className="mt-4 space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  Colours
                  <select
                    value={opts.colors}
                    onChange={(e) => set("colors", Number(e.target.value))}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
                  >
                    {[2, 3, 4, 6, 8, 12, 16].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  Detail
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={opts.detail}
                    onChange={(e) => set("detail", Number(e.target.value))}
                    className="w-32"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  Ignore areas under
                  <span className="flex items-center gap-1">
                    <input
                      type="range"
                      min={1}
                      max={200}
                      step={1}
                      value={opts.minArea}
                      onChange={(e) => set("minArea", Number(e.target.value))}
                      className="w-24"
                    />
                    <span className="w-10 text-right text-xs tabular-nums text-slate-500">{opts.minArea}px</span>
                  </span>
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={opts.dropBackground}
                    onChange={(e) => set("dropBackground", e.target.checked)}
                  />
                  Drop the background
                </label>

                <label
                  className="flex items-center gap-2 text-sm text-slate-600"
                  title="Drop marks smaller than 14px — usually rasterised text, which tracing can't make readable. Retype labels with text nodes instead."
                >
                  <input type="checkbox" checked={skipTiny} onChange={(e) => setSkipTiny(e.target.checked)} />
                  Skip tiny marks{tinyCount > 0 ? ` (${tinyCount})` : ""}
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                {result && !busy && (
                  <>
                    <span>
                      {result.regions} shape{result.regions === 1 ? "" : "s"} · {result.vertices} points
                      {result.dropped > 0 && ` · ${result.dropped} skipped`}
                    </span>
                    <span className="flex gap-1">
                      {result.palette.map((c) => (
                        <span
                          key={c}
                          title={c}
                          className="inline-block h-3 w-3 rounded-sm border border-slate-300"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                  </>
                )}
              </div>

              {empty && (
                <p className="text-xs text-amber-700">
                  Nothing came out — the image has no flat areas at these settings. Lower “ignore areas under”,
                  raise the colour count, or place it as an image instead.
                </p>
              )}
              {texty && !skipTiny && (
                <p className="text-xs text-amber-700">
                  Most of these shapes are tiny marks — probably text. Tracing can’t rebuild small text;
                  place the image instead, or skip the tiny marks and retype the labels with text nodes.
                </p>
              )}
              {heavy && (
                <p className="text-xs text-amber-700">
                  That is a lot of geometry — the drawing will be slow to edit and the LaTeX render may take a
                  while. Fewer colours or less detail will thin it out.
                </p>
              )}
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {mode === "place" ? placeLabel : busy ? "Tracing…" : "Insert shapes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded border p-3 text-left transition ${
        active ? "border-blue-500 bg-blue-50 ring-1 ring-blue-400" : "border-slate-200 bg-white hover:bg-slate-50"
      }`}
    >
      <div className="text-sm font-medium text-slate-800">{title}</div>
      <div className="mt-0.5 text-xs leading-snug text-slate-500">{desc}</div>
    </button>
  );
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-2">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex h-56 items-center justify-center overflow-hidden rounded bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px]">
        {children}
      </div>
    </div>
  );
}

/** Draw traced shapes the way the canvas will: in order, largest first, so
 *  the holes punched by smaller regions show up here too. */
function TracePreview({ shapes, busy, empty }: { shapes: Shape[]; busy: boolean; empty: boolean }) {
  const polys = useMemo(() => shapes.filter((s): s is PolygonShape => s.kind === "polygon"), [shapes]);
  if (empty) return <span className="text-xs text-slate-400">No shapes found</span>;
  if (!polys.length) return <span className="text-xs text-slate-400">{busy ? "Tracing…" : "—"}</span>;
  return (
    <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} className={`h-full w-full ${busy ? "opacity-50" : ""}`}>
      {polys.map((s) => (
        <path
          key={s.id}
          d={polygonPathD(s.points, s.closed, s.rounded)}
          fill={s.style.fill}
          stroke={s.style.stroke}
          strokeWidth={s.style.fill === "none" ? ptToPx(s.style.lineWidth) : 0.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
