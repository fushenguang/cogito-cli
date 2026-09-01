# src/extensions/ — the project-mechanics slot (AI write surface)

Mechanics the template's interpreter doesn't know belong HERE, not in edits
to template-owned scene code (`AGENTS.md` rule 10; the write-surface gate in
`pnpm verify` enforces it). First-class examples: timed opportunity windows,
patrolling hazards on data-defined paths, custom counters.

## How a level wires an extension

`public/game-data.json`, on the level that needs the mechanic:

```json
{
  "id": "level-1",
  "name": "第一个愿望",
  "...": "platforms / goal / initialCoins / initialObstacles as usual",
  "extension": {
    "module": "opportunity-window",
    "config": {
      "windowMs": 8000,
      "opportunities": [{ "order": 1, "x": 400, "y": 404, "value": 1 }]
    }
  }
}
```

- `module` → this directory's `<module>.ts` (charset `[A-Za-z0-9-]` only —
  validation rejects anything else, which is also the path-traversal guard).
- `config` → any JSON object; YOUR module interprets it, the schema never
  does. Treat unknown/invalid config as a loud error, not a silent default.

## What a module looks like

```ts
// src/extensions/opportunity-window.ts
import type { GameExtensionModule } from '../extensions-contract'

export const setup: GameExtensionModule['setup'] = (scene, config) => {
  // scene is fully built: scene.player exists, platforms/coins/goal are in
  // the world, registry carries score/highScore, triggers are registered.
  const windowMs = readNumber(config, 'windowMs')   // your own strict reader
  scene.add.rectangle(400, 404, 24, 24, 0x22d3ee)   // any Phaser API
  scene.registry.set('score', scene.registry.get('score') ?? 0)
}
```

The full contract (call timing, floor-preservation duties) is documented in
`src/extensions-contract.ts` — read it before writing your first module.

## Two harness channels your module will likely need

- **Machine-visible triggers** — `score_feedback(condition)` /
  `game_over_trigger(condition)` assertions judge by firing a NAMED trigger.
  Register yours: `import { registerTrigger } from '../debug/harness'` then
  `registerTrigger('catch-opportunity', () => { ... })`. The handler may only
  place/remove/toggle world objects — never move `player` (the harness's
  trigger-integrity check rejects a handler that does).
- **Values that survive restarts** — a counter that must NOT re-zero on
  level restart / state jump (accumulating across levels, say) goes in the
  registry under a name you declare ONCE in `game-data.json`'s top-level
  `"persistValues": ["jar"]`. Declared names get `highScore`'s exact
  has-once initialization in `GameScene.create()` (restarts never re-zero)
  and are reported by the harness's snapshot `values` — which is what the
  `value_persists` assertion reads. Reserved: `score` (re-zeroed by
  design) and `highScore` (template-owned).

## Floors you must not break

- `pnpm build:play`'s postbuild selfcheck plays level 1 with real input
  (hold → + periodic jumps) and pixel-asserts the fixed pages — if your
  mechanic makes level 1 uncompletable or hides player/goal/HUD, **the build
  goes red**. That is by design.
- A module that doesn't export `setup`, or a declared `module` with no file
  here, degrades to the vanilla level with a console warning — the game
  stays playable; your acceptance criteria are what catch the missing work.

Everything you create in this directory is inside the AI write surface
(new files under `src/extensions/` are allowed by the WS gate).
