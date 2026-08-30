import Phaser from 'phaser'
import type {
  AssetUsageSnapshot,
  DataUsageSnapshot,
  EntitySnapshot,
  GameHarness,
  HarnessSnapshot,
  StateDescriptor,
  StateRole,
  WorldBoundsSnapshot,
} from './harness-types'
import { jump, isValidStart, listStates as listStateIds, type StateId, type GameState } from './state-jump'
import { normalizeGameAssets, planAssetLoads, safeParseJson, GAME_ASSETS_RAW_CACHE_KEY } from '../game-assets'
import { buildDataUsageEvidence, GAME_DATA_RAW_CACHE_KEY } from '../game-data'

/**
 * `window.__gameHarness` reference implementation (design D1/D2/D3).
 *
 * 🔴 Installed **unconditionally** by `src/main.ts` — in both `build:play`
 * and `build:learn`. This is a deliberate, recorded trade (design D3): the
 * IA runner must judge the exact artifact that ships, and letting the two
 * build targets diverge on this would let a real bug hide in whichever one
 * the runner doesn't happen to be looking at. The thing that keeps this
 * acceptable is the **shape** of the API below, not secrecy — see the
 * allow/forbid table on `GameHarness` in `./harness-types.ts`. Do not gate
 * this file's install behind `import.meta.env.MODE`.
 *
 * This module (unlike `harness-types.ts` and `state-jump.ts`) is browser
 * only: it imports Phaser and reaches into live scene instances. Nothing
 * here needs to run under bare Node, and nothing here may be imported by
 * anything that does.
 */

declare global {
  interface Window {
    __gameHarness?: GameHarness
  }
}

/**
 * Roles for this template's five reference states (design D1's `role`
 * field). Kept here, not in `state-jump.ts`, because role is a harness-level
 * judging concept — `state-jump.ts`'s own job is legality/reproducibility,
 * not how an assertion template should read a state.
 *
 * 🔴 `Start` (`../scenes/StartScene.ts`) added here as `'other'` — same
 * role as Boot/Preload, and the same reasoning: it's a real sequential step
 * in the boot chain (Boot -> Preload -> Start -> Game), not a
 * gameplay/gameover state, and NOT a parallel overlay like `UiScene`
 * (deliberately excluded from `StateId`/`listStates()` entirely — see that
 * scene's own class doc). Because `StateId` is a union type and this map is
 * typed `Record<StateId, StateRole>`, TypeScript itself forces this entry
 * to exist the moment `state-jump.ts`'s `StateId` gains `'Start'` — see
 * AGENTS.md rule 6 ("every id returned by listStates() needs an entry in
 * harness.ts's STATE_ROLES map").
 */
const STATE_ROLES: Readonly<Record<StateId, StateRole>> = {
  Boot: 'other',
  Preload: 'other',
  Start: 'other',
  Game: 'gameplay',
  GameOver: 'gameover',
}

/**
 * Scenes that want `applyState()` to do more than just switch to them
 * implement this hook. It is intentionally NOT part of the public
 * `GameHarness` interface — `applyState()` is the only public door, and it
 * only ever calls this with a snapshot that has already passed
 * `isValidStart()`. A scene's `applyHarnessState` is therefore never a free
 * setter: it can only be reached via a validated snapshot, which is exactly
 * the constraint design D3 requires.
 */
interface HarnessAwareScene {
  applyHarnessState?(state: GameState): void
}

type TriggerHandler = () => void

/**
 * Registered by scenes (see `scenes/GameScene.ts`'s `create()`) for
 * `fire()` to dispatch by name. Re-registering under an existing name
 * replaces the handler — this is what keeps triggers correct across a scene
 * restart: `applyState('Game')` restarts GameScene, GameScene's `create()`
 * runs again and re-registers 'score'/'gameover' bound to the *new*
 * instance, so a stale handler pointing at destroyed sprites is never left
 * behind as long as callers follow design D6 ("每条断言前强制 applyState").
 */
const triggers = new Map<string, TriggerHandler>()

export function registerTrigger(name: string, handler: TriggerHandler): void {
  triggers.set(name, handler)
}

/**
 * Contract name `fire()`'s trigger-integrity check (design D1/D2) keys off
 * of. `GameScene.ts` names its player sprite this (task 1.4 / AGENTS.md rule
 * 6) — it is a contract now, not a convention, because the check below is
 * meaningless without it.
 */
const PLAYER_ENTITY_NAME = 'player'

function isKnownStateId(id: string): id is StateId {
  return (listStateIds() as readonly string[]).includes(id)
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How long `press()` holds a key down before releasing it, unless the caller overrides it. */
const DEFAULT_PRESS_DURATION_MS = 100

/**
 * How long `fire()` waits after invoking a trigger's handler before
 * resolving. Triggers only *place something in the world* (design D3) — the
 * actual effect (score bumping, HUD text changing, scene transitioning)
 * happens through Arcade Physics' overlap check on a later physics step,
 * not synchronously inside the handler. Without this wait, a caller taking
 * its "after" snapshot immediately on `fire()` resolving would race the
 * physics step and see stale state.
 */
const TRIGGER_SETTLE_MS = 50

interface KeySpec {
  readonly code: string
  readonly key: string
  readonly keyCode: number
}

/**
 * `press(key, ...)` takes DOM `KeyboardEvent.code` values — the same
 * vocabulary a real browser keyboard event uses — not Phaser's own
 * `KeyCodes` names. This table is the (small, explicit) translation between
 * the two, covering every key this reference game's scenes actually bind.
 * Extend it when a scene adds a new key; there is no reflection trick that
 * would keep this in sync automatically without also making `press()`
 * accept keys no scene has ever wired up.
 */
const KEY_TABLE: Readonly<Record<string, KeySpec>> = {
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: Phaser.Input.Keyboard.KeyCodes.LEFT },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: Phaser.Input.Keyboard.KeyCodes.RIGHT },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: Phaser.Input.Keyboard.KeyCodes.UP },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: Phaser.Input.Keyboard.KeyCodes.DOWN },
  Space: { code: 'Space', key: ' ', keyCode: Phaser.Input.Keyboard.KeyCodes.SPACE },
  KeyR: { code: 'KeyR', key: 'r', keyCode: Phaser.Input.Keyboard.KeyCodes.R },
}

/**
 * Dispatches a real `KeyboardEvent` on `window` — the same target
 * `Phaser.Input.Keyboard.KeyboardManager` listens on by default (see
 * `node_modules/phaser/src/input/keyboard/KeyboardManager.js`, which reads
 * `event.keyCode` to match against registered `Key`s). This is genuinely
 * "a real player could have done this", not a simulation that reaches
 * around Phaser's own input plugin — `press()` never touches a `Key`
 * object or scene state directly.
 */
function dispatchKeyboardEvent(type: 'keydown' | 'keyup', spec: KeySpec): void {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      code: spec.code,
      key: spec.key,
      keyCode: spec.keyCode,
      bubbles: true,
      cancelable: true,
    }),
  )
}

/**
 * Scene key for `../scenes/UiScene.ts` — the HUD layer, launched in
 * parallel with `GameScene` and stopped when it shuts down. Kept as a
 * constant here (not imported from the scene class, which would drag more
 * of the browser-only module graph into this already-browser-only file for
 * no benefit) because two functions below need to agree on it:
 * `activeGameplayScene()` must exclude it, `collectHudTexts()` must
 * specifically include it.
 */
const UI_SCENE_KEY = 'UI'

function activeGameplayScene(game: Phaser.Game): Phaser.Scene | undefined {
  // 🔴 Not "the first active scene" anymore. Since `../scenes/UiScene.ts`
  // was introduced, more than one scene can be active at once (GameScene +
  // UI, running in parallel) — the comment that used to justify
  // `getScenes(true)[0]` ("exactly one scene is ever active at a time") is
  // exactly the assumption that change broke. The actual "which scene is
  // the current *state*" answer is: whichever active scene's key is one of
  // `state-jump.ts`'s `listStates()` — UI is deliberately not a state (see
  // its own doc), so this filter finds the real gameplay/gameover/etc.
  // scene regardless of scene-list order or how many parallel overlay
  // scenes are running.
  //
  // 🔴 Re-verified when `../scenes/StartScene.ts` was added: `Start` IS one
  // of `listStates()`'s ids (role `'other'`, see `STATE_ROLES` above), so
  // while it's the sole active scene this correctly resolves to it (same
  // as Boot/Preload today) rather than to `undefined` — it is not treated
  // like `UiScene`, which is excluded from `listStates()` on purpose. No
  // change to this filter itself was needed: `isKnownStateId()` already
  // generalizes over whatever `state-jump.ts`'s `listStates()` returns.
  return game.scene.getScenes(true).find((scene) => isKnownStateId(scene.scene.key))
}

function collectEntities(scene: Phaser.Scene | undefined): EntitySnapshot[] {
  if (!scene) return []
  const entities: EntitySnapshot[] = []
  for (const child of scene.children.list) {
    const named = child as Phaser.GameObjects.GameObject & { name: string; x?: unknown; y?: unknown }
    if (!named.name) continue // unnamed objects (bullets, coins, obstacles) are deliberately not entities
    if (typeof named.x !== 'number' || typeof named.y !== 'number') continue
    entities.push({ name: named.name, x: named.x, y: named.y })
  }
  return entities
}

/**
 * Reads the live x/y of exactly one named entity — used by `fire()`'s
 * trigger-integrity check (design D1/D2). Deliberately not built on top of
 * `collectEntities()` (which allocates a full array every call): `fire()`
 * calls this synchronously twice, once before and once after the handler,
 * with nothing allowed in between — the leaner scan keeps that pairing
 * obviously symmetric rather than diffing two full-scene snapshots for one
 * name.
 */
function findNamedEntity(scene: Phaser.Scene | undefined, name: string): EntitySnapshot | null {
  if (!scene) return null
  for (const child of scene.children.list) {
    const named = child as Phaser.GameObjects.GameObject & { name: string; x?: unknown; y?: unknown }
    if (named.name !== name) continue
    if (typeof named.x !== 'number' || typeof named.y !== 'number') continue
    return { name: named.name, x: named.x, y: named.y }
  }
  return null
}

/**
 * Read-only world-bounds fact for `getSnapshot()` (trigger-integrity-and-
 * onscreen-gate task 2.1 / design D4). Prefers the active scene's live
 * Arcade Physics world bounds (`GameScene.ts` calls
 * `this.physics.world.setBounds(...)`); falls back to the game's
 * canvas/design-resolution size (`game.scale`, the same coordinate space
 * gameplay code positions entities in — not the CSS-scaled DOM canvas size)
 * when the active scene has no physics world (Boot/Preload). `source` is
 * always reported so a consumer never has to guess which one it got —
 * design D4 flags the fallback as having a real false-positive risk on a
 * horizontally-scrolling game, and that risk must stay visible.
 *
 * 🔴 Read-only, no matching setter — same rule as every other field on
 * `HarnessSnapshot`.
 */
function readWorldBounds(game: Phaser.Game, scene: Phaser.Scene | undefined): WorldBoundsSnapshot {
  const world = (scene as (Phaser.Scene & { physics?: { world?: Phaser.Physics.Arcade.World } }) | undefined)
    ?.physics?.world
  if (world?.bounds) {
    const { x, y, width, height } = world.bounds
    return { x, y, width, height, source: 'physics.world.bounds' }
  }
  return { x: 0, y: 0, width: game.scale.width, height: game.scale.height, source: 'canvas' }
}

function collectTextsFrom(scene: Phaser.Scene | undefined, texts: string[]): void {
  if (!scene) return
  for (const child of scene.children.list) {
    // 🔴 This is the only path to Phaser's on-canvas text — see the
    // proposal's fact ②: canvas-rendered text is invisible to any DOM
    // query, so `hud_text_present` has no other way to judge it.
    if (child instanceof Phaser.GameObjects.Text) {
      texts.push(child.text)
    }
  }
}

/**
 * Reads on-screen text from the active gameplay/gameover/etc. scene AND
 * from `../scenes/UiScene.ts` (the HUD layer) when it's running. Before
 * that scene existed, score/instructions text lived directly inside
 * `GameScene`, so scanning just `scene` was enough — moving it out to a
 * parallel scene (dimensions.ts's HUD band / playfield contract) means
 * `hud_text_present`/`score_feedback` would otherwise stop seeing it the
 * moment it moved, even though it's still genuinely on screen.
 */
function collectHudTexts(game: Phaser.Game, scene: Phaser.Scene | undefined): string[] {
  const texts: string[] = []
  collectTextsFrom(scene, texts)
  if (game.scene.isActive(UI_SCENE_KEY)) {
    collectTextsFrom(game.scene.getScene(UI_SCENE_KEY), texts)
  }
  return texts
}

function readScore(game: Phaser.Game): number | null {
  // `null` vs `0` is load-bearing (see harness-types.ts's HarnessSnapshot
  // doc) — `has()` is what lets a game with no scoring concept report
  // `null` instead of a synthetic zero that would make `restart` trivially
  // pass.
  return game.registry.has('score') ? (game.registry.get('score') as number) : null
}

function readValues(game: Phaser.Game): Readonly<Record<string, number>> {
  // `highScore` (GameScene.ts's `addScoreAbsolute`) is this reference
  // implementation's one value that survives both a scene restart and
  // `applyState()` — unlike `score`, which both of those explicitly zero.
  // That's what makes it the thing `value_persists` can actually judge
  // (design D5's row for this template: "两次相等；values 里没有这个键 ->
  // unmet-precondition"). Read via `has()`, not a `?? 0` fallback: before
  // GameScene's `create()` has run even once (e.g. the harness is queried
  // while still on Boot/Preload), there IS no highScore yet, and reporting
  // a synthesized 0 here would be exactly the "collapse missing into a
  // value" mistake `readScore()`'s own `has()` check already avoids for
  // `score`.
  //
  // This is still a pure read — nothing here writes to the registry, that
  // only happens in GameScene.ts. Adding a value here does not add a setter
  // to GameHarness (design D3's allow/forbid table is about the harness's
  // public methods, not about how many keys `values` happens to have).
  return game.registry.has('highScore') ? { highScore: game.registry.get('highScore') as number } : {}
}

/**
 * Re-derives this project's asset-load plan from the manifest's raw cached
 * text (`../game-assets.ts`'s `GAME_ASSETS_RAW_CACHE_KEY`) instead of
 * threading `PreloadScene`'s own result through the registry. Cheap and
 * pure (`normalizeGameAssets`/`safeParseJson`/`planAssetLoads` do no I/O),
 * and it can never drift from what `PreloadScene` itself queued because
 * both call the exact same pure functions on the exact same cached text —
 * see that constant's own doc for the "same fact stored twice" reasoning.
 *
 * `undefined` cache text (manifest never loaded/404'd) flows straight
 * through `safeParseJson()` -> `normalizeGameAssets()` -> `null`, and
 * `planAssetLoads(null)` returns `[]` — the same missing-manifest degrade
 * every other consumer of this module already relies on.
 */
function declaredAssetTasks(game: Phaser.Game): readonly { key: string; kind: 'image' | 'audio' }[] {
  const raw = game.cache.text.get(GAME_ASSETS_RAW_CACHE_KEY) as string | undefined
  return planAssetLoads(normalizeGameAssets(safeParseJson(raw)))
}

/**
 * Which of `imageKeys` are attached (as `.texture.key`) to a GameObject
 * somewhere in one of the game's currently ACTIVE scenes, right now.
 *
 * 🔴 Same non-recursive discipline as `collectEntities()` above: only each
 * scene's direct `children.list` is scanned, not into `Container`s. And
 * only scenes active *at the moment this runs* are scanned — see
 * `AssetUsageSnapshot`'s doc on why the caller (`scripts/lib/asset-usage.mjs`)
 * unions more than one snapshot rather than trusting a single call to see
 * everything a project ever draws.
 */
function usedImageKeys(game: Phaser.Game, imageKeys: ReadonlySet<string>): string[] {
  if (imageKeys.size === 0) return []
  const used = new Set<string>()
  for (const scene of game.scene.getScenes(true)) {
    for (const child of scene.children.list) {
      const texture = (child as Phaser.GameObjects.GameObject & { texture?: { key?: unknown } }).texture
      const key = texture?.key
      if (typeof key === 'string' && imageKeys.has(key)) used.add(key)
    }
  }
  return [...used]
}

/**
 * Which of `audioKeys` have ever been handed to the game-level
 * `SoundManager` (`this.sound.add()`/`.play()` — see `StartScene.ts`'s BGM
 * playback). Global to the whole `Phaser.Game`, not scoped to any one
 * scene — there is exactly one `SoundManager` per game, shared by every
 * scene — so unlike `usedImageKeys()` this does not depend on which scene
 * is currently active. A hit proves the code referenced this audio key at
 * least once; it does not prove audio is audible right now (browser
 * autoplay-gesture policies can block actual playback even after `.play()`
 * runs — see AGENTS.md rule 8).
 */
function usedAudioKeys(game: Phaser.Game, audioKeys: ReadonlySet<string>): string[] {
  const used: string[] = []
  for (const key of audioKeys) {
    if (game.sound.get(key)) used.push(key)
  }
  return used
}

/**
 * Builds this snapshot's `assets` field (asset-usage-gate design). `null`
 * when the manifest declared nothing usable at all — see
 * `HarnessSnapshot.assets`'s own doc for why that's `null`, not an empty
 * object.
 */
function readAssetUsage(game: Phaser.Game): AssetUsageSnapshot | null {
  const tasks = declaredAssetTasks(game)
  if (tasks.length === 0) return null

  const imageKeys = new Set(tasks.filter((t) => t.kind === 'image').map((t) => t.key))
  const audioKeys = new Set(tasks.filter((t) => t.kind === 'audio').map((t) => t.key))

  const loaded = tasks
    .filter((t) => (t.kind === 'image' ? game.textures.exists(t.key) : game.cache.audio.exists(t.key)))
    .map((t) => t.key)

  const usedInScene = [...usedImageKeys(game, imageKeys), ...usedAudioKeys(game, audioKeys)]

  return {
    declared: tasks.map((t) => ({ key: t.key, kind: t.kind })),
    loaded,
    usedInScene,
  }
}

/**
 * Builds this snapshot's `data` field (game-data-spine design D2). Thin by
 * design: `../game-data.ts`'s `buildDataUsageEvidence()` is a pure,
 * bare-Node-tested function that derives `declared` from the manifest's
 * raw cached text (the same re-derivation pattern as
 * `declaredAssetTasks()` above — no second copy of the manifest ever gets
 * threaded through here) and reads the loader's initialized flag +
 * consumption registry. This wrapper only supplies the game's cache.
 * `null` when nothing was ever declared (no text cached, loader never
 * initialized) — see `HarnessSnapshot.data`'s own doc for why that is a
 * FAILURE fact for `data_from_files`, not a benign absent.
 */
function readDataUsage(game: Phaser.Game): DataUsageSnapshot | null {
  return buildDataUsageEvidence(game.cache.text.get(GAME_DATA_RAW_CACHE_KEY) as string | undefined)
}

function buildSnapshot(game: Phaser.Game): HarnessSnapshot {
  const scene = activeGameplayScene(game)
  return {
    stateId: scene?.scene.key ?? '',
    score: readScore(game),
    entities: collectEntities(scene),
    hudTexts: collectHudTexts(game, scene),
    values: readValues(game),
    worldBounds: readWorldBounds(game, scene),
    assets: readAssetUsage(game),
    data: readDataUsage(game),
  }
}

function listStates(): readonly StateDescriptor[] {
  return listStateIds().map((id) => ({ id, role: STATE_ROLES[id] }))
}

function listTriggers(): readonly string[] {
  return [...triggers.keys()]
}

async function press(key: string, opts?: { durationMs?: number }): Promise<void> {
  const spec = KEY_TABLE[key]
  if (!spec) {
    throw new Error(`harness.press: unknown key "${key}" (not in KEY_TABLE)`)
  }
  const duration = opts?.durationMs ?? DEFAULT_PRESS_DURATION_MS
  dispatchKeyboardEvent('keydown', spec)
  await waitMs(duration)
  dispatchKeyboardEvent('keyup', spec)
}

/**
 * trigger-integrity-and-onscreen-gate design D1/D2. Reads the `player`
 * entity's coordinates synchronously immediately before and immediately
 * after calling the trigger's `handler()` — with NO `await` between the two
 * reads, so nothing (not even a single physics step) can run between them;
 * `handler()` itself is synchronous. Any coordinate difference can
 * therefore only be something `handler()` itself did, never natural motion
 * — that is the entire basis for this being a zero-threshold, zero-false-
 * positive check (design D1). **Do not** turn the comparison below into a
 * tolerance/threshold check (`Math.abs(dx) > n`): immunity to this bug does
 * not scale with how far the player got moved, so "teleported 3 pixels" is
 * still a violation.
 *
 * If no entity named `player` exists, `before`/`after` are both `null` and
 * the check is a silent no-op *here* — by design (D3), `fire()` itself only
 * ever resolves cleanly or throws, it has no channel to report "I didn't
 * check". Surfacing that fact visibly is `scripts/assert.mjs`'s job (see
 * `checkTriggerIntegrityAvailability()` there), not this function's.
 */
async function fire(game: Phaser.Game, trigger: string): Promise<void> {
  const handler = triggers.get(trigger)
  if (!handler) {
    throw new Error(`harness.fire: unknown trigger "${trigger}" (not in listTriggers())`)
  }

  const scene = activeGameplayScene(game)
  const before = findNamedEntity(scene, PLAYER_ENTITY_NAME)

  handler()

  const after = findNamedEntity(scene, PLAYER_ENTITY_NAME)

  if (before && after && (before.x !== after.x || before.y !== after.y)) {
    throw new Error(
      `harness.fire: trigger "${trigger}"'s handler moved the "${PLAYER_ENTITY_NAME}" entity from ` +
        `(${before.x}, ${before.y}) to (${after.x}, ${after.y}) — a trigger handler may only add ` +
        `something to the world and let existing overlap/collision logic react to it; it must never ` +
        `move the player itself (see AGENTS.md rule 6)`,
    )
  }

  await waitMs(TRIGGER_SETTLE_MS)
}

/**
 * The `jump()` -> `isValidStart()` -> live-instance driver (design D2).
 *
 * 🔴 Self-check comes before the switch, never after. A half-legal snapshot
 * MUST return `false` without touching the running game — see design D2's
 * "假 bug 比没测试更糟" (a false bug is worse than no test): if this applied
 * an illegal state first and validated after, an assertion runner could
 * observe a broken-looking game that was never reachable by real play.
 */
async function applyState(game: Phaser.Game, id: string, seed?: number): Promise<boolean> {
  if (!isKnownStateId(id)) return false

  const snapshot = jump(id, seed)
  if (!isValidStart(id, snapshot)) return false

  const targetScene = game.scene.getScene(id)
  if (!targetScene) return false // scene key not registered in this build — nothing to switch to

  await new Promise<void>((resolve) => {
    // Attach the listener before calling `start()`: `Scenes.Events.CREATE`
    // fires from inside Phaser's own update loop (after the scene's
    // `create()` runs), never synchronously from `start()` itself, so
    // ordering here can't race — but attaching first keeps that invariant
    // from ever mattering.
    targetScene.events.once(Phaser.Scenes.Events.CREATE, () => resolve())
    // `SceneManager.start()`: if `id` is already running/paused/sleeping it
    // is shut down and started fresh, which is exactly "reset to a legal
    // starting point" — the same code path handles "jump to a different
    // state" and "reset the current one".
    game.scene.start(id)
  })

  const harnessAware = targetScene as unknown as HarnessAwareScene
  harnessAware.applyHarnessState?.(snapshot)

  return true
}

export function installHarness(game: Phaser.Game): void {
  if (window.__gameHarness) return // idempotent — never overwrite an existing install

  window.__gameHarness = {
    version: 1,
    getSnapshot: () => buildSnapshot(game),
    listStates,
    listTriggers,
    press,
    fire: (trigger) => fire(game, trigger),
    applyState: (id, seed) => applyState(game, id, seed),
  }
}
