import Phaser from 'phaser'
import { TITLE_TEXTURE_KEY, BGM_AUDIO_KEY } from '../game-assets'
import { normalizeGameDoc } from '../game-doc'
import { mountStartScreen } from '../screen-dom'

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
 * Issue #11 (2026-09-01) made this page FIXED template infrastructure: the
 * visible page is a DOM overlay (`../screen-dom.ts`'s `mountStartScreen`)
 * driven by `game-doc.json` — title, subtitle, controls, the start button,
 * and a settings panel. The scene class below is only the Phaser-side
 * lifecycle: what renders behind the overlay (a delivered title image if
 * the manifest confirmed one), which scene starts next, and the one gesture
 * that may start BGM. An AI executor never authors this page; a project
 * customizes copy in `public/game-doc.json` (see AGENTS.md's write-surface
 * rule). Layout-role lineage: official examples cataloged in
 * ../../docs/phaser-examples-pattern-index.md §1 (phaserdeno
 * games/mars/scenes/splash.ts — title / instructions / start-prompt).
 *
 * `Start` is a real, listed state (`../debug/state-jump.ts`'s `StateId`,
 * role `'other'` in `../debug/harness.ts`'s `STATE_ROLES`) — see that
 * file's own header doc for why it's treated like Boot/Preload (a
 * sequential step) rather than like `./UiScene.ts` (a parallel overlay
 * excluded from `listStates()` entirely).
 */
export class StartScene extends Phaser.Scene {
  private teardownScreen: (() => void) | null = null

  constructor() {
    super('Start')
  }

  create(): void {
    this.drawBackground()
    this.mountScreen()
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
    if (!this.textures.exists(TITLE_TEXTURE_KEY)) return // no title art — the config's flat fill already shows through (issue #10)
    this.add
      .image(this.scale.width / 2, this.scale.height / 2, TITLE_TEXTURE_KEY)
      .setDisplaySize(this.scale.width, this.scale.height)
  }

  private mountScreen(): void {
    // A missing/invalid `game-doc.json` still gets a complete page — the
    // screens module fills defaults. `normalizeGameDoc()`'s null contract
    // (see ../game-doc.ts) only governs the optional doc PANEL, never the
    // fixed pages: "the auxiliary pages didn't exist yet" is the exact
    // shape issue #11 exists to make impossible.
    const doc = normalizeGameDoc(this.cache.json.get('gameDoc'))
    this.teardownScreen = mountStartScreen({
      doc,
      sound: this.sound,
      onStart: () => this.handleStart(),
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.teardownScreen?.()
      this.teardownScreen = null
    })
  }

  /**
   * 🔴 Browser autoplay policy: audio can only start from inside a real
   * user-gesture handler — a `play()` call made anywhere else (e.g. from
   * `PreloadScene`, the instant `bgm/main.mp3` finishes loading) is exactly
   * the mistake this scene exists to avoid. The start button's
   * `pointerdown` handler — the 开始游戏 click itself — IS that gesture, so
   * it is the one and only place in this template's reference
   * implementation allowed to call `this.sound.play()`.
   *
   * `this.sound` is the Game-level `SoundManager` (shared by every Scene,
   * not owned by this one), so starting playback here means it keeps
   * running through `Game`/`GameOver` without needing to be started again
   * — see `./UiScene.ts`'s mute toggle, which only ever flips
   * `this.sound.mute`, never starts/stops playback itself.
   */
  private handleStart(): void {
    if (this.cache.audio.exists(BGM_AUDIO_KEY) && !this.sound.get(BGM_AUDIO_KEY)) {
      this.sound.play(BGM_AUDIO_KEY, { loop: true })
    }
    this.scene.start('Game')
  }
}
