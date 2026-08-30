import Phaser from 'phaser'
import { GAME_WIDTH, PLAYFIELD_HEIGHT } from '../config'
import { normalizeGameDoc } from '../game-doc'
import { getDocButtonRect, DOC_BUTTON_DIAMETER, DOC_BUTTON_MARGIN_X } from '../doc-panel-geometry'
import { openDocPanel } from '../doc-panel'
import { BGM_AUDIO_KEY } from '../game-assets'

/**
 * UI — the HUD layer, launched in parallel with `GameScene` (`this.scene.launch('UI')`
 * from `GameScene.create()`) and stopped when `GameScene` shuts down.
 *
 * This scene exists to structurally prevent the bug `dimensions.ts`'s HUD
 * band / playfield contract documents: HUD content and world geometry
 * drawn in the same scene, with nothing to keep them apart, ended up
 * visually overlapping. Two rules make that impossible here instead of
 * relying on review to catch it:
 *
 *   1. Everything this scene draws lives inside the reserved HUD band
 *      (`y ∈ [PLAYFIELD_HEIGHT, GAME_HEIGHT]`) — never inside
 *      `[0, PLAYFIELD_HEIGHT]`, which is GameScene's world.
 *   2. Every HUD object calls `setScrollFactor(0)`. This scene has no
 *      camera scroll of its own today (GameScene's world fits entirely in
 *      view), but the moment either scene's camera starts following
 *      anything, an un-pinned HUD object would drift with the world — this
 *      is the same "pin it now, don't wait for the bug" reasoning as the
 *      Scale Manager config in `config.ts`.
 *
 * Score is read from the shared `Phaser.Data.DataManager` (`this.registry`
 * — the same instance every scene sees via `game.registry`) rather than a
 * direct reference to `GameScene`, and kept in sync **event-driven** — a
 * `registry.events.on('changedata-score', ...)` listener set up in
 * `create()` — not by polling the registry every frame in `update()`.
 * This is the pattern Phaser's own bundled `data-manager` skill
 * (`node_modules/phaser/skills/data-manager/SKILL.md`, "Global Registry for
 * Cross-Scene State") documents for exactly this HUD-reads-shared-state
 * shape, and it's cheaper: `setText()` only ever runs when `GameScene`
 * actually calls `registry.set('score', ...)`, not once per rendered frame
 * regardless of whether the score changed.
 *
 * The earlier version of this file polled instead, specifically to dodge a
 * hazard that same skill doc names outright under "Registry Listeners
 * Persist Across Scene Restarts": the registry lives on the `Game` object,
 * not the scene, so a listener attached in `create()` is NOT automatically
 * removed when this scene stops (every restart — R, or `applyState()` —
 * stops and relaunches this scene per `GameScene.ts`'s SHUTDOWN handler).
 * Left unremoved, each restart would add one more listener closing over
 * that life's now-destroyed `scoreText`, and Phaser calls all of them on
 * the next `registry.set('score', ...)`.
 *
 * That hazard has a documented fix, not just a reason to avoid the
 * pattern — the same skill section shows removing the listener on
 * `Phaser.Scenes.Events.SHUTDOWN`. `create()` below does exactly that: one
 * `registry.events.on(...)`, matched by one `registry.events.off(...)` in a
 * `SHUTDOWN` handler, so a listener never outlives the scene instance that
 * owns the Text object it updates.
 *
 * `src/debug/harness.ts`'s `collectHudTexts()` reads Text objects from both
 * the active gameplay scene and this scene (when running) so
 * `hud_text_present`/`score_feedback` keep judging the real, on-screen HUD
 * after it moved here — see that file's doc for the harness-side half of
 * this change.
 *
 * This scene also mounts the in-game documentation entry button (see
 * `mountDocEntry()` below, `../doc-panel.ts`, `../game-doc.ts`) — same HUD
 * band placement discipline as the score/instructions text above, and same
 * reason it lives here rather than in `GameScene`: it's HUD, not world
 * geometry.
 */
export class UiScene extends Phaser.Scene {
  private scoreText!: Phaser.GameObjects.Text
  /**
   * Which scene/level this HUD instance belongs to, for the doc panel's
   * "当前这一关" lookup. Set from `init(data)` — `GameScene.create()`
   * passes its own key via `this.scene.launch('UI', { levelKey: this.scene.key })`
   * (design: whichever scene launches UI owns telling it who it is, rather
   * than UiScene guessing from the scene list). Defaults to this
   * template's own reference scene key so UiScene still behaves sensibly
   * if some future caller launches it without that data.
   */
  private levelKey = 'Game'

  constructor() {
    super('UI')
  }

  init(data: { levelKey?: string }): void {
    this.levelKey = data?.levelKey ?? 'Game'
  }

  create(): void {
    const initialScore = (this.registry.get('score') as number | undefined) ?? 0

    this.scoreText = this.add
      .text(16, PLAYFIELD_HEIGHT + 8, `Score: ${initialScore}`, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: '#e5e7eb',
      })
      .setScrollFactor(0)

    this.add
      .text(GAME_WIDTH / 2, PLAYFIELD_HEIGHT + 40, 'Arrow keys to move · Space to shoot · R to restart', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#9ca3af',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)

    // See class doc: `this.registry.events` is the Game-level emitter, not
    // this scene's own — a listener added here survives this scene
    // instance's death unless explicitly removed, so the SHUTDOWN handler
    // below is not optional cleanup, it's what makes attaching this safe.
    const onScoreChanged = (_registryOwner: Phaser.Game, value: number): void => {
      this.scoreText.setText(`Score: ${value}`)
    }
    this.registry.events.on('changedata-score', onScoreChanged)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.registry.events.off('changedata-score', onScoreChanged)
    })

    this.mountDocEntry()
    this.mountMuteToggle()
  }

  /**
   * Creates the BGM mute toggle — a small circular "🔊"/"🔇" target placed
   * immediately to the left of the doc-entry button, same top-of-HUD-band
   * row, same `DOC_BUTTON_MARGIN_X` gap between the two (see
   * `../doc-panel-geometry.ts`, imported read-only here — this file does
   * not add a new geometry contract of its own for one button: its `y` and
   * size are taken directly from `getDocButtonRect()`, so HUD-band
   * membership is inherited from that already-tested rect rather than
   * re-derived).
   *
   * 🔴 Default-hidden, same discipline as `mountDocEntry()` below: no
   * `bgm/main.mp3` in `game-assets.json` (see `../game-assets.ts`) means
   * `PreloadScene` never registered `BGM_AUDIO_KEY` in the audio cache, and
   * this method returns without adding a dead control that mutes nothing.
   *
   * This toggle only ever flips `this.sound.mute` — it never starts/stops
   * playback itself. Playback is started exactly once, from
   * `../scenes/StartScene.ts`'s "开始游戏" click (the browser's autoplay
   * gesture requirement), and `this.sound` is the Game-level
   * `SoundManager` shared by every Scene, so it keeps playing across a
   * `GameScene` restart without this scene needing to do anything about it
   * beyond reflecting the current `mute` state in its icon.
   */
  private mountMuteToggle(): void {
    if (!this.cache.audio.exists(BGM_AUDIO_KEY)) return

    const docRect = getDocButtonRect()
    const centerX = docRect.x - DOC_BUTTON_MARGIN_X - DOC_BUTTON_DIAMETER / 2
    const centerY = docRect.y + docRect.height / 2
    const radius = DOC_BUTTON_DIAMETER / 2

    const button = this.add.circle(centerX, centerY, radius, 0x374151, 0.92).setScrollFactor(0)
    button.setStrokeStyle(2, 0x9ca3af, 1)
    button.setInteractive({ useHandCursor: true })

    const icon = this.add
      .text(centerX, centerY, this.sound.mute ? '🔇' : '🔊', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '18px',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)

    button.on('pointerdown', () => {
      this.sound.mute = !this.sound.mute
      icon.setText(this.sound.mute ? '🔇' : '🔊')
    })
  }

  /**
   * Creates the in-game documentation entry button — a small circular
   * "?" target, flush against the right edge and top of the reserved HUD
   * band (`../doc-panel-geometry.ts`'s `getDocButtonRect()` is the single
   * source of truth for its placement; `tests/doc-panel-geometry.test.mjs`
   * proves that rect never reaches into the playfield).
   *
   * 🔴 Default-hidden by design (AGENTS.md's brief for this change): if
   * `game-doc.json` was never loaded (missing file — `PreloadScene`
   * queues it via `this.load.json('gameDoc', ...)`, and a 404 there just
   * leaves the cache key absent, it does not throw) or fails
   * `normalizeGameDoc()`'s validation, this method returns without adding
   * anything — not a disabled button, not an empty panel. See
   * `../game-doc.ts`'s `normalizeGameDoc()` doc for why those cases are
   * deliberately not distinguished.
   */
  private mountDocEntry(): void {
    const raw = this.cache.json.get('gameDoc') as unknown
    const doc = normalizeGameDoc(raw)
    if (!doc) return

    const rect = getDocButtonRect()
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    const radius = rect.width / 2

    const button = this.add.circle(centerX, centerY, radius, 0x374151, 0.92).setScrollFactor(0)
    button.setStrokeStyle(2, 0x9ca3af, 1)
    button.setInteractive({ useHandCursor: true })

    this.add
      .text(centerX, centerY, '?', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        fontStyle: 'bold',
        color: '#e5e7eb',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)

    button.on('pointerdown', () => {
      openDocPanel(this.game, doc, this.levelKey)
    })
  }
}
