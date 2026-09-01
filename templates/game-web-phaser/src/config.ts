import Phaser from 'phaser'
import { GAME_WIDTH, GAME_HEIGHT } from './dimensions.ts'
import { BootScene } from './scenes/BootScene'
import { PreloadScene } from './scenes/PreloadScene'
import { StartScene } from './scenes/StartScene'
import { GameScene } from './scenes/GameScene'
import { UiScene } from './scenes/UiScene'
import { GameOverScene } from './scenes/GameOverScene'

/**
 * Design-resolution size — declared in `./dimensions.ts` (a leaf module with
 * no imports) and re-exported here so existing `from './config'` importers
 * keep working.
 *
 * It lives there rather than here because `debug/state-jump.ts` needs the
 * same numbers but must stay importable by a bare Node process; this module
 * pulls in Phaser and every scene. See `dimensions.ts` for the full reason.
 */
export { GAME_WIDTH, GAME_HEIGHT, HUD_BAND_HEIGHT, PLAYFIELD_HEIGHT } from './dimensions.ts'

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'app',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  // Issue #10 (2026-09-01): the prototype background is a flat, deliberately
  // "no game would ship this" color, so every entity is machine-judgeable by
  // contrast at scaffold time — see cai-m1-task2-eval's "拼接悖论" verdict:
  // nothing was responsible for what the player actually SEES. Warm dark
  // olive-brown was chosen because it is hue-orthogonal to the whole
  // placeholder entity set (player blue #60a5fa, coin green #34d399,
  // obstacle red #ef4444, platform slate #46536e, goal pennant cyan
  // #22d3ee): every one of those reads as a large RGB distance against
  // #2b2419, and none of them ever blends into it. A real art pass opts back
  // into backgrounds per-level via game-data rules (`artBackground`) or the
  // delivered title/level images.
  backgroundColor: '#2b2419',

  // ─────────────────────────────────────────────────────────────────────
  // Scale Manager — DO NOT remove or change `mode`/`autoCenter` casually.
  //
  // This is the structural fix for a real bug hit before this template
  // existed: a hand-rolled vanilla-JS canvas had no scale manager, so the
  // canvas was positioned by ordinary document flow. On any viewport that
  // didn't exactly match the canvas's pixel size, the canvas — and
  // everything meant to sit below it — ended up offset or clipped out of
  // view.
  //
  // `Phaser.Scale.FIT`         — scale the canvas to fit the parent element
  //                               while preserving aspect ratio (never
  //                               distorts, never overflows).
  // `Phaser.Scale.CENTER_BOTH` — center the canvas both horizontally and
  //                               vertically inside its parent.
  //
  // The parent element (`#app` in index.html) must itself fill the
  // viewport for this to behave correctly — see the CSS reset in
  // index.html for the other half of this fix.
  // ─────────────────────────────────────────────────────────────────────
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    parent: 'app',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },

  physics: {
    default: 'arcade',
    arcade: {
      // Gravity stays 0 HERE on purpose: it is per-game RULES content
      // (`game-data.json` rules.gravityY), applied by GameScene.create() at
      // runtime — see that scene's own comment. Engine config stays neutral
      // so a different game feel is a data edit, not a config fork.
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },

  // Boot -> Preload -> Start -> Game -> GameOver (goal overlap = cleared /
  // obstacle overlap = lost) -> Game again (再玩一次 button, or R) or Start
  // (回标题页 button). Keep scenes single-purpose and split like this
  // instead of doing loading + start screen + gameplay in one file — it's
  // what makes the loading screen, the start screen, and the actual game
  // independently testable/replaceable.
  //
  // `UiScene` is not a step in that chain — it's not a "state" (it has no
  // entry in `debug/state-jump.ts`'s `StateId`/`listStates()`). GameScene
  // launches it in parallel (`this.scene.launch('UI')`) for the duration of
  // gameplay and stops it when GameScene shuts down — see UiScene.ts and
  // dimensions.ts's HUD band / playfield contract. `StartScene`, by
  // contrast, IS a listed state (role `'other'`, same as Boot/Preload) —
  // see its own class doc and `debug/harness.ts`'s `STATE_ROLES`.
  scene: [BootScene, PreloadScene, StartScene, GameScene, UiScene, GameOverScene],
}
