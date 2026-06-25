# CLAUDE.md

This file guides Claude Code when working in the **TikDrawer** repository.

## Read AGENTS.md first

All project context, architecture, design decisions, stack, and implementation
phases live in [AGENTS.md](AGENTS.md). Follow it. This file only adds the
non-negotiable working rules.

## 🔴 Mandatory rule: update MEMORY.md on every action

**Anything you do in this repo must be recorded in [MEMORY.md](MEMORY.md).**
Before considering a task complete, append a dated entry describing:

- what you did / changed,
- any decision made and why,
- any gotcha, constraint, or follow-up.

Updating `MEMORY.md` is part of the definition of done — not optional.

## Quick reference

- **App:** visual canvas → generated TikZ → server-rendered SVG preview.
- **Stack:** Next.js 15 + React + TypeScript, Tailwind + shadcn/ui, Zustand.
- **Rendering:** server-side LaTeX (TeX Live + dvisvgm) in a sandboxed Docker
  container. Never enable shell-escape; always sandbox and time-limit.
- **Data flow is one-way:** `model → TikZ code → render`. Do not parse TikZ back.
- **Coordinates:** model is in cm, canvas in px, Y axis is flipped. Keep
  conversion in one tested module.

## Language

Project documentation files (CLAUDE.md, AGENTS.md, MEMORY.md) are written in
English.
