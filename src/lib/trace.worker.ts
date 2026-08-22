// Web Worker entry: runs the pure tracer off the main thread, so a
// max-detail (1024px) trace doesn't freeze the dialog while it computes.
// Receives raw RGBA (transferred, not copied) + options; posts the result
// back tagged with the caller's run id.

import { traceRgba, type TraceOptions } from "./importRaster";

type TraceRequest = { run: number; buf: ArrayBuffer; w: number; h: number; opts: TraceOptions };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<TraceRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

ctx.onmessage = (e) => {
  const { run, buf, w, h, opts } = e.data;
  const result = traceRgba(new Uint8ClampedArray(buf), w, h, opts);
  ctx.postMessage({ run, result });
};
