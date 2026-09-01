# Project Context

> Cross-session handoff notes. This file exists because agent sessions are stateless between runs — whoever (human or AI) picks this project up next should be able to read this file and understand where things stand without re-deriving it from the diff.
>
> **Update this after every meaningful step.** A stale or empty version of this file is worse than none — the next session will trust it.

## Factory state (as scaffolded — read before your first edit)

This template ships **factory-playable**: out of `cc init`, the project already plays end-to-end — title page → click start → tutorial platformer level (walk right, reach the goal flag) → ending page → restart / back to title. That floor is structural, not your achievement and not your burden to rebuild:

- `pnpm build:play` **fails the build** if that full journey breaks (postbuild selfcheck: real click, real keyboard, pixel-asserted page copy — see AGENTS.md acceptance #2).
- `pnpm verify` fails if any path outside the **AI write surface** changed since the scaffold (AGENTS.md rule 10): you own `public/game-data.json`, `public/game-doc.json`, `public/game-assets.json`, `assertions.json`, `README.md`, this file, and new files under `public/`, `src/extensions/`, `docs/`, `assets/`. Scene/page/script code is template-owned and read-only for you.
- `levels[0]` must stay completable by "hold → with periodic jumps" — the selfcheck plays it exactly that way (machine-completion invariant, AGENTS.md rule 10).
- The fixed pages render their copy through DOM overlays (`src/screen-dom.ts`), text sourced from `game-doc.json`'s `screens`/`theme`. Recorded 2026-09-01: measured on this scaffold's own build (macOS headless), Phaser Text rendered fine too — DOM is chosen for environment-independence (the browser's primary text pipeline), not because headless can't render Text. Don't migrate the pages to Phaser Text; customize via `game-doc.json`.

Your job is the ceiling, not the floor: turn the tutorial data into a real game — levels, copy, assets, rules — inside the slots above.

## What (current state)

- _Describe the game concept in one or two sentences._
- _List what's actually playable right now vs. what's stubbed/placeholder._

## Why (decisions & rationale)

- _Record any non-obvious choices and why — e.g. "chose top-down movement over platformer physics because ..."_
- _Record anything you tried and reverted, and why, so the next session doesn't repeat it._

## Next steps

- [ ] _Next concrete task._
- [ ] \_...

## Known issues / gotchas

- _Anything broken, half-finished, or surprising that isn't obvious from the code._

## Session log

Append one entry per work session — newest at the top. Keep entries short; this is a log, not a diary.

### YYYY-MM-DD

- _What changed._
- _What was verified (and how — see AGENTS.md rule 5 on verifying real rendered behavior, not just property values)._
- _What's left for next time._
