# cogito-cli

`cc` — the fixed-pipeline CLI for the [cogito-lib](https://github.com/fushenguang/cogito-lib) game-development platform.

Extracted from [AgentDock](https://github.com/fushenguang/agentdock) (2026-08-30): the game template, the skills channel, and the scaffold/registry versioning now live here as the game-specific line. AgentDock remains the generic scaffold tool.

## Why this exists

Two real dispatch incidents (2026-08-30, platform M1 task 1) proved that requirements like "clear the scaffold sample" or "draw the declared background" cannot live in dispatch prose: they are 100%-must-happen steps, and prose is probabilistic. This repo is the deterministic layer — the pipeline steps that run the same way every time, no prompt involved:

- `cc init` — dedicated project dir + template + (from v0.1.1) neutral sample data
- template harness (`verify.mjs`) — gates that block: BH-0/1/2, per-state render, front-door walk, asset usage (declared ⇒ used), IA assertions
- `cc serve` / `cc evidence` (M-CLI-1 scope) — artifact lifecycle with bind-address check; evidence bundling

Publishing follows AgentDock's changesets flow: merge to `main` → Version Packages PR → npm. Requires the `NPM_TOKEN` repo secret.

## Layout

- `packages/cc` — the CLI (`@cogito.ai/cc`, bin `cc`)
- `templates/game-web-phaser` — the Phaser 4 game scaffold with its verification harness
- `scripts/generate-registry` — template registry generator (runs in the CLI build)
