import Phaser from 'phaser'
import { GAME_WIDTH, PLAYFIELD_HEIGHT } from '../config'
import { registerTrigger } from '../debug/harness'
import type { GameState } from '../debug/state-jump'
import { applyLevelBackground, PLAYER_CHARACTER_KEY, BGM_AUDIO_KEY, FEEDBACK_AUDIO_KEY } from '../game-assets'
import { getGameRules, getLevelByIndex, getLevelCount, getPersistValueNames, type GameLevelEntry, type GameRules } from '../game-data'

/**
 * Game — the actual playable scene: a single-screen PLATFORMER tutorial
 * level, built entirely from `public/game-data.json` (issue #B3, 2026-09-01:
 * a freshly scaffolded project is fully playable by construction — title
 * page → click start → platforms/coins/goal → ending page → restart).
 *
 * Platformer lineage (all cataloged in ../../docs/phaser-examples-pattern-index.md
 * §6, read from source 2026-09-01):
 *   - physics trio (gravity / jump impulse / run speed) as RULES data —
 *     examples/public/src/games/my first game/game.js (gravity y=1000) with
 *     gameObjects/Player.js (jumpVelocity -520, moveVelocity 200); the
 *     scaffold ships a slightly gentler 900/480/200 set.
 *   - jump only while grounded — Player.js's `if (this.body.touching.down)`
 *     (this scene also accepts `blocked.down`, the standing-on-static-body
 *     reading, so either flag grants the jump).
 *   - platforms = static physics rectangles — Platform.js's
 *     `physics.add.existing(this, true)`, minus its tile-art stamping (the
 *     scaffold's placeholder texture is a flat slab; a delivered art pass
 *     can replace the texture without touching geometry).
 *   - goal = static sprite + overlap → level cleared — Game.js's `exits`
 *     group + `exitLevel`, Exit.js's static body.
 *   - collect / hazard — Game.js's `collectStar` (overlap → destroy →
 *     score) and `hitBomb` (overlap → terminal state).
 *
 * The whole level's geometry (spawn, platforms, coins, hazards, goal) and
 * the rules come from the data layer at create() time — there are
 * deliberately NO content constants in this class. This scene is the
 * INTERPRETER; 换数据即换关 (AGENTS.md rule 9).
 *
 * Input rules unchanged from the pre-platformer version (they are
 * infrastructure, not content):
 *   1. Bind input through Phaser's own Keyboard plugin
 *      (`this.input.keyboard`), never raw `window.addEventListener`. Keys
 *      created this way are owned by the scene and torn down with it.
 *   2. Call `addCapture()` for every key your game uses that the browser
 *      also binds to something (Space = scroll, arrows = scroll). This is
 *      the structural fix — not a per-key `event.preventDefault()` you have
 *      to remember to write for every handler.
 *
 * HUD content (score, instructions) does NOT live here — it's drawn by
 * `./UiScene.ts`, launched in parallel below and stopped on shutdown. This
 * scene's own geometry stays within `PLAYFIELD_HEIGHT`, never the full
 * `GAME_HEIGHT` — see `../dimensions.ts`'s HUD band / playfield contract.
 *
 * This scene is also this template's `window.__gameHarness` reference
 * consumer (`../debug/harness.ts`), in two ways:
 *   - `registerTrigger('score'/'gameover', ...)` in `create()` below wires
 *     up what `fire()` can dispatch. Both handlers only ever place a coin
 *     or hazard at the player's position — the *existing* overlap handlers
 *     (`handleCoinCollected`/`handleObstacleHit`) are what actually change
 *     score or transition scenes, exactly like a real player walking into
 *     one would trigger. See `../debug/harness-types.ts`'s `GameHarness`
 *     doc for why a trigger may never write state directly.
 *   - `applyHarnessState()` is the hook `../debug/harness.ts`'s
 *     `applyState()` calls after this scene has (re)started, to push a
 *     validated `jump()` snapshot's score/position onto the fresh instance.
 */
export class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite
  private platforms!: Phaser.Physics.Arcade.StaticGroup
  private coins!: Phaser.Physics.Arcade.StaticGroup
  private obstacles!: Phaser.Physics.Arcade.StaticGroup
  private goal!: Phaser.Physics.Arcade.Sprite
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private jumpKey!: Phaser.Input.Keyboard.Key
  private score = 0
  /**
   * This level's content and this game's rules, taken from the data layer
   * (`../game-data.ts`) at create() time. There are deliberately NO
   * content constants in this class — no hardcoded spawn point, speeds,
   * placements or level number.
   */
  /** 0-based index into `levels` — which level THIS scene instance plays. */
  private levelIndex = 0
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

    // Structural fix for "Space scrolls/locks the page" — see class doc.
    keyboard.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
    ])

    this.cursors = keyboard.createCursorKeys()
    this.jumpKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
    // No addCapture() for R — unlike Space/arrows, a bare "r" keypress has
    // no competing browser default to fight (see class doc rule 2).
    keyboard.on('keydown-R', () => this.scene.restart({ levelIndex: this.levelIndex }))

    // ── Data layer — the whole level's content comes from here ─────────
    // `public/game-data.json`, validated at Preload-time. Taking entries
    // through the accessors is also what fills the harness's
    // `data.usedInScene` evidence. A new level/rule is a data edit, not a
    // scene edit (AGENTS.md rule 9).
    this.levelIndex = resolveLevelIndex(this.scene.settings.data)
    const level = getLevelByIndex(this.levelIndex)
    // Out-of-range index means malformed restart/start data reached us —
    // fail loud, never silently fall back to levels[0] (a wrong level that
    // LOOKS playable is worse than an error).
    if (!level) {
      throw new Error(
        `GameScene: no levels[${this.levelIndex}] in the manifest — restart/start data carried an out-of-range levelIndex`,
      )
    }
    this.level = level
    // Machine-visible "which level is live" — the harness snapshot's
    // `levelId` field (and thus selfcheck SC-6's advance detection) reads
    // exactly this registry key. Not a persistValue: it is scene state,
    // overwritten on every level start by design.
    this.registry.set('levelId', this.level.id)
    this.rules = getGameRules()

    // Gravity is a RULE (content), not engine config — the platformer's
    // whole feel lives in this number. Applying it here keeps `config.ts`
    // renderer/engine-neutral and lets a top-down project simply ship a
    // different rules shape... which validation currently rejects, on
    // purpose: the scaffold IS a platformer, and widening the rule set is a
    // deliberate data-contract change, not a scene hack.
    this.physics.world.gravity.y = this.rules.gravityY

    // Issue #10: `artBackground: false` (the scaffold default) keeps the
    // flat background even when art was delivered — prototype-stage
    // entities stay machine-judgeable by contrast. ABSENT keeps the legacy
    // behavior (draw declared art) so existing projects never change
    // silently; `true` is the explicit opt-in.
    if (this.rules.artBackground !== false) {
      this.drawLevelBackground(this.level.backgroundLevel)
    }

    // ── Static world: platforms, goal, coins, hazards ────────────────────
    // Platforms — Platform.js's static-body pattern: solid rects the player
    // collides with. Coordinates are top-left + size in the data; centered
    // here for Phaser's origin.
    this.platforms = this.physics.add.staticGroup()
    for (const platform of this.level.platforms) {
      const rect = this.add.rectangle(
        platform.x + platform.width / 2,
        platform.y + platform.height / 2,
        platform.width,
        platform.height,
        0x46536e,
        1,
      )
      rect.setStrokeStyle(2, 0x1f2637, 1)
      this.platforms.add(rect, true)
    }

    // Goal / exit — Exit.js's pattern: a static sprite the player overlaps
    // to finish the level. Named so `getSnapshot().entities` reports it
    // (same naming contract as the player) — selfcheck's "终点可达" step
    // reads this entity's coordinates.
    this.goal = this.physics.add.staticSprite(this.level.goal.x, this.level.goal.y, 'goal')
    this.goal.name = 'goal'

    // Coins and hazards are STATIC on purpose: with world gravity on, a
    // dynamic pickup would fall the moment the level starts; static
    // placements stay exactly where the data put them, and overlap against
    // the player still fires (static bodies participate in overlaps).
    this.coins = this.physics.add.staticGroup()
    for (const coin of this.level.initialCoins) {
      this.coins.create(coin.x, coin.y, 'coin')
    }
    this.obstacles = this.physics.add.staticGroup()
    for (const obstacle of this.level.initialObstacles) {
      this.obstacles.create(obstacle.x, obstacle.y, 'obstacle')
    }

    // ── Player ───────────────────────────────────────────────────────────
    // `PLAYER_CHARACTER_KEY` ('player') resolves to whichever texture
    // `PreloadScene` actually registered under that key — an AI-generated
    // character if the manifest listed one keyed exactly `"player"` and it
    // loaded, otherwise the procedural placeholder shape. The SPAWN POINT
    // is level content and comes from the data layer.
    this.player = this.physics.add.sprite(
      this.level.playerSpawn.x,
      this.level.playerSpawn.y,
      PLAYER_CHARACTER_KEY,
    )
    this.player.setCollideWorldBounds(true)
    // Named so `../debug/harness.ts`'s `getSnapshot()` can report it as an
    // `EntitySnapshot` — this is the only entity `controllable` needs to
    // see an x/y change on across a `press()`.
    this.player.name = 'player'

    // ── Physics wiring ───────────────────────────────────────────────────
    // Platformer trio of interactions, straight from the tutorial's
    // Game.js: collider against platforms (stand on them), overlaps for
    // pickups and hazards, overlap against the exit for the win condition.
    this.physics.add.collider(this.player, this.platforms)
    this.physics.add.overlap(this.player, this.coins, (_player, coin) => {
      this.handleCoinCollected(coin as Phaser.Physics.Arcade.Sprite)
    })
    this.physics.add.overlap(this.player, this.obstacles, () => {
      this.handleObstacleHit()
    })
    this.physics.add.overlap(this.player, this.goal, () => {
      this.handleGoalReached()
    })

    // What `fire('score')` / `fire('gameover')` dispatch: each handler only
    // places an object in the world (see class doc / design D3).
    // Re-registered on every `create()` so a restart never leaves a trigger
    // bound to a destroyed instance.
    registerTrigger('score', () => this.spawnCoinAtPlayer())
    registerTrigger('gameover', () => this.spawnObstacleAtPlayer())

    // Confined to PLAYFIELD_HEIGHT, not GAME_HEIGHT — the bottom
    // HUD_BAND_HEIGHT strip belongs to UiScene, not this world.
    this.physics.world.setBounds(0, 0, GAME_WIDTH, PLAYFIELD_HEIGHT)

    // 🔴 Bug found by ia-assertion-runner's `restart` assertion, not by
    // inspection: `this.score` is a class field, and `scene.restart()`
    // re-runs `create()` on the SAME instance. Without this reset, a
    // player who scores then restarts kept their old `this.score` forever.
    this.score = 0
    // Registry is the harness's read path for `score` AND how UiScene's
    // HUD text learns the value — set it here so a fresh/restarted scene
    // reports 0 immediately.
    this.registry.set('score', this.score)

    // 🔴 `highScore` deliberately does NOT get the same treatment as
    // `score` above — `has()` guards this so it is set ONCE, on this game
    // instance's very first `create()`, and never again. Every later
    // `create()` intentionally skips this line, which is exactly what
    // "跨状态不重置" (`value_persists`) means.
    if (!this.registry.has('highScore')) {
      this.registry.set('highScore', 0)
    }

    // Data-declared persist values (game-data.json top-level `persistValues`)
    // get the exact same has-once treatment as `highScore` above: initialized
    // on the first `create()` only, so restarts/state jumps never re-zero
    // them. This is the mechanical half of what `value_persists` judges; the
    // observable half is `harness.ts`'s `readValues()`.
    for (const name of getPersistValueNames()) {
      if (!this.registry.has(name)) {
        this.registry.set(name, 0)
      }
    }

    // Project-specific mechanism hook (2026-09-01; first real consumer:
    // the 小小财迷 v2 reopen's opportunity-window). The ACTIVE level may
    // declare `extension: { module, config }` in game-data.json — see
    // applyLevelExtension() below for the loading contract. Runs AFTER
    // geometry/registry/triggers and BEFORE UiScene launches, so the
    // extension builds on a complete level.
    this.applyLevelExtension()

    // HUD (score text + instructions + doc-panel entry) lives in UiScene,
    // launched in parallel with this scene — see the class doc and
    // dimensions.ts's HUD band / playfield contract. `launch()` is a no-op
    // if UI is already running, and always starts it fresh here because
    // the SHUTDOWN listener below stops it first on every restart/scene-
    // change. `levelKey: this.scene.key` — UiScene's doc-panel entry needs
    // to know which level/scene it's the HUD for.
    this.scene.launch('UI', { levelKey: this.scene.key })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scene.stop('UI')
    })
  }

  /**
   * Wire the active level's `extension` declaration (`levels[i].extension`
   * in game-data.json — validated there: `module` matches
   * `/^[A-Za-z0-9-]+$/`, which is also the path-traversal guard) to its
   * module under `src/extensions/` (the AI write surface, AGENTS.md rule
   * 10; the hook contract lives in `src/extensions-contract.ts`).
   *
   * `import.meta.glob(..., { eager: true })` is resolved at BUILD time —
   * vite inlines every `src/extensions/*.ts` into the bundle (an empty
   * directory contributes nothing), so the lookup is a plain object read,
   * not a runtime import: no async timing window where the level is
   * playable but the mechanic missing.
   *
   * A declared module with no matching file, or one that doesn't export
   * `setup`, degrades to the vanilla level with a console warning — the
   * FLOOR is never held hostage by the ceiling. That missing-implementation
   * case is the project's acceptance criteria's job to catch (the machine
   * judge for the mechanic goes red), not the loader's job to guess at.
   */
  private applyLevelExtension(): void {
    const extension = this.level.extension
    if (!extension) return
    const modules = import.meta.glob<{
      setup?: (scene: GameScene, config: Readonly<Record<string, unknown>> | undefined) => void
    }>('../extensions/*.ts', { eager: true })
    const entry = modules[`../extensions/${extension.module}.ts`]
    if (!entry || typeof entry.setup !== 'function') {
      console.warn(
        `[extension] level "${this.level.id}" declares module "${extension.module}" but src/extensions/${extension.module}.ts does not export setup — playing the vanilla level (check AGENTS.md rule 10)`,
      )
      return
    }
    entry.setup(this, extension.config)
  }

  /**
   * Draws this level's AI-generated background when the rules allow it
   * (issue #10 — see the `artBackground` check in `create()`). The actual
   * "check the texture manager, draw it, pin it behind gameplay, no-op if
   * missing" logic lives in `../game-assets.ts`'s `applyLevelBackground()`.
   * Sized to `PLAYFIELD_HEIGHT`, not `GAME_HEIGHT` — the bottom
   * `HUD_BAND_HEIGHT` strip belongs to `UiScene`.
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
   * `handleStart()` exactly. Why duplicated here instead of left solely on
   * the click: `applyHarnessState()` is ONLY ever invoked from
   * `applyState()` (never from a real playthrough), so this branch never
   * changes when real playback starts — without it, `scripts/verify.mjs`'s
   * AU probe (which reaches 'Game' via `applyState()`, never by
   * dispatching a real click) would see a declared, loaded bgm that never
   * shows as `usedInScene` and fail the AU gate on a project doing
   * everything right.
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
  }

  /**
   * Run + jump, the tutorial Player.js shape: horizontal velocity from
   * cursors, jump only while grounded (Player.js's `body.touching.down`;
   * `blocked.down` added — it's the flag Arcade sets while resting on a
   * static body, which is the standing case this level's platforms create).
   */
  private handleMovement(): void {
    const body = this.player.body as Phaser.Physics.Arcade.Body

    if (this.cursors.left?.isDown) {
      body.setVelocityX(-this.rules.playerSpeed)
    } else if (this.cursors.right?.isDown) {
      body.setVelocityX(this.rules.playerSpeed)
    } else {
      body.setVelocityX(0)
    }

    const grounded = body.blocked.down || body.touching.down
    if (grounded && (this.cursors.up?.isDown || Phaser.Input.Keyboard.JustDown(this.jumpKey))) {
      body.setVelocityY(-this.rules.jumpVelocity)
    }
  }

  /** Shared by coin collection — the only thing that raises score in this scene. */
  private addScore(delta: number): void {
    this.addScoreAbsolute(this.score + delta)
  }

  /**
   * Sets score to an exact value rather than adding a delta — used by
   * `addScore()` above and by `applyHarnessState()`, which needs to land on
   * a snapshot's exact value.
   */
  private addScoreAbsolute(value: number): void {
    this.score = value
    // UiScene's HUD score text updates itself via a `changedata-score`
    // registry listener — this scene never touches that Text object
    // directly, it only ever writes the registry.
    this.registry.set('score', this.score)

    // `highScore` — the one value that MUST survive both a scene restart
    // and applyState() (unlike `score`, which both of those reset).
    const currentHighScore = (this.registry.get('highScore') as number | undefined) ?? 0
    if (this.score > currentHighScore) {
      this.registry.set('highScore', this.score)
    }
  }

  /**
   * `registerTrigger('score', ...)` target. Places a coin exactly where the
   * player is standing so the very next physics step's overlap check finds
   * it — this is "the player walked over a coin", not "give the player a
   * coin". `handleCoinCollected` (the overlap callback) is what actually
   * touches score; this method never does.
   */
  private spawnCoinAtPlayer(): void {
    this.coins.create(this.player.x, this.player.y, 'coin')
  }

  /** `registerTrigger('gameover', ...)` target — same shape, for the failure path. */
  private spawnObstacleAtPlayer(): void {
    this.obstacles.create(this.player.x, this.player.y, 'obstacle')
  }

  private handleCoinCollected(coin: Phaser.Physics.Arcade.Sprite): void {
    coin.destroy()
    this.addScore(this.rules.coinValue)
    this.playFeedback()
  }

  /**
   * Plays the delivered positive-feedback sound (`assets/sfx/feedback.wav`,
   * loaded under `FEEDBACK_AUDIO_KEY` by `PreloadScene`). The
   * `cache.audio.exists()` guard mirrors the bgm consumers: no delivered
   * file ⇒ collecting is simply silent, never an error, never a fallback
   * beep — the "missing asset degrades to nothing" discipline.
   */
  private playFeedback(): void {
    if (this.cache.audio.exists(FEEDBACK_AUDIO_KEY)) {
      this.sound.play(FEEDBACK_AUDIO_KEY)
    }
  }

  /**
   * Hazard hit — the tutorial's `hitBomb` terminal path. GameScene stops
   * here; GameOverScene (role 'gameover', LOSE variant) is what
   * `game_over_trigger` actually judges.
   */
  private handleObstacleHit(): void {
    this.scene.start('GameOver', { score: this.score, cleared: false })
  }

  /**
   * Goal reached — the tutorial's `exitLevel` path: the player overlapped
   * the exit, the level is CLEARED, and GameOverScene renders its win
   * variant. This is the win condition `scripts/selfcheck.mjs` drives the
   * whole chain toward (真实点击开始 → 走到终点 → 过关).
   */
  private handleGoalReached(): void {
    // Multi-level flow (0.9.0): clearing a level that has a successor
    // advances via a Game restart carrying the next index — the whole
    // progression is data-driven, no scene edits. `score` re-zeroes on the
    // advance (per-level value, same contract as an R restart); anything
    // that must survive it lives in `persistValues` (0.8.0), whose
    // has-once initialization deliberately skips re-zeroing here.
    const next = this.levelIndex + 1
    if (next < getLevelCount()) {
      this.scene.restart({ levelIndex: next })
      return
    }
    this.scene.start('GameOver', { score: this.score, cleared: true })
  }
}

/**
 * Reads the 0-based `levelIndex` out of scene start/restart data
 * (`this.scene.settings.data`). Absent data (first `start('Game')`, the
 * GameOver retry button) means level 0 — the shipped scaffold's
 * single-level behavior, unchanged. A present-but-malformed value throws:
 * this only ever comes from our own `restart({ levelIndex })` calls, so
 * anything else is a programming error, not content.
 */
function resolveLevelIndex(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0
  const raw = (data as { levelIndex?: unknown }).levelIndex
  if (raw === undefined) return 0
  // typeof narrows, Number.isInteger guards — both, so `return raw` below
  // lands as `number` without a cast.
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`GameScene received a malformed levelIndex: ${String(raw)}`)
  }
  return raw
}
