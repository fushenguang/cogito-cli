import Phaser from 'phaser'
import { GAME_WIDTH, GAME_HEIGHT } from '../config'
import { TITLE_TEXTURE_KEY, BGM_AUDIO_KEY } from '../game-assets'

/**
 * Start — the first screen a real player actually sees and interacts with.
 *
 * Boot -> Preload -> **Start** -> Game (see `../config.ts`'s scene list).
 * Before this scene existed, `PreloadScene` jumped straight into gameplay
 * the instant loading finished — treating "the prototype" as just the
 * playable loop, with no title, no premise, no deliberate entry point. The
 * builder's brief for this change was explicit: "即使是游戏原型，也从游戏
 * 开始页开始制作，当成一个完整的游戏来做" (even a prototype should be built
 * starting from a start page, as a complete game) — this scene is that
 * structural fix, not a cosmetic add-on.
 *
 * `Start` is a real, listed state (`../debug/state-jump.ts`'s `StateId`,
 * role `'other'` in `../debug/harness.ts`'s `STATE_ROLES`) — see this
 * file's own header doc there for why it's treated like Boot/Preload
 * (a sequential step) rather than like `./UiScene.ts` (a parallel overlay
 * excluded from `listStates()` entirely).
 *
 * Three pieces, each independently optional per the `game-assets.json`
 * contract (`../game-assets.ts`):
 *   1. Background — `TITLE_TEXTURE_KEY` if the platform generated
 *      `public/assets/title.png`, else the plain fill `config.ts`'s
 *      `gameConfig.backgroundColor` already paints behind every scene (no
 *      extra draw call needed for that fallback — see `drawBackground()`).
 *   2. Title/subtitle text — always drawn; `document.title` is what
 *      `index.html`'s `{{PROJECT_NAME}}` placeholder resolves to once the
 *      platform scaffolds a real project, so this scene never hardcodes
 *      the game's name itself.
 *   3. The "开始游戏" button — the only way into `Game`, and (see
 *      `handleStart()`) the one moment this template is allowed to call
 *      `this.sound.play()` at all.
 */
export class StartScene extends Phaser.Scene {
  constructor() {
    super('Start')
  }

  create(): void {
    this.drawBackground()
    this.drawTitle()
    this.drawSubtitle()
    this.drawStartButton()
  }

  /**
   * `this.textures.exists(...)` is the only thing this scene ever asks
   * about the asset manifest — it never reads/parses `game-assets.json`
   * itself. `PreloadScene` already did that (see its `queueManifestAssets()`)
   * and registered the result under `TITLE_TEXTURE_KEY` if and only if a
   * title image both existed in the manifest AND loaded successfully. This
   * keeps "what got loaded" as the single source of truth, rather than
   * this scene re-deciding it from a manifest that could, in principle,
   * disagree with what actually made it into the texture manager.
   */
  private drawBackground(): void {
    if (!this.textures.exists(TITLE_TEXTURE_KEY)) return // no title art — the config's plain fill already shows through
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, TITLE_TEXTURE_KEY).setDisplaySize(GAME_WIDTH, GAME_HEIGHT)
  }

  private drawTitle(): void {
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 90, document.title, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5)
  }

  private drawSubtitle(): void {
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, '准备好了吗？点击下方按钮开始游戏', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
        color: '#9ca3af',
      })
      .setOrigin(0.5)
  }

  private drawStartButton(): void {
    const width = 240
    const height = 60
    const x = GAME_WIDTH / 2
    const y = GAME_HEIGHT / 2 + 60

    const button = this.add.rectangle(x, y, width, height, 0x60a5fa, 1).setInteractive({ useHandCursor: true })
    button.setStrokeStyle(2, 0xe5e7eb, 1)

    this.add
      .text(x, y, '开始游戏', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        fontStyle: 'bold',
        color: '#0f172a',
      })
      .setOrigin(0.5)

    button.on('pointerdown', () => this.handleStart())
  }

  /**
   * 🔴 Browser autoplay policy: audio can only start from inside a real
   * user-gesture handler — a `play()` call made anywhere else (e.g. from
   * `PreloadScene`, the instant `bgm/main.mp3` finishes loading) is exactly
   * the mistake this scene exists to avoid. This `pointerdown` handler —
   * the "开始游戏" click itself — IS that gesture, so it is the one and
   * only place in this template's reference implementation allowed to call
   * `this.sound.play()`.
   *
   * `this.sound` is the Game-level `SoundManager` (shared by every Scene,
   * not owned by this one), so starting playback here means it keeps
   * running through `Game`/`GameOver` without needing to be started again
   * — see `./UiScene.ts`'s mute toggle, which only ever flips
   * `this.sound.mute`, never starts/stops playback itself. `Start` has no
   * path back to itself in this template (GameOverScene restarts straight
   * to `Game`), so this can never double-trigger playback across a replay.
   */
  private handleStart(): void {
    if (this.cache.audio.exists(BGM_AUDIO_KEY) && !this.sound.get(BGM_AUDIO_KEY)) {
      this.sound.play(BGM_AUDIO_KEY, { loop: true })
    }
    this.scene.start('Game')
  }
}
