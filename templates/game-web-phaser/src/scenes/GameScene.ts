import Phaser from 'phaser'
import { GAME_WIDTH, PLAYFIELD_HEIGHT } from '../config'
import { registerTrigger } from '../debug/harness'
import type { GameState } from '../debug/state-jump'
import { applyLevelBackground, PLAYER_CHARACTER_KEY, BGM_AUDIO_KEY } from '../game-assets'
import { getActiveLevel, getGameRules, type GameLevelEntry, type GameRules } from '../game-data'

/**
 * Game — the actual playable scene.
 *
 * This is the reference pattern for keyboard input in this template. It
 * exists to structurally prevent a real bug hit before this template
 * existed: pressing Space made the whole game go blank and the page lock
 * up, while a sound effect kept playing.
 *
 * The most likely mechanism for that bug: a hand-rolled `window` /
 * `document` keydown listener that (a) was never tied to the scene
 * lifecycle, so it kept firing after a scene restart/resize referenced
 * stale objects and threw inside the browser's animation-frame loop —
 * which silently kills `requestAnimationFrame`-driven rendering (blank
 * screen) — while the independent Web Audio graph (unrelated to the
 * render loop) kept playing whatever had already been scheduled; and (b)
 * never called `preventDefault()`, so the browser's own "Space scrolls the
 * page" default action fired on top of it.
 *
 * Two rules follow directly from that, both applied below:
 *   1. Bind input through Phaser's own Keyboard plugin
 *      (`this.input.keyboard`), never raw `window.addEventListener`. Keys
 *      created this way are owned by the scene and torn down with it.
 *   2. Call `addCapture()` for every key your game uses that the browser
 *      also binds to something (Space = scroll, arrows = scroll). This is
 *      the structural fix — not a per-key `event.preventDefault()` you
 *      have to remember to write for every handler.
 *
 * HUD content (score, instructions) does NOT live here — it's drawn by
 * `./UiScene.ts`, launched in parallel below and stopped on shutdown. This
 * scene's own geometry (player spawn, world bounds) stays within
 * `PLAYFIELD_HEIGHT`, never the full `GAME_HEIGHT` — see
 * `../dimensions.ts`'s HUD band / playfield contract for why.
 *
 * This scene is also this template's `window.__gameHarness` reference
 * consumer (`../debug/harness.ts`), in two ways:
 *   - `registerTrigger('score'/'gameover', ...)` in `create()` below wires
 *     up what `fire()` can dispatch. Both handlers only ever spawn a coin or
 *     obstacle at the player's position — the *existing* overlap handlers
 *     (`handleCoinCollected`/`handleObstacleHit`) are what actually change
 *     score or transition scenes, exactly like a real player walking into
 *     one would trigger. See `../debug/harness-types.ts`'s `GameHarness` doc
 *     for why a trigger may never write state directly.
 *   - `applyHarnessState()` is the hook `../debug/harness.ts`'s
 *     `applyState()` calls after this scene has (re)started, to push a
 *     validated `jump()` snapshot's score/position onto the fresh instance.
 *     It is not part of this class's public surface in any special way —
 *     it's just a method `applyState()` looks up by name — but it must only
 *     ever be called with an already-`isValidStart()`-checked snapshot.
 */
export class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite
  private bullets!: Phaser.Physics.Arcade.Group
  private coins!: Phaser.Physics.Arcade.Group
  private obstacles!: Phaser.Physics.Arcade.Group
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private spaceKey!: Phaser.Input.Keyboard.Key
  private score = 0
  /**
   * This level's content and this game's rules, taken from the data layer
   * (`../game-data.ts`) at create() time. There are deliberately NO
   * content constants in this class — no hardcoded spawn point, speeds,
   * placements or level number: this scene is the INTERPRETER, the content
   * it builds lives in `public/game-data.json` (game-data-spine design D4:
   * 逐关卡几何/数值进数据，解释器设施留代码). Trial-09's 0-data-files artifact
   * was 3985 lines of exactly the shape these fields must not regress into.
   */
  private level!: GameLevelEntry
  private rules!: GameRules

  constructor() {
    super('Game')
  }

  create(): void {
    // 🔴 Real bug found by ia-assertion-runner's own gates while adding
    // StartScene, not by inspection: `StartScene`'s "开始游戏" button calls
    // `this.scene.start('Game')` through ITS OWN ScenePlugin instance,
    // which (per Phaser's `ScenePlugin.start()`) queues a stop on the
    // *calling* scene (`Start`) as well as a start on the target — so in
    // real play, Start correctly stops itself. But `../debug/harness.ts`'s
    // `applyState()` jumps straight to a state via the game-level
    // `game.scene.start(id)` (`SceneManager.start()`), which — per its own
    // doc — only manages the *target* scene's lifecycle and never touches
    // any other running scene. Landing on `Game` that way (exactly what
    // `pnpm verify`'s IA gate does to test `controllable`/`restart`/etc.)
    // left `Start` active forever from the initial page load, and
    // `activeGameplayScene()`'s scene-list scan picked `Start` (earlier in
    // `config.ts`'s scene array) over `Game` — `getSnapshot()` reported
    // `stateId: 'Start'` with zero entities while `Game` was genuinely
    // running underneath it. Stopping `Start` here, unconditionally and
    // idempotently (`SceneManager.stop()` is a documented no-op on an
    // already-stopped scene), makes "Game has truly begun" true regardless
    // of which of the two `start()` call sites got you here — the same
    // ownership pattern this scene already applies to `UiScene` below.
    this.scene.stop('Start')

    const keyboard = this.input.keyboard
    if (!keyboard) {
      // Keyboard plugin is disabled or unavailable (non-browser context).
      // Fail loudly here instead of leaving the scene half-wired.
      throw new Error('Keyboard input plugin is unavailable in this Scene.')
    }

    // Structural fix for "Space scrolls/locks the page" — see class doc above.
    keyboard.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
    ])

    this.cursors = keyboard.createCursorKeys()
    this.spaceKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
    // No addCapture() for R — unlike Space/arrows, a bare "r" keypress has
    // no competing browser default to fight (see class doc rule 2).
    keyboard.on('keydown-R', () => this.scene.restart())

    // ── Data layer — the whole level's content comes from here ─────────
    // `public/game-data.json`, validated at Preload-time (see that scene's
    // create() for why validation lives THERE). Taking entries through the
    // accessors is also what fills the harness's `data.usedInScene`
    // evidence (`../game-data.ts`'s consumption registry) — the thing the
    // upstream `data_from_files` assertion judges. A new level/rule/word
    // list is a data edit, not a scene edit (AGENTS.md rule 9).
    this.level = getActiveLevel()
    this.rules = getGameRules()

    this.drawLevelBackground(this.level.backgroundLevel)

    // `PLAYER_CHARACTER_KEY` ('player') resolves to whichever texture
    // `PreloadScene` actually registered under that key — an AI-generated
    // character from `public/game-assets.json`, if the manifest listed one
    // keyed exactly `"player"` and it loaded successfully, otherwise the
    // procedural placeholder shape (see `PreloadScene.generatePlaceholderTextures()`'s
    // guard). This scene never branches on which one it got — that's the
    // whole point of both landing on the same key.
    // The SPAWN POINT is level content and comes from the data layer, not
    // from a constant in this class.
    this.player = this.physics.add.sprite(
      this.level.playerSpawn.x,
      this.level.playerSpawn.y,
      PLAYER_CHARACTER_KEY,
    )
    this.player.setCollideWorldBounds(true)
    // Named so `../debug/harness.ts`'s `getSnapshot()` can report it as an
    // `EntitySnapshot` — this is the only entity `controllable` needs to see
    // an x/y change on across a `press()`.
    this.player.name = 'player'

    this.bullets = this.physics.add.group({
      defaultKey: 'bullet',
      maxSize: 30,
    })
    this.coins = this.physics.add.group()
    this.obstacles = this.physics.add.group()

    this.physics.add.overlap(this.player, this.coins, (_player, coin) => {
      this.handleCoinCollected(coin as Phaser.Physics.Arcade.Sprite)
    })
    this.physics.add.overlap(this.player, this.obstacles, () => {
      this.handleObstacleHit()
    })

    // Static placements — data-driven level content, using the same
    // 'coin'/'obstacle' textures the trigger-spawned ones use. Each entry's
    // coordinates were validated against the playfield contract at
    // Preload-time, so no bounds-checking is needed (or wanted) here.
    for (const coin of this.level.initialCoins) {
      const sprite = this.coins.create(coin.x, coin.y, 'coin') as Phaser.Physics.Arcade.Sprite
      sprite.setActive(true).setVisible(true)
    }
    for (const obstacle of this.level.initialObstacles) {
      const sprite = this.obstacles.create(obstacle.x, obstacle.y, 'obstacle') as Phaser.Physics.Arcade.Sprite
      sprite.setActive(true).setVisible(true)
    }

    // What `fire('score')` / `fire('gameover')` dispatch (design D3): each
    // handler only places an object in the world. Re-registered on every
    // `create()` so a scene restart (via R, or `applyState('Game')`) never
    // leaves a trigger bound to a destroyed instance — see the registry doc
    // in `../debug/harness.ts`.
    registerTrigger('score', () => this.spawnCoinAtPlayer())
    registerTrigger('gameover', () => this.spawnObstacleAtPlayer())

    // Confined to PLAYFIELD_HEIGHT, not GAME_HEIGHT — the bottom
    // HUD_BAND_HEIGHT strip belongs to UiScene, not this world (see class
    // doc / dimensions.ts).
    this.physics.world.setBounds(0, 0, GAME_WIDTH, PLAYFIELD_HEIGHT)

    // 🔴 Bug found by ia-assertion-runner's `restart` assertion, not by
    // inspection: `this.score` is a class field, and `scene.restart()` (the
    // real player's R-key path — see `keyboard.on('keydown-R', ...)` below)
    // re-runs `create()` on the SAME instance rather than constructing a new
    // GameScene. Without this reset, a player who scores then restarts kept
    // their old `this.score` forever — the line below's own comment already
    // said the intent was "fresh/restarted scene reports 0", but nothing
    // upstream of it ever made that true. Reset explicitly, here, before
    // anything reads `this.score`.
    this.score = 0
    // Registry is the harness's read path for `score` (`readScore()` in
    // ../debug/harness.ts) — set it here too, not just inside
    // `addScore()`, so a fresh/restarted scene reports 0 immediately
    // instead of whatever the previous life left behind. It's also how
    // `./UiScene.ts`'s HUD score text learns the current value (design:
    // read the shared registry, not a direct scene reference).
    this.registry.set('score', this.score)

    // 🔴 `highScore` deliberately does NOT get the same treatment as
    // `score` above — `has()` guards this so it is set ONCE, on this game
    // instance's very first `create()`, and never again. Every later
    // `create()` (a real restart via R, or `applyState()`) intentionally
    // skips this line, which is exactly what "跨状态不重置" (`value_persists`)
    // means: `score` resets every life, `highScore` must not.
    if (!this.registry.has('highScore')) {
      this.registry.set('highScore', 0)
    }

    // HUD (score text + instructions + doc-panel entry) lives in UiScene,
    // launched in parallel with this scene — see the class doc and
    // dimensions.ts's HUD band / playfield contract. `launch()` is a no-op
    // if UI is already running (e.g. mid-life state churn), and always
    // starts it fresh here because the SHUTDOWN listener below stops it
    // first on every restart/scene-change.
    //
    // `levelKey: this.scene.key` — UiScene's doc-panel entry (see its
    // `mountDocEntry()`) needs to know which level/scene it's the HUD for,
    // to look up `game-doc.json`'s per-level content
    // (`../game-doc.ts`'s `resolveLevelDoc()`). Passed explicitly here
    // rather than UiScene guessing from the scene list, so this stays
    // correct if a future generated game has more than one gameplay scene.
    this.scene.launch('UI', { levelKey: this.scene.key })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scene.stop('UI')
    })
  }

  /**
   * Draws this level's AI-generated background, if `PreloadScene` loaded
   * one for `backgroundLevel` (`public/assets/bg/level<N>.png` via
   * `game-assets.json` — which N belongs to this level is level CONTENT,
   * so it comes from the data layer, not from a constant here). The actual
   * "check the texture manager, draw it, pin it behind gameplay, no-op if
   * missing" logic lives in `../game-assets.ts`'s `applyLevelBackground()`
   * — a shared helper, not a private method on this class — specifically
   * so it survives this class being deleted and replaced by a project's
   * own `Level<N>Scene`(s). See that function's doc for the full contract
   * (sizing, depth, fallback reasoning) and
   * `../../skills/game-flow-and-hud/SKILL.md`'s "Platform-Delivered
   * Assets" section for why this matters: a real project once deleted
   * `GameScene` wholesale and this exact call was the one thing that
   * didn't make it into the replacement scenes.
   *
   * Sized to `PLAYFIELD_HEIGHT`, not `GAME_HEIGHT` — the bottom
   * `HUD_BAND_HEIGHT` strip belongs to `UiScene`, not this world (see class
   * doc / `../dimensions.ts`'s HUD band / playfield contract).
   */
  private drawLevelBackground(backgroundLevel: number): void {
    applyLevelBackground(this, backgroundLevel, GAME_WIDTH, PLAYFIELD_HEIGHT)
  }

  /**
   * Applies a validated `jump()` snapshot (design D2) — called by
   * `../debug/harness.ts`'s `applyState()` only, and only after
   * `isValidStart()` has already accepted the snapshot. This scene's
   * `create()` has already run by the time this fires, so this only needs
   * to override whatever `create()` set to whatever the snapshot says.
   *
   * 🔴 asset-usage-gate per-category judgment (2026-08-22) — also ensures
   * bgm is playing here, mirroring `../scenes/StartScene.ts`'s
   * `handleStart()` exactly (same idempotent
   * `cache.audio.exists() && !sound.get()` guard, same `sound.play(key,
   * {loop:true})` call). Why duplicated here instead of left solely on the
   * click: `applyHarnessState()` is ONLY ever invoked from
   * `../debug/harness.ts`'s `applyState()` (see that file — it is not part
   * of this class's public surface, nothing in a real playthrough calls
   * it), so this branch never runs for an actual player and never changes
   * when real playback starts for one — StartScene's click remains the
   * only real-user autoplay-gesture trigger, completely unchanged.
   *
   * What this closes: `applyState('Game', seed)` only succeeds after
   * `isValidStart()` has confirmed 'Game' is a state a real player COULD
   * be in (design D2) — and the only door into 'Game' is StartScene's
   * "开始游戏" click, so any real player standing here already triggered
   * bgm. Without this, `scripts/verify.mjs`'s AU probe (which reaches
   * 'Game' via `applyState()`, never by dispatching a real click) would
   * see a declared, loaded bgm that never shows as `usedInScene` and fail
   * the AU gate on a project doing everything right — a false failure
   * confirmed by hand (see this change's PR description) against this
   * template's own unmodified reference implementation.
   */
  applyHarnessState(state: GameState): void {
    this.addScoreAbsolute(state.score)
    this.player.setPosition(state.playerX, state.playerY)
    if (this.cache.audio.exists(BGM_AUDIO_KEY) && !this.sound.get(BGM_AUDIO_KEY)) {
      this.sound.play(BGM_AUDIO_KEY, { loop: true })
    }
  }

  update(): void {
    this.handleMovement()
    this.handleShooting()
    this.cleanUpBullets()
  }

  private handleMovement(): void {
    const body = this.player.body as Phaser.Physics.Arcade.Body
    body.setVelocity(0, 0)

    if (this.cursors.left?.isDown) {
      body.setVelocityX(-this.rules.playerSpeed)
    } else if (this.cursors.right?.isDown) {
      body.setVelocityX(this.rules.playerSpeed)
    }

    if (this.cursors.up?.isDown) {
      body.setVelocityY(-this.rules.playerSpeed)
    } else if (this.cursors.down?.isDown) {
      body.setVelocityY(this.rules.playerSpeed)
    }
  }

  private handleShooting(): void {
    if (!Phaser.Input.Keyboard.JustDown(this.spaceKey)) return

    const bullet = this.bullets.get(this.player.x, this.player.y - 30) as
      | Phaser.Physics.Arcade.Sprite
      | undefined
    if (!bullet) return // pool exhausted — fine, just skip this shot

    bullet.setActive(true).setVisible(true)
    const body = bullet.body as Phaser.Physics.Arcade.Body
    body.enable = true
    body.setVelocity(0, -this.rules.bulletSpeed)

    this.addScore(this.rules.shootValue)
    this.playBeep()
  }

  private cleanUpBullets(): void {
    for (const child of this.bullets.getChildren()) {
      const bullet = child as Phaser.Physics.Arcade.Sprite
      if (bullet.active && bullet.y < -20) {
        this.bullets.killAndHide(bullet)
        const body = bullet.body as Phaser.Physics.Arcade.Body
        body.enable = false
      }
    }
  }

  /** Shared by shooting and coin collection — the only two things that change score. */
  private addScore(delta: number): void {
    this.addScoreAbsolute(this.score + delta)
  }

  /**
   * Sets score to an exact value rather than adding a delta — used by
   * `addScore()` above and by `applyHarnessState()`, which needs to land on
   * a snapshot's exact value, not add to whatever the scene already had.
   */
  private addScoreAbsolute(value: number): void {
    this.score = value
    // UiScene's HUD score text updates itself via a `changedata-score`
    // registry listener (see UiScene.ts's create()) — this scene never
    // touches that Text object directly, it only ever writes the registry.
    this.registry.set('score', this.score)

    // `highScore` — the one value in this reference implementation that
    // MUST survive both a scene restart and applyState() (unlike `score`,
    // which both of those explicitly reset to 0). See `create()`'s
    // "set only if absent" registry init below for the other half of that
    // contract, and `../debug/harness.ts`'s `readValues()` for where it's
    // exposed to the `value_persists` assertion template. Read via
    // `.get(...) ?? 0` (not `.has()`) here specifically because this method
    // runs from inside `create()` on the very first life, before the
    // "set only if absent" init below has necessarily run yet on some
    // engine startup orderings — `?? 0` is a safe floor either way.
    const currentHighScore = (this.registry.get('highScore') as number | undefined) ?? 0
    if (this.score > currentHighScore) {
      this.registry.set('highScore', this.score)
    }
  }

  /**
   * `registerTrigger('score', ...)` target. Spawns a coin exactly where the
   * player is standing so the very next physics step's overlap check finds
   * it — this is "the player walked over a coin", not "give the player a
   * coin". `handleCoinCollected` (the overlap callback) is what actually
   * touches score; this method never does.
   */
  private spawnCoinAtPlayer(): void {
    const coin = this.coins.create(this.player.x, this.player.y, 'coin') as Phaser.Physics.Arcade.Sprite
    coin.setActive(true).setVisible(true)
  }

  /** `registerTrigger('gameover', ...)` target — same shape as spawnCoinAtPlayer(), for the failure path. */
  private spawnObstacleAtPlayer(): void {
    const obstacle = this.obstacles.create(this.player.x, this.player.y, 'obstacle') as Phaser.Physics.Arcade.Sprite
    obstacle.setActive(true).setVisible(true)
  }

  private handleCoinCollected(coin: Phaser.Physics.Arcade.Sprite): void {
    coin.destroy()
    this.addScore(this.rules.coinValue)
  }

  private handleObstacleHit(): void {
    // GameScene stops here; GameOverScene (role 'gameover') is what
    // `game_over_trigger` actually judges — see its class doc.
    this.scene.start('GameOver', { score: this.score })
  }

  /**
   * Tiny synthesized beep via the Web Audio graph Phaser already owns.
   * Deliberately defensive: audio must never be able to throw and take
   * down the render loop (see the class-level bug writeup above).
   */
  private playBeep(): void {
    const soundManager = this.sound
    if (!(soundManager instanceof Phaser.Sound.WebAudioSoundManager)) return

    try {
      const ctx = soundManager.context
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'square'
      oscillator.frequency.setValueAtTime(880, ctx.currentTime)
      gain.gain.setValueAtTime(0.05, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start()
      oscillator.stop(ctx.currentTime + 0.08)
    } catch {
      // Audio is a nice-to-have. Never let it break gameplay.
    }
  }
}
