/**
 * `game-data.json` contract — the project's gameplay-content data layer
 * (see `./scenes/PreloadScene.ts` for the loader half, `./scenes/GameScene.ts`
 * for the consumer half).
 *
 * Why this exists: this template's answer to "what is a game" is
 * **data + interpreter**. Gameplay CONTENT (level layouts, rule parameters,
 * word lists) lives in `public/game-data.json`; scene classes are the
 * interpreter that reads it. The builder's brief for this change is
 * trial-09's hardest negative reading: a generated project shipped
 * **0 independent data files vs 3985 lines of scene code** — vocabulary,
 * levels and rules all hardcoded inside scene classes — and every machine
 * assertion was green, because nothing could see the difference. The fix is
 * two-sided: this module gives "content lives in data" a concrete, checkable
 * home, and the upstream `data_from_files` assertion template (judge in
 * `scripts/assert.mjs`) makes its absence a red failure rather than a style
 * preference.
 *
 *   public/game-data.json   the manifest this module parses — REQUIRED.
 *                           Unlike `game-assets.json` (platform-delivered,
 *                           optional), this is the project's own content:
 *                           a scaffolded project that deletes it has
 *                           deleted its game content.
 *
 * Sections:
 *   levels     required, non-empty. Per-level geometry: where the player
 *              spawns, what the level starts with on screen, which
 *              background (`public/assets/bg/level<N>.png`) it uses.
 *   rules      optional in the contract, consumed by the reference scene:
 *              gameplay parameters (speeds, score weights) that are the
 *              same across levels of one game.
 *   vocabulary optional, free-form map — for games whose content is word
 *              lists (the "用话造关" family). The reference game has none;
 *              the section exists so those games don't invent their own
 *              convention.
 *
 * 🔴 Unlike `./game-assets.ts`'s per-field degrade, this contract is
 * STRICT: a manifest that parses but has nothing consumable (empty
 * `levels`, a level entry missing content fields, a spawn point outside
 * the playfield) is an ERROR, never a silent empty. An empty-shell
 * manifest is the first form of "fake data to pass the gate" and must die
 * at validation — see `parseAndValidateGameData()`.
 *
 * Kept importable by a bare Node process (its only imports are
 * `./game-assets.ts` — itself import-free — and `./dimensions.ts`, a
 * leaf module) for the same reason as `./game-assets.ts`: both the browser
 * loading code and `tests/game-data.test.mjs` need it without dragging in
 * a DOM or WebGL.
 *
 * 🔴 Data modules (`src/data/*.ts`) were considered and rejected (design
 * D1): once data is bundled into JS, "declared / loaded / consumed" stops
 * being mechanically distinguishable and the evidence layer collapses to
 * one. Content stays in JSON; this module stays its only door.
 */
import { GAME_WIDTH, PLAYFIELD_HEIGHT } from './dimensions.ts'
import { safeParseJson } from './game-assets.ts'

/** Cache key `PreloadScene` loads `public/game-data.json` under (as plain text — same reasoning as `GAME_ASSETS_RAW_CACHE_KEY`). */
export const GAME_DATA_RAW_CACHE_KEY = 'gameDataRaw'

/** The sections of `game-data.json` an entry can belong to. Mirrors the manifest's top-level keys. */
export type GameDataSection = 'levels' | 'rules' | 'vocabulary'

/**
 * One entry the manifest declares — the unit the three-layer evidence
 * (`DataUsageSnapshot` below / `src/debug/harness-types.ts`) counts.
 * `levels:<id>` per level, `rules` once, `vocabulary:<key>` per word.
 */
export interface DataEntrySnapshot {
  readonly id: string
  readonly section: GameDataSection
}

/** Three-layer data-usage evidence for `getSnapshot().data` (game-data-spine design D2). */
export interface DataUsageSnapshot {
  readonly declared: readonly DataEntrySnapshot[]
  readonly loaded: readonly DataEntrySnapshot[]
  readonly usedInScene: readonly DataEntrySnapshot[]
}

/** A position in world space. All gameplay geometry stays within `y ∈ [0, PLAYFIELD_HEIGHT]` (dimensions.ts's HUD band contract). */
export interface SpawnPoint {
  readonly x: number
  readonly y: number
}

/** One level's content. Everything here is DATA: changing it changes the level, with zero scene-code edits. */
export interface GameLevelEntry {
  /** Stable id, unique across levels. Becomes the `levels:<id>` evidence entry. */
  readonly id: string
  /** Human-readable level name. */
  readonly name: string
  /** Which `public/assets/bg/level<N>.png` background this level draws (the `game-assets.json` numbering contract). */
  readonly backgroundLevel: number
  /** Where the player starts. Validated to the playfield. */
  readonly playerSpawn: SpawnPoint
  /** Static coins the level starts with. May be empty (a level that only spawns coins dynamically is legal). */
  readonly initialCoins: readonly SpawnPoint[]
  /** Static obstacles the level starts with. May be empty. */
  readonly initialObstacles: readonly SpawnPoint[]
}

/** Gameplay parameters shared across a game's levels. */
export interface GameRules {
  readonly playerSpeed: number
  readonly bulletSpeed: number
  readonly coinValue: number
  readonly shootValue: number
}

export interface GameDataManifest {
  readonly levels: readonly GameLevelEntry[]
  readonly rules?: GameRules
  readonly vocabulary?: Readonly<Record<string, unknown>>
}

function validationError(path: string, message: string): never {
  throw new Error(`game-data.json: ${path} — ${message}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(container: Record<string, unknown>, field: string, path: string): number {
  const value = container[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    validationError(`${path}.${field}`, `必须是有限数字，实际是 ${JSON.stringify(value)}`)
  }
  return value
}

/** Validates a {x, y} point and enforces dimensions.ts's playfield contract for world geometry. */
function readPlayfieldPoint(value: unknown, path: string): SpawnPoint {
  if (!isPlainObject(value)) validationError(path, `必须是 { "x": number, "y": number } 对象，实际是 ${JSON.stringify(value)}`)
  const x = readNumber(value, 'x', path)
  const y = readNumber(value, 'y', path)
  if (x < 0 || x > GAME_WIDTH) validationError(`${path}.x`, `必须在 [0, ${GAME_WIDTH}]（画布宽度）内，实际是 ${x}`)
  if (y < 0 || y > PLAYFIELD_HEIGHT) {
    validationError(`${path}.y`, `必须在 [0, ${PLAYFIELD_HEIGHT}]（PLAYFIELD_HEIGHT，HUD 带以下属于 UiScene）内，实际是 ${y}`)
  }
  return { x, y }
}

function readPlacementList(value: unknown, path: string): readonly SpawnPoint[] {
  if (!Array.isArray(value)) validationError(path, `必须是数组，实际是 ${JSON.stringify(value)}`)
  return value.map((entry, index) => readPlayfieldPoint(entry, `${path}[${index}]`))
}

function readLevelEntry(value: unknown, index: number): GameLevelEntry {
  const path = `levels[${index}]`
  if (!isPlainObject(value)) validationError(path, `必须是对象，实际是 ${JSON.stringify(value)}`)
  const id = value['id']
  if (typeof id !== 'string' || id.length === 0) validationError(`${path}.id`, `必须是非空字符串，实际是 ${JSON.stringify(id)}`)
  const name = value['name']
  if (typeof name !== 'string' || name.length === 0) validationError(`${path}.name`, `必须是非空字符串，实际是 ${JSON.stringify(name)}`)
  const backgroundLevel = readNumber(value, 'backgroundLevel', path)
  if (!Number.isInteger(backgroundLevel) || backgroundLevel < 1) {
    validationError(`${path}.backgroundLevel`, `必须是 ≥1 的整数（game-assets.json 的 level<N> 编号契约），实际是 ${backgroundLevel}`)
  }
  const playerSpawn = readPlayfieldPoint(value['playerSpawn'], `${path}.playerSpawn`)
  return {
    id,
    name,
    backgroundLevel,
    playerSpawn,
    initialCoins: readPlacementList(value['initialCoins'], `${path}.initialCoins`),
    initialObstacles: readPlacementList(value['initialObstacles'], `${path}.initialObstacles`),
  }
}

function readRules(value: unknown): GameRules {
  if (!isPlainObject(value)) validationError('rules', `必须是对象，实际是 ${JSON.stringify(value)}`)
  return {
    playerSpeed: readNumber(value, 'playerSpeed', 'rules'),
    bulletSpeed: readNumber(value, 'bulletSpeed', 'rules'),
    coinValue: readNumber(value, 'coinValue', 'rules'),
    shootValue: readNumber(value, 'shootValue', 'rules'),
  }
}

/**
 * Parses and STRICTLY validates the raw text of `game-data.json`.
 *
 * Throws — never returns a partial/empty manifest — on every bad shape:
 * missing file (`raw === undefined`), invalid JSON, non-object root,
 * missing/empty `levels`, any level entry failing field validation, or a
 * geometry value outside the playfield. Every error message names its path
 * (`levels[2].playerSpawn.x …`) so the executor fixes the DATA, not the
 * code. This strictness is the spec's own words: 空壳清单是「为了过闸而
 * 造假数据」的第一形态，必须在校验层就死掉.
 */
export function parseAndValidateGameData(raw: string | undefined): GameDataManifest {
  if (raw === undefined) {
    throw new Error(
      'game-data.json: 文件未能加载（缺失或 404）——数据层是本项目的必选项，不是可选增强；' +
        '玩法内容（关卡/规则/词表）定义在 public/game-data.json，场景代码不承载内容定义',
    )
  }
  const parsed = safeParseJson(raw)
  if (parsed === undefined) validationError('(root)', '不是合法 JSON')
  if (!isPlainObject(parsed)) validationError('(root)', `必须是对象，实际是 ${JSON.stringify(parsed)}`)

  const levels = parsed['levels']
  if (!Array.isArray(levels)) validationError('levels', `必须是数组，实际是 ${JSON.stringify(levels)}`)
  if (levels.length === 0) validationError('levels', '空数组——空壳清单不是数据层；至少要有一个完整的关卡条目')

  const vocabulary = parsed['vocabulary']
  if (vocabulary !== undefined && !isPlainObject(vocabulary)) {
    validationError('vocabulary', `必须是对象，实际是 ${JSON.stringify(vocabulary)}`)
  }

  return {
    levels: levels.map(readLevelEntry),
    ...(parsed['rules'] !== undefined ? { rules: readRules(parsed['rules']) } : {}),
    ...(vocabulary !== undefined ? { vocabulary: vocabulary as Readonly<Record<string, unknown>> } : {}),
  }
}

// ───────────────────────────────────────────────────────────────────────
// Module state — the loader's initialized flag + consumption registry
// (game-data-spine design D2). Module-level because it must be observable
// by `src/debug/harness.ts` (read-only) WITHOUT a setter ever existing on
// `GameHarness`: scenes consume through the accessors below, the registry
// records that fact, and `buildDataUsageEvidence()` reports it. Nothing
// outside this module writes either field except `initGameData()` and the
// accessors themselves.
// ───────────────────────────────────────────────────────────────────────

const moduleState: {
  manifest: GameDataManifest | null
  /** entryId -> section, filled by the accessors as scenes take entries. Cumulative for the session. */
  consumed: Map<string, GameDataSection>
} = { manifest: null, consumed: new Map() }

/**
 * Initializes the data layer from the raw cached text. Called by
 * `PreloadScene.create()` — at page-load time, BEFORE any gameplay scene
 * can run — precisely so that a bad manifest throws where
 * `scripts/verify.mjs`'s BH-1 gate catches it cleanly as an uncaught
 * exception, instead of throwing later inside a gameplay scene's
 * `create()`, where the IA runner's `applyState()` would await a CREATE
 * event that never fires (runner design: no per-eval timeout — keep every
 * failure loud AND early).
 *
 * Idempotent: re-initializing with the same text (e.g. a full page
 * reload within one session) just replaces the manifest. The consumption
 * registry is intentionally NOT cleared here — `buildDataUsageEvidence()`
 * intersects it with the current declared set, so entries consumed from a
 * superseded manifest can never masquerade as use of the current one.
 */
export function initGameData(raw: string | undefined): GameDataManifest {
  const manifest = parseAndValidateGameData(raw)
  moduleState.manifest = manifest
  return manifest
}

export function isGameDataInitialized(): boolean {
  return moduleState.manifest !== null
}

function requireInitialized(): GameDataManifest {
  if (moduleState.manifest === null) {
    throw new Error(
      'game-data.ts 未初始化——PreloadScene 必须在 create() 里调用 ' +
        `initGameData(this.cache.text.get(GAME_DATA_RAW_CACHE_KEY))（数据层是必选项，不是可选增强）`,
    )
  }
  return moduleState.manifest
}

function consume(id: string, section: GameDataSection): void {
  moduleState.consumed.set(id, section)
}

/** The reference scene's "current level": the first `levels` entry. Records consumption as `levels:<id>`. */
export function getActiveLevel(): GameLevelEntry {
  const level = requireInitialized().levels[0]
  // Validation already rejects an empty `levels`, so this is a backstop for
  // a manifest mutated after init — fail loud rather than hand out undefined.
  if (!level) validationError('levels', '运行时为空——清单在校验后又被改坏（不应到达此处）')
  consume(`levels:${level.id}`, 'levels')
  return level
}

/** A specific level by id, or `null` — for games whose scenes map 1:1 to levels. Records consumption on hit. */
export function getLevelById(id: string): GameLevelEntry | null {
  const level = requireInitialized().levels.find((entry) => entry.id === id)
  if (level) consume(`levels:${level.id}`, 'levels')
  return level ?? null
}

/** Gameplay parameters. Records consumption as `rules`. Throws locatably if the manifest declared no `rules` section. */
export function getGameRules(): GameRules {
  const rules = requireInitialized().rules
  if (!rules) {
    validationError('rules', '清单里没有 rules 节，但场景要求了它——在 game-data.json 里补 rules 节，而不是在场景里写数值常量')
  }
  consume('rules', 'rules')
  return rules
}

/** The free-form vocabulary map, consuming every key it hands out (`vocabulary:<key>`). Throws if the manifest declared none. */
export function getVocabulary(): Readonly<Record<string, unknown>> {
  const vocabulary = requireInitialized().vocabulary
  if (!vocabulary) {
    validationError('vocabulary', '清单里没有 vocabulary 节，但场景要求了它——在 game-data.json 里补 vocabulary 节，而不是把词表写死在场景里')
  }
  for (const key of Object.keys(vocabulary)) consume(`vocabulary:${key}`, 'vocabulary')
  return vocabulary
}

/** Direct read for `tests/game-data.test.mjs` — the registry as evidence entries, in insertion order. */
export function getConsumedEntries(): readonly DataEntrySnapshot[] {
  return [...moduleState.consumed.entries()].map(([id, section]) => ({ id, section }))
}

/**
 * Lenient listing for the harness's `declared` layer: whatever entries the
 * raw text declares, WITHOUT strict validation. Needed because `declared`
 * must be derivable even when the loader never initialized (an executor
 * project that kept `game-data.json` but stripped the `initGameData()`
 * call — the exact "清单可以有，没人碰" shape design D2 names): strict
 * validation would throw on exactly the broken manifests this layer exists
 * to expose. Returns `null` when there is no text to list from (nothing
 * was ever loaded) — that is the `data: null` case, not an empty set.
 */
export function listDeclaredEntries(raw: string | undefined): readonly DataEntrySnapshot[] | null {
  if (raw === undefined) return null
  const parsed = safeParseJson(raw)
  if (!isPlainObject(parsed)) return null
  const entries: DataEntrySnapshot[] = []
  const levels = parsed['levels']
  if (Array.isArray(levels)) {
    for (const [index, entry] of levels.entries()) {
      const id = isPlainObject(entry) && typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : String(index)
      entries.push({ id: `levels:${id}`, section: 'levels' })
    }
  }
  if (parsed['rules'] !== undefined) entries.push({ id: 'rules', section: 'rules' })
  if (isPlainObject(parsed['vocabulary'])) {
    for (const key of Object.keys(parsed['vocabulary'])) entries.push({ id: `vocabulary:${key}`, section: 'vocabulary' })
  }
  return entries
}

function manifestEntries(manifest: GameDataManifest): readonly DataEntrySnapshot[] {
  const entries: DataEntrySnapshot[] = manifest.levels.map((level) => ({ id: `levels:${level.id}`, section: 'levels' }))
  if (manifest.rules) entries.push({ id: 'rules', section: 'rules' })
  if (manifest.vocabulary) {
    for (const key of Object.keys(manifest.vocabulary)) entries.push({ id: `vocabulary:${key}`, section: 'vocabulary' })
  }
  return entries
}

/**
 * Builds the three-layer evidence for `getSnapshot().data` (design D2).
 * Called only by `src/debug/harness.ts` — a pure read; nothing here can be
 * driven from `GameHarness`'s public surface (no-setter contract).
 *
 *   declared    lenient listing of the raw text (falls back to the stored
 *               manifest when no text was ever cached — can only happen if
 *               the loader initialized from some other source);
 *   loaded      the declared set, but ONLY when the loader actually
 *               initialized — parsing is whole-manifest, so "loaded" is
 *               per-project, not per-entry;
 *   usedInScene declared entries the consumption registry recorded —
 *               intersected with declared, so an id consumed from a
 *               superseded manifest never counts.
 *
 * `null` exactly when there is no declared set at all: no text, no stored
 * manifest — 「从未声明」与「声明了但没用起来」是两个事实，MUST NOT 塌缩
 * 成同一个空集合 (spec).
 */
export function buildDataUsageEvidence(rawText: string | undefined): DataUsageSnapshot | null {
  const declared = listDeclaredEntries(rawText) ?? (moduleState.manifest !== null ? manifestEntries(moduleState.manifest) : null)
  if (declared === null) return null
  const loaded = moduleState.manifest !== null ? declared : []
  const usedInScene = declared.filter((entry) => moduleState.consumed.get(entry.id) === entry.section)
  return { declared, loaded, usedInScene }
}

/** Tests-only: resets module state between cases. Never call from game or runner code. */
export function __resetGameDataForTests(): void {
  moduleState.manifest = null
  moduleState.consumed.clear()
}
