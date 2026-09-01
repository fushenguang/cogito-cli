import Phaser from 'phaser'
import { normalizeGameDoc } from '../game-doc'
import { mountGameOverScreen } from '../screen-dom'

/**
 * GameOver — the terminal screen, in BOTH endings (issue #11 made it fixed
 * template infrastructure; 2026-09-01 added the win variant):
 *
 *   `cleared: true`  — GameScene's goal overlap fired: the player reached
 *                      the exit (过关), official lineage: examples/public/
 *                      src/games/my first game/scenes/Game.js `exitLevel`.
 *   `cleared: false` — the 'obstacle' overlap fired: the player hit a
 *                      hazard (游戏结束), see `handleObstacleHit` in
 *                      `./GameScene.ts`.
 *
 * The visible page is a DOM overlay (`../screen-dom.ts`'s
 * `mountGameOverScreen`) driven by `game-doc.json`: variant title/subtitle,
 * the final score, and two exits — 再玩一次 (retry → `Game`, the official
 * restart pattern from phaserdeno/games/runner/scenes/gameover.ts's
 * `scene.start('game')`) and 回标题页 (→ `Start`, the official back-to-menu
 * pattern from examples/public/src/games/my first
 * game/scenes/GameOver.js's `scene.start('MainMenu')`). The R key retries,
 * mirroring the keyboard half of runner/gameover.ts's dual-channel restart.
 *
 * This scene still matters to the harness contract exactly as before:
 *   1. It's the failure condition `game_over_trigger` needs to be able to
 *      judge at all — the state whose `StateRole` is `'gameover'`.
 *   2. It's the thing a real player who just lost (or won!) actually sees —
 *      the buttons here are the ways back into gameplay, not debug
 *      conveniences.
 */
export class GameOverScene extends Phaser.Scene {
  private finalScore = 0
  private cleared = false
  private teardownScreen: (() => void) | null = null

  constructor() {
    super('GameOver')
  }

  create(data: { score?: number; cleared?: boolean }): void {
    // `data` comes from `this.scene.start('GameOver', { score, cleared })`
    // in GameScene — Phaser passes whatever was given to `start()` here.
    // Passing data between scenes is the official pattern
    // (examples/public/src/scenes/passing data to a scene.js).
    this.finalScore = data.score ?? 0
    this.cleared = data.cleared ?? false

    const keyboard = this.input.keyboard
    if (!keyboard) {
      throw new Error('Keyboard input plugin is unavailable in this Scene.')
    }
    // Same structural reasoning as GameScene: bind through Phaser's own
    // Keyboard plugin, not window.addEventListener, so the listener is torn
    // down automatically with the scene. R has no browser default action to
    // fight (unlike Space/arrows), so no addCapture() is needed here.
    // Retry — NOT back-to-title — to keep the R key's meaning ("再来一次")
    // identical to what it was before this scene had two exits.
    keyboard.on('keydown-R', () => this.handleRetry())

    const doc = normalizeGameDoc(this.cache.json.get('gameDoc'))
    this.teardownScreen = mountGameOverScreen({
      doc,
      cleared: this.cleared,
      score: this.finalScore,
      onRetry: () => this.handleRetry(),
      onBackToTitle: () => this.handleBackToTitle(),
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.teardownScreen?.()
      this.teardownScreen = null
    })
  }

  private handleRetry(): void {
    this.scene.start('Game')
  }

  private handleBackToTitle(): void {
    this.scene.start('Start')
  }
}
