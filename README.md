# TikDrawer

A web app to **draw TikZ pictures visually** and get the generated LaTeX
`tikzpicture` code with a live, server-rendered preview.

See [AGENTS.md](AGENTS.md) for architecture and [MEMORY.md](MEMORY.md) for the
running change log.

## Features

- Visual canvas: draw lines, rectangles, circles, ellipses, and text nodes.
- Grid with snap-to-grid; select / move / restyle / delete shapes.
- Live-generated TikZ code (copy, or download a compilable `.tex`).
- Server-side LaTeX preview rendered to SVG.
- **Multiple drawings** saved locally in the browser — switch, rename, delete.

## Requirements (local mode)

The render API shells out to a LaTeX toolchain **installed on your machine**:

- `pdflatex` (TeX Live or MiKTeX)
- `dvisvgm` (ships with TeX Live)

Override the binaries if needed:

| Env var | Default | Meaning |
| --- | --- | --- |
| `TIKDRAWER_LATEX_ENGINE` | `pdflatex` | LaTeX engine binary |
| `TIKDRAWER_DVISVGM` | `dvisvgm` | PDF→SVG converter |
| `TIKDRAWER_TIMEOUT_MS` | `20000` | Per-command timeout |

## Run (local)

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Run with Docker (bundled TeX Live — no local LaTeX needed)

```bash
docker compose up --build
# open http://localhost:3000
```

## Deploying (Vercel UI + Railway render service)

Vercel (and any serverless host) has **no TeX Live**, so `/api/render` can't run
`pdflatex` there. Run the LaTeX renderer separately (the bundled Docker image)
and point the Vercel UI at it.

### 1. Render service on Railway (Docker + TeX Live)

- New Project → **Deploy from GitHub repo** → this repo. Railway detects the
  `Dockerfile` (bundled TeX Live) and builds it. *(The TeX Live base image is
  large, so the first build is slow.)*
- Settings → **Networking → Generate Domain** to get a public URL, e.g.
  `https://tikdrawer-render.up.railway.app`.
- Env vars on Railway: leave `TIKDRAWER_RENDER_URL` **unset** (so it compiles
  locally), and set a secret `TIKDRAWER_RENDER_TOKEN=<random string>`.
- `next start` binds to Railway's injected `PORT` automatically.

### 2. Vercel UI

Set env vars on Vercel and redeploy:

- `TIKDRAWER_RENDER_URL=https://<railway-domain>/api/render`
- `TIKDRAWER_RENDER_TOKEN=<same secret as Railway>`

Vercel's `/api/render` then **proxies** requests to the Railway service
server-side (no CORS), attaching the token header. The Railway service rejects
any request without the matching token.

| Env var | Where | Purpose |
| --- | --- | --- |
| `TIKDRAWER_RENDER_URL` | Vercel only | URL of the Railway `/api/render` to proxy to |
| `TIKDRAWER_RENDER_TOKEN` | both | shared secret guarding the public compiler |

When `TIKDRAWER_RENDER_URL` is unset (local dev / the Docker container itself),
rendering shells out to local `pdflatex` as before.

> Note: image-embed requests send base64 data; keep them under the host's body
> limit (Vercel ~4.5 MB). Or run the whole app from the Docker image (Railway)
> and skip Vercel entirely.

## Security note

User-supplied LaTeX is compiled with shell-escape disabled, a timeout, and an
input-size limit. For any public deployment, run the render service in an
isolated/sandboxed container (the provided Docker image is the intended target).
