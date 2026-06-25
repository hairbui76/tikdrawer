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

## Security note

User-supplied LaTeX is compiled with shell-escape disabled, a timeout, and an
input-size limit. For any public deployment, run the render service in an
isolated/sandboxed container (the provided Docker image is the intended target).
