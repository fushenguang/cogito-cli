// 🔴 Imports from `../dimensions` — a leaf module with **no imports** — and
// deliberately NOT from `../config`, whose module graph pulls in Phaser and
// all three scene classes (none of which run under a bare Node process: no
// DOM, no WebGL). Importing config here would make this contract, and
// tests/state-jump.test.mjs, runnable only inside a browser.
//
// The first attempt hand-copied these two values instead. That is the "same
// fact stored twice" shape: changing the design resolution in one place
// only would leave the traversal assertion passing against stale bounds,
// and nothing would fail. The leaf module removes the choice.
// 🔴 扩展名 `.ts` 是必须的，不是笔误：这个模块要被 **bare Node** import
// （`node --test` 直接跑 `tests/state-jump.test.mjs`，那里也是写 `.ts` 的）。
// 省掉扩展名只有打包器解析得动，Node 会 ERR_MODULE_NOT_FOUND——而那正好
// 会让这条契约退回“只能在浏览器里跑”，也就丢掉它存在的意义。
// tsconfig 已开 `allowImportingTsExtensions`，所以类型检查也认。
import { GAME_WIDTH, PLAYFIELD_HEIGHT } from '../dimensions.ts'

/**
 * State-jump contract (design D5) — the pure driver `harness.ts`'s
 * `applyState()` sits on top of (ia-assertion-runner design D2: `jump()`
 * stays a pure function, `applyState()` is the browser-side consumer that
 * applies its output to a live instance).
 *
 * This file also ships a minimal reference implementation for this
 * template's own five states (Boot/Preload/Start/Game/GameOver). It
 * deliberately does NOT decide how a larger, discrete-state game should
 * enumerate `listStates()` — the proposal explicitly leaves that undecided
 * until a real platformer track needs it.
 *
 * 🔴 `Start` (`../scenes/StartScene.ts`) is included here — unlike
 * `../scenes/UiScene.ts`, which is deliberately NOT a state (it's a
 * parallel HUD overlay, not a step in the boot sequence; see its own class
 * doc). `Start` sits in the same sequential Boot -> Preload -> ... chain
 * Boot/Preload already occupy, so it gets the same treatment: a real
 * engine state with role `'other'` (see `harness.ts`'s `STATE_ROLES`), not
 * a gameplay/gameover role and not excluded from `listStates()` the way
 * UI is.
 */

export type StateId = 'Boot' | 'Preload' | 'Start' | 'Game' | 'GameOver'

/**
 * A snapshot of the state `jump()` landed on. Deliberately plain,
 * serialisable data — no live Phaser objects — so it can be deep-compared
 * for the reproducibility assertion in tests/state-jump.test.mjs without a
 * browser/DOM.
 */
export interface GameState {
  readonly id: StateId
  readonly seed: number
  readonly score: number
  readonly playerX: number
  readonly playerY: number
}

/** Every state this template's reference implementation knows about. */
export function listStates(): StateId[] {
  return ['Boot', 'Preload', 'Start', 'Game', 'GameOver']
}

/**
 * Deterministically produce a legitimate starting snapshot for `id`.
 *
 * 🔴 The same (id, seed) pair MUST always produce a deeply-equal result —
 * that's what lets a future assertion runner replay a state without
 * depending on how a real player got there (design D5). Legality
 * (`isValidStart`) and reproducibility are two independent properties this
 * function has to satisfy at once.
 */
export function jump(id: StateId, seed = 0): GameState {
  // This reference implementation has no seed-dependent randomness yet —
  // this template ships zero procedural spawning. `seed` is still threaded
  // through and stored on the returned state so the contract's shape is
  // exercised end-to-end, and so a future state that DOES need randomness
  // (e.g. procedurally placed enemies) has somewhere to plug it in without
  // changing the contract.
  //
  // 🔴 GameOverScene and StartScene have no player sprite of their own, so
  // `playerX`/`playerY` here are just the same placeholder shape every
  // other state gets — they are never applied to anything for
  // `id === 'GameOver'` or `id === 'Start'` (see `harness.ts`'s
  // `applyState`, which only calls a scene's `applyHarnessState` hook when
  // one exists, and neither scene implements it). Keeping the shape
  // uniform across all five states, instead of making it conditional per
  // id, is what keeps this function's reproducibility property simple to
  // state and simple to test — see `tests/state-jump.test.mjs`'s traversal
  // assertion, which iterates `listStates()` without special-casing any
  // one of them.
  return {
    id,
    seed,
    score: 0,
    // 🔴 A fixed REFERENCE start, not a mirror of the game's spawn: since the
    // data spine (game-data-spine), where the player spawns is level CONTENT
    // and lives in `public/game-data.json` — this contract deliberately does
    // NOT read it (that would couple the state-legality contract to the data
    // layer and break this module's bare-Node importability). Any in-bounds
    // point is a legal start; `applyState()` overriding the data-driven
    // spawn with this point is the same "synthetic but legal" move it
    // already makes for score. PLAYFIELD_HEIGHT, not GAME_HEIGHT — the
    // bottom HUD_BAND_HEIGHT strip is UiScene's, not world space (see
    // dimensions.ts's HUD band / playfield contract).
    playerX: GAME_WIDTH / 2,
    playerY: PLAYFIELD_HEIGHT - 80,
  }
}

/**
 * Is `state` a legal starting point for `id`?
 *
 * 🔴 This MUST be indistinguishable, in legality terms, from having played
 * to `id` normally — a half-legal state passed here would let a future
 * assertion runner "catch" a bug that was never real (proposal: "假 bug 比
 * 没测试更糟", a false bug is worse than no test).
 */
export function isValidStart(id: StateId, state: GameState): boolean {
  if (state.id !== id) return false
  if (!Number.isInteger(state.seed)) return false
  if (!Number.isFinite(state.score) || state.score < 0) return false
  if (!Number.isFinite(state.playerX) || !Number.isFinite(state.playerY)) return false

  if (id === 'Game') {
    // A legal start of Game must place the player inside the world bounds
    // GameScene actually enforces (`this.physics.world.setBounds(0, 0,
    // GAME_WIDTH, PLAYFIELD_HEIGHT)` in src/scenes/GameScene.ts — PLAYFIELD_HEIGHT,
    // not GAME_HEIGHT, since the bottom HUD_BAND_HEIGHT strip belongs to
    // UiScene, not this world) — a player outside that box is not a legal
    // *starting point*, even though it might be a state a real bug could
    // produce mid-game.
    if (state.playerX < 0 || state.playerX > GAME_WIDTH) return false
    if (state.playerY < 0 || state.playerY > PLAYFIELD_HEIGHT) return false
  }

  // GameOver and Start deliberately get no extra checks beyond the base
  // ones above — neither has world bounds of its own to violate. Add a
  // branch here only if GameOverScene/StartScene grows state that can
  // genuinely be half-baked.

  return true
}
