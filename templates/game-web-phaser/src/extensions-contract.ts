/**
 * The extension-module contract — what `src/extensions/<module>.ts` files
 * export and what GameScene promises them (2026-09-01; first real consumer:
 * the 小小财迷 v2 reopen, whose opportunity-window mechanic is the first
 * template-unknown mechanism to live in this slot).
 *
 * This file is TEMPLATE-OWNED (not in the AI write surface — AGENTS.md
 * rule 10): the contract is the boundary between "the platform guarantees
 * the floor" and "the AI builds the ceiling". Projects implement the
 * contract inside `src/extensions/`; they never edit it.
 *
 * Loading: `GameScene.create()` resolves the ACTIVE level's
 * `levels[i].extension` declaration (`src/game-data.ts` — validated there:
 * `module` matches /^[A-Za-z0-9-]+$/, `config` is a plain object) and calls
 * the module's `setup` AFTER the level geometry is built, so extensions see
 * a fully-constructed scene: `scene.player`, platforms, coins, obstacles
 * and `scene.goal` already exist, `scene.registry` already carries
 * `score`/`highScore` (HUD text follows `registry.set('score', ...)`
 * — UiScene listens on `changedata-score`; `game-doc.json`'s
 * `screens.scoreLabel` renames the HUD counter, e.g. 罐).
 *
 * 🟡 Floor-preservation duties of every extension:
 *   - Do NOT remove/hide the player, the goal, or the HUD.
 *   - Do NOT make levels[0] uncompletable by hold→ + periodic jumps
 *     (the postbuild selfcheck plays exactly that way — build:play red).
 *   - Throw loudly on a config you don't understand; degrade visually, not
 *     silently (a missing declared module already degrades to the vanilla
 *     level with a console warning — the loader owns that case, you own
 *     your own config).
 */

import type { GameScene } from './scenes/GameScene.ts'

/**
 * Called once per level start (GameScene.create, after geometry). The scene
 * is live: add sprites/timers/colliders here. Scene shutdown tears down
 * Phaser objects the scene owns — an extension attaching to scene-scoped
 * lifecycles (`scene.events.once('shutdown', ...)`) cleans itself up the
 * same way scene-internal code does.
 */
export type GameExtensionSetup = (
  scene: GameScene,
  /** The `levels[i].extension.config` object from game-data.json, passed through uninterpreted. */
  config: Readonly<Record<string, unknown>> | undefined,
) => void

/** The module shape `src/extensions/<module>.ts` must export. */
export interface GameExtensionModule {
  setup: GameExtensionSetup
}
