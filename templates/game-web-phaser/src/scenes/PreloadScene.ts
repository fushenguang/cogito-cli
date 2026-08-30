import Phaser from 'phaser'
import { GAME_HEIGHT, GAME_WIDTH } from '../config'
import { normalizeGameAssets, planAssetLoads, safeParseJson, PLAYER_CHARACTER_KEY, GAME_ASSETS_RAW_CACHE_KEY } from '../game-assets'
import { initGameData, GAME_DATA_RAW_CACHE_KEY } from '../game-data'

/**
 * Preload — load every asset the game needs before StartScene/GameScene start.
 *
 * This template ships with zero binary assets by default so `pnpm dev`
 * works immediately after `pnpm install` with nothing to fetch or
 * generate — the placeholder textures below are drawn procedurally with
 * Phaser's Graphics API and baked into the texture manager with
 * `generateTexture`. But the platform CAN deliver AI-generated art/audio
 * for a real project, via `public/game-assets.json` + the files it
 * describes (see `../game-assets.ts` for the full manifest contract). This
 * scene is what reads that manifest and queues its files — the manifest
 * itself never needs to be re-read anywhere else; every other scene only
 * ever asks `this.textures.exists(<well-known key>)` /
 * `this.cache.audio.exists(<well-known key>)`.
 *
 * 🔴 Missing/malformed `public/game-assets.json` is an EXPECTED, non-fatal
 * case. A 404 degrades cleanly no matter how it's loaded — a per-file
 * loaderror, never a thrown exception, same as `game-doc.json` below.
 * A response body that ISN'T valid JSON is the one case that behaves
 * differently depending on how you load it: `this.load.json()` calls
 * `JSON.parse()` inside Phaser's own loader internals with no try/catch,
 * so a malformed-but-200 manifest throws an uncaught exception that fails
 * `scripts/verify.mjs`'s BH-1 gate (confirmed by hand). That's why this
 * manifest is loaded as plain text (`this.load.text()`) and parsed with
 * `../game-assets.ts`'s `safeParseJson()` instead — the exact same
 * `JSON.parse()` call, but inside a `try/catch` this codebase controls,
 * so a malformed body degrades to `undefined` (then `null` via
 * `normalizeGameAssets()`) instead of throwing. `planAssetLoads(null)`
 * then queues **nothing** (see `../game-assets.ts`'s doc: no guessed
 * per-file request is ever made without manifest evidence that the file
 * exists). A per-file 404 for a file the manifest DID list behaves the
 * same way as `game-doc.json` — the texture/audio key simply never gets
 * registered, and every consumer already treats "key not present" as the
 * normal, checked case (`this.textures.exists(...)`), never a thrown
 * exception.
 *
 * If you add more assets by hand instead of through the manifest, load
 * them the normal Phaser way in `preload()`:
 *
 *   this.load.image('player', 'assets/player.png')
 *   this.load.audio('shoot', 'assets/shoot.mp3')
 *
 * ...and put the files under `public/assets/` (Vite serves `public/` as-is
 * at the site root). The progress bar below already listens for the
 * standard Phaser loader events, so it will animate correctly once real
 * files are queued — no changes needed there.
 */
export class PreloadScene extends Phaser.Scene {
  private progressBox!: Phaser.GameObjects.Graphics
  private progressBar!: Phaser.GameObjects.Graphics

  constructor() {
    super('Preload')
  }

  preload(): void {
    this.drawLoadingUi()

    this.load.on('progress', (value: number) => {
      this.progressBar.clear()
      this.progressBar.fillStyle(0x60a5fa, 1)
      this.progressBar.fillRect(GAME_WIDTH / 2 - 160, GAME_HEIGHT / 2 - 10, 320 * value, 20)
    })

    // In-game documentation panel content (see ../doc-panel.ts,
    // ../game-doc.ts, ../scenes/UiScene.ts's mountDocEntry()). Loaded here,
    // not fetched ad hoc from UiScene, so it's ready synchronously by the
    // time GameScene/UiScene's create() runs — no async flash of the entry
    // button appearing then disappearing.
    //
    // 🔴 A missing `public/game-doc.json` is an EXPECTED, non-fatal case
    // (see game-doc.ts's header doc: default-hidden is the whole point),
    // not an error to guard against here. Phaser's JSONFile loader treats
    // a failed load as a per-file loaderror — it does not throw, and it
    // does not stop 'complete' from firing for the rest of the queue; the
    // failed key is simply absent from `this.cache.json`, which is exactly
    // what `UiScene.mountDocEntry()` checks for. This also does not fail
    // scripts/verify.mjs's BH-1 gate: a 404 response completes the network
    // request (CDP reports `Network.loadingFinished`), it does not fire
    // `Network.loadingFailed` — BH-1 only fails on genuine network-level
    // failures, not HTTP error statuses.
    this.load.json('gameDoc', 'game-doc.json')

    // AI-generated asset manifest (see ../game-assets.ts). Loaded as plain
    // TEXT, not `this.load.json()` — see this class's header doc for why:
    // a malformed-but-200 response body would otherwise throw inside
    // Phaser's own JSON loader internals instead of degrading cleanly.
    this.load.text(GAME_ASSETS_RAW_CACHE_KEY, 'game-assets.json')

    // 🔴 Queuing the manifest's own files has to happen HERE, mid-preload,
    // triggered by the manifest file's own 'filecomplete' event — not in
    // create(), after the loader has already finished. Phaser's loader
    // accepts new `this.load.image()`/`this.load.audio()` calls made while
    // it is still running (before its 'complete' fires) and folds them
    // into the same load pass; queuing them only after 'complete' would
    // need a second `this.load.start()` pass this scene has no reason to
    // manage. If `game-assets.json` 404s, this listener simply never
    // fires — see `queueManifestAssets()`'s doc for why that's the whole
    // "missing manifest queues nothing" contract, not a special case.
    this.load.once(`filecomplete-text-${GAME_ASSETS_RAW_CACHE_KEY}`, () => {
      const raw = this.cache.text.get(GAME_ASSETS_RAW_CACHE_KEY) as string | undefined
      this.queueManifestAssets(normalizeGameAssets(safeParseJson(raw)))
    })

    // Gameplay-content manifest (see ../game-data.ts). Same load-as-text
    // trick as game-assets.json above, but a DIFFERENT contract: that
    // manifest is platform-delivered and optional (degrades to placeholders);
    // this one is the project's own content and REQUIRED. A missing file
    // leaves the cache key absent, which `initGameData(undefined)` below
    // turns into a thrown, locatable error — see create().
    this.load.text(GAME_DATA_RAW_CACHE_KEY, 'game-data.json')
  }

  create(): void {
    // 🔴 REQUIRED data layer, and the reason this call sits HERE — at page
    // load, before any gameplay scene can run — and not inside a gameplay
    // scene's create(): a bad or missing `game-data.json` must throw where
    // `scripts/verify.mjs`'s BH-1 gate catches it as a clean uncaught
    // exception. Thrown inside a gameplay scene's create() instead, the IA
    // runner's `applyState()` would await a CREATE event that never fires
    // and the whole verify run would hang. Load-time validation failure is
    // the loud, early, correct death (see ../game-data.ts's initGameData doc).
    initGameData(this.cache.text.get(GAME_DATA_RAW_CACHE_KEY) as string | undefined)

    this.progressBox.destroy()
    this.progressBar.destroy()
    this.generatePlaceholderTextures()
    this.scene.start('Start')
  }

  /**
   * Hands every file `../game-assets.ts`'s `planAssetLoads()` decided to
   * queue over to Phaser's loader. Deliberately a thin, untested-by-design
   * shim over that pure function — the actual "queue nothing when the
   * manifest is missing/invalid" decision lives in `planAssetLoads()`
   * itself (bare-Node testable, see `tests/game-assets.test.mjs`); this
   * method's only job is the one thing a pure function cannot do, calling
   * the real Phaser loader.
   */
  private queueManifestAssets(assets: ReturnType<typeof normalizeGameAssets>): void {
    for (const task of planAssetLoads(assets)) {
      if (task.kind === 'image') {
        this.load.image(task.key, task.path)
      } else {
        this.load.audio(task.key, task.path)
      }
    }
  }

  private drawLoadingUi(): void {
    this.progressBox = this.add.graphics()
    this.progressBox.fillStyle(0x222639, 1)
    this.progressBox.fillRect(GAME_WIDTH / 2 - 170, GAME_HEIGHT / 2 - 20, 340, 40)

    this.progressBar = this.add.graphics()

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 50, 'Loading...', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: '#e5e7eb',
      })
      .setOrigin(0.5)
  }

  /** Draw simple shapes into the texture manager so GameScene has sprites to use. */
  private generatePlaceholderTextures(): void {
    // 🔴 Guarded, unlike bullet/coin/obstacle below: if a manifest
    // character was keyed exactly `PLAYER_CHARACTER_KEY` ("player") and
    // loaded successfully, `queueManifestAssets()` (called from preload(),
    // which always runs before create()) already registered a real texture
    // under this exact key — generating a placeholder on top of it would
    // either silently overwrite a real, AI-generated sprite or collide
    // with it, neither of which is "optimistic degrade to a shape", it's
    // clobbering a real asset. `GameScene.ts`'s player sprite always
    // requests this same key, so it transparently gets whichever of the
    // two actually ended up registered.
    if (!this.textures.exists(PLAYER_CHARACTER_KEY)) {
      const player = this.add.graphics()
      player.fillStyle(0x60a5fa, 1)
      player.fillRoundedRect(0, 0, 48, 48, 8)
      player.generateTexture(PLAYER_CHARACTER_KEY, 48, 48)
      player.destroy()
    }

    const bullet = this.add.graphics()
    bullet.fillStyle(0xfacc15, 1)
    bullet.fillCircle(6, 6, 6)
    bullet.generateTexture('bullet', 12, 12)
    bullet.destroy()

    // coin/obstacle: what GameScene's 'score'/'gameover' triggers spawn
    // (see registerTrigger calls in GameScene.create()) — the assertion
    // runner's `fire()` needs *something* in the world to overlap with the
    // player, since triggers may only place objects and let physics react
    // naturally (ia-assertion-runner design D3), never write score/state
    // directly.
    const coin = this.add.graphics()
    coin.fillStyle(0x34d399, 1)
    coin.fillCircle(8, 8, 8)
    coin.generateTexture('coin', 16, 16)
    coin.destroy()

    const obstacle = this.add.graphics()
    obstacle.fillStyle(0xef4444, 1)
    obstacle.fillRect(0, 0, 32, 32)
    obstacle.generateTexture('obstacle', 32, 32)
    obstacle.destroy()
  }
}
