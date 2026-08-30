import Phaser from 'phaser'
import { GAME_HEIGHT, GAME_WIDTH } from '../config'

/**
 * GameOver — reached when GameScene's 'obstacle' overlap fires (see
 * `handleObstacleHit` in `./GameScene.ts`).
 *
 * This scene exists for two reasons at once, and both matter:
 *
 * 1. It's the failure condition `game_over_trigger` needs to be able to
 *    judge at all — before this change, this template had no state whose
 *    `StateRole` was `'gameover'`, so that template could never pass on the
 *    reference implementation (see the ia-assertion-runner proposal's fact
 *    ②, row `game_over_trigger`).
 * 2. It's the thing a real player who just lost actually sees — pressing R
 *    here is not a debug convenience, it's the only way back to gameplay
 *    once GameScene has stopped.
 */
export class GameOverScene extends Phaser.Scene {
  private finalScore = 0

  constructor() {
    super('GameOver')
  }

  create(data: { score?: number }): void {
    // `data` comes from `this.scene.start('GameOver', { score })` in
    // GameScene — Phaser passes whatever was given to `start()` here.
    this.finalScore = data.score ?? 0

    const keyboard = this.input.keyboard
    if (!keyboard) {
      throw new Error('Keyboard input plugin is unavailable in this Scene.')
    }
    // Same structural reasoning as GameScene: bind through Phaser's own
    // Keyboard plugin, not window.addEventListener, so the listener is torn
    // down automatically with the scene. R has no browser default action to
    // fight (unlike Space/arrows), so no addCapture() is needed here.
    keyboard.on('keydown-R', () => {
      this.scene.start('Game')
    })

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, 'Game Over', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '32px',
        color: '#f87171',
      })
      .setOrigin(0.5)

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 14, `Score: ${this.finalScore}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#e5e7eb',
      })
      .setOrigin(0.5)

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 46, 'Press R to restart', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#9ca3af',
      })
      .setOrigin(0.5)
  }
}
