# cogito-cli

`cc` — the fixed-pipeline CLI for the [cogito-lib](https://github.com/fushenguang/cogito-lib) game-development platform.

Extracted from [AgentDock](https://github.com/fushenguang/agentdock) (2026-08-30): the game template, the skills channel, and the scaffold/registry versioning live here as the game-specific line. AgentDock remains the generic scaffold tool.

## Why this exists

Two real dispatch incidents (2026-08-30, platform M1 task 1) proved that requirements like "clear the scaffold sample" or "draw the declared background" cannot live in dispatch prose: they are 100%-must-happen steps, and prose is probabilistic. This repo is the deterministic layer — the pipeline steps that run the same way every time, no prompt involved.

The lesson got sharper on 2026-09-01 (the 小小财迷 M1 verdict: 16 individually-green modules shipping a game the builder rated garbage). The fix is structural, and it is what this repo now ships:

## The template ships factory-playable (v0.6.0)

Out of `cc init`, a project is **already playable end-to-end**: title page → click start → tutorial platformer level → ending page → restart / back to title. The playable floor is the template's own responsibility, re-proven on every build:

- `pnpm build:play` runs a **postbuild selfcheck** (`scripts/selfcheck.mjs` inside the template): real headless Chromium, a real click on the start button, real keyboard through level 1 to the goal, pixel-asserted page copy (region modal-colour + ink ratio with positive/negative controls), back-to-title. A broken journey fails the build — no `applyState` instrument shortcuts, the player path is the one that's judged.
- `pnpm verify` gates: **WS** (write surface — paths changed since the scaffold must stay inside the AI content slots; scene/page code is template-owned), BH-0/1/2 (build/load/render), FD (front-door walk), AU (asset usage: declared ⇒ used), IA (assertions.json judging).
- Fixed auxiliary pages (Start/GameOver/Settings) are DOM overlays with all copy and colours data-driven from `game-doc.json`; the default background is a solid hue-orthogonal colour, so entity visibility is machine-judgeable.
- `levels[0]` keeps a machine-completion invariant: completable by hold→ with periodic jumps — which is exactly how the selfcheck plays it.

The AI executor's job is the fun ceiling — levels, copy, assets, rules — inside the declared slots. The template's `AGENTS.md` (rule 10) and `PROJECT_CONTEXT.md` state the boundary; the WS gate enforces it mechanically.

## Commands

```
cc init       Scaffold a new Cogito project (template + git anchor: root commit "cc init: scaffold")
cc serve      Artifact preview lifecycle: start (reclaim port 8080 by exact PID, verify ANY bind,
              hot-reload watcher) / stop / watch
cc evidence   Collect the standard evidence bundle: verify-result, data files, git state,
              optional per-state playtest screenshots
cc data       Data model pipeline: deliver (publish DATA_MODEL runtime nodes into the spine,
              hash manifest — a record, never a gate)
cc skill      Validate and publish Agent Skills
cc auth       Manage authentication
cc mcp        Start an MCP Stdio server exposing Cogito tools
```

## Layout

- `packages/cc` — the CLI (`@cogito.ai/cc`, bin `cc`)
- `templates/game-web-phaser` — the Phaser 4 game scaffold: factory-playable floor + verification harness + its own `AGENTS.md` contract for AI executors
- `scripts/check-template-playable.mjs` — `pnpm check:template`: the pre-release check (runs on every release, below)
- `scripts/generate-registry` — template registry generator (runs in the CLI build)

## Release

Changesets flow on push to `main`: `.changeset/*.md` present → a Version Packages PR opens; merging it publishes to npm. Requires the `NPM_TOKEN` repo secret.

The release job runs the **factory-playable pre-release check** before publishing: it exercises the exact shipped artifact path — built CLI → `cc init` into a fresh temp dir → frozen install → `build:play` with the 8-step selfcheck. Red blocks publishing: a template edit that breaks the tutorial level is not releasable. The runner is Node 22 (the selfcheck drives Chromium over the built-in global `WebSocket`).
