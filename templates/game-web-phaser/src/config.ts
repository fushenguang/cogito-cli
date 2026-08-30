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
  backgroundColor: '#1d1f2b',

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
      gravity: { x: 0, y: 0 },
      debug: false,
    },
  },

  // Boot -> Preload -> Start -> Game -> GameOver (on the 'obstacle'
  // overlap) -> Game again (R restarts). Keep scenes single-purpose and
  // split like this instead of doing loading + start screen + gameplay in
  // one file — it's what makes the loading screen, the start screen, and
  // the actual game independently testable/replaceable. `GameOverScene`
  // restarts straight to `Game`, not back through `Start` — the start
  // screen is a one-time entry point for a session, not a state a real
  // player revisits mid-run.
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
