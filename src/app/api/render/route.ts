import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { fullDocument } from "@/lib/generateTikz";

const exec = promisify(execFile);

// When set (e.g. on Vercel, which has no TeX Live), forward render requests to
// an external render service — typically the Docker image deployed on a
// Docker-capable host. Should be the full URL of that service's /api/render.
const RENDER_URL = process.env.TIKDRAWER_RENDER_URL;

// Optional shared secret. When set on the render service, requests must carry a
// matching `x-tikdrawer-token` header — the proxy adds it from the same env —
// so the public compile endpoint can't be abused by arbitrary callers.
const RENDER_TOKEN = process.env.TIKDRAWER_RENDER_TOKEN;

// The render API shells out to a LaTeX toolchain installed on the host machine.
// Override the binaries via env vars if they are not on PATH / named differently.
const ENGINE = process.env.TIKDRAWER_LATEX_ENGINE || "pdflatex";
const DVISVGM = process.env.TIKDRAWER_DVISVGM || "dvisvgm";
const TIMEOUT = Number(process.env.TIKDRAWER_TIMEOUT_MS || 20000);
const MAX_INPUT = 100_000;

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pull the meaningful error lines out of a LaTeX log. */
function extractError(log: string): string {
  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("!")) {
      out.push(...lines.slice(i, i + 4));
    }
  }
  return out.length ? out.join("\n") : log.slice(-1500);
}

type ReqImage = { name: string; dataUrl: string };

export async function POST(req: Request) {
  const body = await req.text();

  // Proxy to an external render service when configured (e.g. on Vercel).
  if (RENDER_URL) {
    try {
      const upstream = await fetch(RENDER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(RENDER_TOKEN ? { "x-tikdrawer-token": RENDER_TOKEN } : {}),
        },
        body,
      });
      const text = await upstream.text();
      return new NextResponse(text, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return NextResponse.json({
        ok: false,
        log: `Could not reach the render service (TIKDRAWER_RENDER_URL): ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // This instance actually compiles. If a token is configured, require it.
  if (RENDER_TOKEN && req.headers.get("x-tikdrawer-token") !== RENDER_TOKEN) {
    return NextResponse.json({ ok: false, log: "Forbidden" }, { status: 403 });
  }

  let tikz: unknown;
  let images: unknown;
  try {
    ({ tikz, images } = JSON.parse(body));
  } catch {
    return NextResponse.json({ ok: false, log: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof tikz !== "string" || tikz.length === 0 || tikz.length > MAX_INPUT) {
    return NextResponse.json({ ok: false, log: "Invalid or oversized TikZ input" }, { status: 400 });
  }

  const dir = await mkdtemp(join(tmpdir(), "tikdrawer-"));
  try {
    // Write any referenced images into the compile dir so \includegraphics finds
    // them. Names are validated to prevent path traversal.
    if (Array.isArray(images)) {
      for (const img of (images as ReqImage[]).slice(0, 30)) {
        if (!img || typeof img.name !== "string" || typeof img.dataUrl !== "string") continue;
        if (!/^img_[a-z0-9]+\.(png|jpe?g)$/i.test(img.name)) continue;
        const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(img.dataUrl);
        if (!m) continue;
        const buf = Buffer.from(m[1], "base64");
        if (buf.length > 8 * 1024 * 1024) continue; // 8 MB cap per image
        await writeFile(join(dir, img.name), buf);
      }
    }

    await writeFile(join(dir, "main.tex"), fullDocument(tikz), "utf8");

    // 1) Compile TeX -> PDF (shell-escape disabled for safety).
    try {
      await exec(
        ENGINE,
        [
          "-no-shell-escape",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-output-directory",
          dir,
          "main.tex",
        ],
        { cwd: dir, timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (e) {
      let log = "";
      try {
        log = await readFile(join(dir, "main.log"), "utf8");
      } catch {
        /* no log produced */
      }
      const err = e as { code?: string; message?: string };
      if (err.code === "ENOENT") {
        return NextResponse.json({
          ok: false,
          log: `LaTeX engine "${ENGINE}" was not found on this machine. Install TeX Live/MiKTeX, or set TIKDRAWER_LATEX_ENGINE.`,
        });
      }
      return NextResponse.json({ ok: false, log: extractError(log) || err.message || "Compilation failed" });
    }

    // 2) Convert PDF -> SVG. --no-fonts traces glyphs as paths so the browser
    //    needs no fonts to display the preview. Use relative filenames with cwd
    //    set — absolute Windows paths in dvisvgm args trigger "API error 87".
    try {
      await exec(DVISVGM, ["--pdf", "--no-fonts", "main.pdf"], {
        cwd: dir,
        timeout: TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string; stderr?: string };
      if (err.code === "ENOENT") {
        return NextResponse.json({
          ok: false,
          log: `"${DVISVGM}" was not found. It ships with TeX Live; or set TIKDRAWER_DVISVGM.`,
        });
      }
      return NextResponse.json({ ok: false, log: err.stderr || err.message || "PDF->SVG conversion failed" });
    }

    const svg = await readFile(join(dir, "main.svg"), "utf8");
    return NextResponse.json({ ok: true, svg });
  } catch (e) {
    return NextResponse.json(
      { ok: false, log: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
