import Phaser from 'phaser'

/**
 * Boot — runs first, before any assets exist.
 *
 * Keep this scene tiny. Its only job is to configure engine-level settings
 * that must be in place before the Preload scene starts loading anything
 * (e.g. renderer settings, global input config). Do not load game assets
 * here — that belongs in PreloadScene.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot')
  }

  create(): void {
    this.scene.start('Preload')
  }
}
