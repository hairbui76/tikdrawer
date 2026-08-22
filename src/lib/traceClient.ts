// Browser-side trace entry point: decodes on the main thread (needs <img> +
// canvas), then hands the raw pixels to a Web Worker so the trace itself
// never blocks the UI. Falls back to tracing inline where workers are
// unavailable (SSR, tests, or a worker bootstrap failure).

import {
  DEFAULT_TRACE,
  decode,
  traceImage,
  traceRgba,
  workMax,
  type TraceOptions,
  type TraceResult,
} from "./importRaster";

type Waiter = { resolve: (r: TraceResult) => void; dataUrl: string; opts: TraceOptions };

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const waiters = new Map<number, Waiter>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./trace.worker.ts", import.meta.url));
    } catch {
      workerBroken = true;
      return null;
    }
    worker.onmessage = (e: MessageEvent<{ run: number; result: TraceResult }>) => {
      const w = waiters.get(e.data.run);
      if (w) {
        waiters.delete(e.data.run);
        w.resolve(e.data.result);
      }
    };
    // If the worker dies (CSP, bundling…), rerun every waiter inline — the
    // pixel buffers were transferred away, so re-decode from the data URLs —
    // and stop trying to use workers this session.
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      const orphans = [...waiters.values()];
      waiters.clear();
      for (const o of orphans) traceImage(o.dataUrl, o.opts).then(o.resolve);
    };
  }
  return worker;
}

/** Trace an image data URL off the main thread (inline where impossible). */
export async function traceImageOffThread(
  dataUrl: string,
  opts: TraceOptions = DEFAULT_TRACE,
): Promise<TraceResult> {
  const { data, w, h } = await decode(dataUrl, workMax(opts.detail));
  const wk = getWorker();
  if (!wk) return traceRgba(data, w, h, opts);
  const run = ++seq;
  return new Promise<TraceResult>((resolve) => {
    waiters.set(run, { resolve, dataUrl, opts });
    try {
      wk.postMessage({ run, buf: data.buffer, w, h, opts }, [data.buffer]);
    } catch {
      waiters.delete(run);
      resolve(traceRgba(data, w, h, opts));
    }
  });
}
