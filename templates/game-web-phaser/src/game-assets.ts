/**
 * `game-assets.json` contract — the platform's hand-off point for AI-generated
 * art/audio (see `./scenes/PreloadScene.ts` for the loader half, `./scenes/StartScene.ts`
 * / `./scenes/GameScene.ts` / `./scenes/UiScene.ts` for the consumers).
 *
 * Why this exists: the builder's brief for this change was explicit —
 * "背景音乐、背景、人物直接用 AI 生成，而不是用形状代替" (background music,
 * backgrounds, and characters are AI-generated files, not procedural
 * shapes). The platform writes those generated files into the project's
 * working directory at delivery time under a fixed directory contract:
 *
 *   public/assets/title.png          start-page hero image
 *   public/assets/bg/level<N>.png    per-level background (N starts at 1)
 *   public/assets/char/<slug>.png    a character, already alpha-matted
 *   public/assets/bgm/main.mp3       background music
 *   public/game-assets.json          the manifest this module parses
 *
 * That directory layout is the platform interface and MUST NOT change.
 * The shape of `game-assets.json` itself belongs to this template, as long
 * as it can express, per asset: its relative path, a human-readable
 * description of what it is (the generating/executing agent decides what
 * to *do* with an asset by reading this, not by pattern-matching the file
 * name), and which level it belongs to, when that's meaningful.
 *
 * Kept as a leaf-ish module (imports nothing) for the same reason as
 * `./dimensions.ts` and `./game-doc.ts`: both the loading code (browser,
 * pulls in Phaser) and `tests/game-assets.test.mjs` (bare Node) need to
 * import it without dragging in a DOM or WebGL.
 *
 * 🔴 Unlike `./game-doc.ts`'s all-or-nothing validation, this contract
 * degrades **per field**: a manifest with a malformed `title` entry but a
 * valid `bgm` entry keeps the valid half rather than discarding everything
 * (see `normalizeGameAssets()`'s doc below for why that's the right
 * default here, unlike the doc panel). A manifest that, after that
 * per-field filtering, has nothing usable left at all is treated exactly
 * like a missing manifest (`null`) — see the empty-manifest case in
 * `normalizeGameAssets()`.
 */

/** One entry in the manifest — a single generated file. */
export interface GameAssetEntry {
  /** Path relative to `public/`, e.g. `"assets/title.png"` — what `PreloadScene` hands to Phaser's loader. */
  readonly path: string
  /**
   * One human-readable sentence describing what this file is / what it's
   * for. Load-bearing for the platform's generating agent, which decides
   * where an asset gets used by reading this — never by guessing from the
   * file name or slug.
   */
  readonly description: string
}

/**
 * A character entry additionally carries an optional level number — a
 * character that only appears in one specific level can say so; a
 * character shared across every level (or a single-level project, like
 * this template's reference implementation) simply omits it.
 */
export interface GameCharacterEntry extends GameAssetEntry {
  /** 1-based level/scene number this character belongs to, if it's level-specific. */
  readonly level?: number
}

/** Normalized, validated shape of `game-assets.json` — what `PreloadScene` actually queues. */
export interface GameAssets {
  /** Start-page hero image (`public/assets/title.png`). Absent = no title art shipped yet. */
  readonly title?: GameAssetEntry
  /**
   * Per-level backgrounds, keyed `"level<N>"` (`N` a positive integer,
   * matching the `public/assets/bg/level<N>.png` directory contract
   * exactly — see `parseBackgroundLevelKey()`). A key that doesn't match
   * that shape is dropped during normalization, not merely ignored at
   * load time — see `normalizeGameAssets()`.
   */
  readonly backgrounds: Readonly<Record<string, GameAssetEntry>>
  /** Characters, keyed by an arbitrary slug (`public/assets/char/<slug>.png`). See `PLAYER_CHARACTER_KEY`'s doc for the one reserved slug. */
  readonly characters: Readonly<Record<string, GameCharacterEntry>>
  /** Background music (`public/assets/bgm/main.mp3`). Absent = no BGM shipped yet — see `./scenes/StartScene.ts`. */
  readonly bgm?: GameAssetEntry
}

// ───────────────────────────────────────────────────────────────────────
// Well-known texture/audio keys — the single source of truth both
// PreloadScene (which registers them) and every other scene (which only
// ever calls `this.textures.exists(key)` / `this.cache.audio.exists(key)`,
// never re-parses the manifest itself) agree on. Keeping this here, not
// hand-copied into each scene, is the same "same fact stored twice, drifts
// later" reasoning `dimensions.ts` documents at length.
// ───────────────────────────────────────────────────────────────────────

/**
 * Phaser text-cache key `PreloadScene` stores the manifest's raw (unparsed)
 * text under (`this.load.text('gameAssetsRaw', 'game-assets.json')` /
 * `this.cache.text.get(GAME_ASSETS_RAW_CACHE_KEY)`).
 *
 * Shared with `../debug/harness.ts` (asset-usage-gate design), which
 * re-derives the same `GameAssets`/`AssetLoadTask[]` from this cached text
 * at snapshot time — via the exact same `safeParseJson()` +
 * `normalizeGameAssets()` + `planAssetLoads()` pipeline `PreloadScene`
 * already ran — instead of hand-copying this key string a second time. Same
 * "same fact stored twice, drifts later" discipline as every other
 * well-known key in this file.
 */
export const GAME_ASSETS_RAW_CACHE_KEY = 'gameAssetsRaw'

/** Texture key `PreloadScene` registers `assets.title`'s image under. */
export const TITLE_TEXTURE_KEY = 'title'

/** Audio key `PreloadScene` registers `assets.bgm`'s file under. */
export const BGM_AUDIO_KEY = 'bgm'

/**
 * Convention, not a technical requirement: if a project wants a
 * particular generated character to be the actual player-controlled
 * sprite, name that character's manifest key exactly `"player"`.
 * `PreloadScene` registers every character under a texture key equal to
 * its own manifest key, so a character keyed `"player"` becomes available
 * as `this.textures.exists('player')` — the same texture key
 * `GameScene.ts`'s reference player sprite already requests unconditionally
 * (see its `PreloadScene.generatePlaceholderTextures()` guard: a
 * procedural placeholder is only generated for this key when nothing was
 * already loaded under it). This is a coincidence of convention with the
 * *entity* name `harness.ts`'s `PLAYER_ENTITY_NAME` requires — Phaser's
 * texture-key namespace and its GameObject `.name` namespace are unrelated
 * — not a technical link between the two.
 */
export const PLAYER_CHARACTER_KEY = 'player'

const BACKGROUND_TEXTURE_PREFIX = 'bg-level'

/** Texture key `PreloadScene` registers a `"level<N>"` background image under. */
export function backgroundTextureKey(level: number): string {
  return `${BACKGROUND_TEXTURE_PREFIX}${level}`
}

/** `"level<N>"` -> `N`, `N >= 1`. Anything else (wrong prefix, non-digit, leading zero, 0) is not a valid key. */
const LEVEL_KEY_PATTERN = /^level([1-9]\d*)$/

/**
 * Parses a `backgrounds` record key into its level number, or `null` if the
 * key doesn't match the `"level<N>"` shape the directory contract requires.
 * Exported so `PreloadScene` can derive the same texture key
 * (`backgroundTextureKey()`) for each background it queues without
 * re-deriving this regex itself.
 */
export function parseBackgroundLevelKey(key: string): number | null {
  const match = LEVEL_KEY_PATTERN.exec(key)
  if (!match) return null
  const level = Number(match[1])
  return Number.isInteger(level) && level >= 1 ? level : null
}

// ───────────────────────────────────────────────────────────────────────
// Validation / normalization
// ───────────────────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGameAssetEntry(value: unknown): value is GameAssetEntry {
  if (!isPlainObject(value)) return false
  return isNonEmptyString(value['path']) && isNonEmptyString(value['description'])
}

function isValidCharacterLevel(value: unknown): value is number | undefined {
  if (value === undefined) return true
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function normalizeAssetEntry(value: unknown): GameAssetEntry | undefined {
  if (!isGameAssetEntry(value)) return undefined
  return { path: value.path, description: value.description }
}

/**
 * Drops any key that isn't a valid `"level<N>"` shape, and any entry that
 * isn't a valid `GameAssetEntry` — independently per key, so one bad
 * background never takes a good one down with it.
 */
function normalizeBackgrounds(value: unknown): Readonly<Record<string, GameAssetEntry>> {
  if (!isPlainObject(value)) return {}
  const result: Record<string, GameAssetEntry> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (parseBackgroundLevelKey(key) === null) continue
    const normalized = normalizeAssetEntry(entry)
    if (!normalized) continue
    result[key] = normalized
  }
  return result
}

/** Same per-key independence as `normalizeBackgrounds()`, plus the optional `level` field's own validation. */
function normalizeCharacters(value: unknown): Readonly<Record<string, GameCharacterEntry>> {
  if (!isPlainObject(value)) return {}
  const result: Record<string, GameCharacterEntry> = {}
  for (const [slug, raw] of Object.entries(value)) {
    if (!isPlainObject(raw) || !isGameAssetEntry(raw)) continue
    const level = raw['level']
    if (!isValidCharacterLevel(level)) continue
    result[slug] =
      level === undefined ? { path: raw.path, description: raw.description } : { path: raw.path, description: raw.description, level }
  }
  return result
}

/**
 * Parses raw JSON text into a value `normalizeGameAssets()` can validate,
 * or `undefined` if `text` is `undefined` (the file was never loaded) or
 * isn't valid JSON at all.
 *
 * 🔴 Deliberately NOT `this.load.json(...)` on the Phaser side — see
 * `PreloadScene.ts`'s use of `this.load.text()` + this function instead.
 * Phaser's own `JSONFile.onProcess()` calls `JSON.parse()` with no
 * try/catch around it: a 404 degrades cleanly (a per-file loaderror, never
 * a thrown exception — the same behaviour `game-doc.json` already relies
 * on), but a 200 response whose body is NOT valid JSON throws a
 * `SyntaxError` **inside Phaser's own loader internals**, which surfaces
 * as an uncaught exception on the page and fails `scripts/verify.mjs`'s
 * BH-1 gate (confirmed by hand: a `game-assets.json` with a malformed body
 * reproduces this exactly). AGENTS.md's brief for this change is explicit
 * that a failed load must never throw — loading the manifest as plain text
 * and parsing it here, inside a `try/catch` this module fully controls,
 * is what keeps that promise regardless of what garbage ends up in the
 * response body.
 */
export function safeParseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Validates and normalizes a raw parsed JSON value into a `GameAssets`, or
 * `null` if there is nothing usable in it at all.
 *
 * `null` covers the same three cases `game-doc.ts`'s `normalizeGameDoc()`
 * collapses together — missing file (Phaser's loader leaves the cache key
 * absent), failed parse (same), and "parsed but nothing valid inside" —
 * plus one more this contract adds on top: a manifest where every
 * individual field failed its own per-field validation also normalizes to
 * `null`, because a `GameAssets` with no title/backgrounds/characters/bgm
 * is indistinguishable, to every caller, from no manifest at all. This is
 * the literal, testable form of AGENTS.md's brief: "清单缺失或某个文件加载
 * 失败时优雅退化到现有的形状占位" (missing manifest or a failed file load
 * degrades to the existing shape placeholders) — see `planAssetLoads()`
 * below for the other half (queuing nothing at all when this returns
 * `null`, never a guessed request).
 */
export function normalizeGameAssets(raw: unknown): GameAssets | null {
  if (!isPlainObject(raw)) return null

  const title = normalizeAssetEntry(raw['title'])
  const bgm = normalizeAssetEntry(raw['bgm'])
  const backgrounds = normalizeBackgrounds(raw['backgrounds'])
  const characters = normalizeCharacters(raw['characters'])

  if (!title && !bgm && Object.keys(backgrounds).length === 0 && Object.keys(characters).length === 0) {
    return null
  }

  return { title, backgrounds, characters, bgm }
}

// ───────────────────────────────────────────────────────────────────────
// Load planning
// ───────────────────────────────────────────────────────────────────────

export type AssetLoadKind = 'image' | 'audio'

/** One file `PreloadScene` should hand to Phaser's loader — see `planAssetLoads()`. */
export interface AssetLoadTask {
  readonly key: string
  readonly path: string
  readonly kind: AssetLoadKind
}

/**
 * Pure decision of exactly which files `PreloadScene` should queue with
 * Phaser's loader, given the already-normalized-or-null manifest.
 *
 * 🔴 Deliberately a pure function, not inlined into `PreloadScene.preload()`
 * — the "manifest missing/invalid ⇒ queue NOTHING, never a guessed
 * request" contract (AGENTS.md's brief for this change: "退化必须真的不发
 * 请求") has to be checkable without a browser/DOM/CDP session.
 * `assets === null` returning `[]` below is the literal, testable proof of
 * that — see `tests/game-assets.test.mjs`'s missing-manifest case and its
 * mutation check (hardcoding a task regardless of `assets` must turn that
 * test red).
 */
export function planAssetLoads(assets: GameAssets | null): readonly AssetLoadTask[] {
  if (!assets) return []

  const tasks: AssetLoadTask[] = []

  if (assets.title) {
    tasks.push({ key: TITLE_TEXTURE_KEY, path: assets.title.path, kind: 'image' })
  }

  for (const [key, entry] of Object.entries(assets.backgrounds)) {
    const level = parseBackgroundLevelKey(key)
    if (level === null) continue // normalizeGameAssets() already guarantees this; defensive only
    tasks.push({ key: backgroundTextureKey(level), path: entry.path, kind: 'image' })
  }

  for (const [slug, entry] of Object.entries(assets.characters)) {
    tasks.push({ key: slug, path: entry.path, kind: 'image' })
  }

  if (assets.bgm) {
    tasks.push({ key: BGM_AUDIO_KEY, path: assets.bgm.path, kind: 'audio' })
  }

  return tasks
}

// ───────────────────────────────────────────────────────────────────────
// Level background — a helper shared by every scene that draws a level's
// AI-generated background, not private to any one scene class.
//
// 🔴 Why this exists: this template ships exactly one gameplay scene
// (`./scenes/GameScene.ts`), but a real project frequently deletes it and
// writes its own `Level1Scene`/`Level2Scene`/... classes instead — that
// rewrite is expected and fine, GameScene's own gameplay is templated demo
// content. What is NOT demo content is the three-line "check the manifest
// evidence, draw the image, pin it behind gameplay" dance GameScene used to
// hand-roll in a private method — a real project deleted GameScene wholesale
// and every one of its Level<N>Scene replacements ended up with a plain
// solid-colour background and no AI art at all, because that logic had
// nowhere else to live. See game-flow-and-hud's SKILL.md, "Platform-
// Delivered Assets" section, for the full writeup — this function, plus
// `PLAYER_CHARACTER_KEY`/`BGM_AUDIO_KEY` above, is what a new level scene
// calls instead of re-deriving any of this from scratch.
// ───────────────────────────────────────────────────────────────────────

/**
 * Structural (duck-typed) subset of `Phaser.Scene` this helper needs.
 * Declared here instead of `import type { Scene } from 'phaser'` so this
 * module keeps the zero-import, bare-Node-testable discipline documented at
 * the top of this file — `tests/game-assets.test.mjs` exercises this
 * function with a plain object literal, no Phaser/DOM/WebGL involved. A
 * real `Phaser.Scene` satisfies this shape without any adaptation: both
 * `scene.textures.exists(key)` and the `add.image(...).setDisplaySize(...).setDepth(...)`
 * fluent chain are Phaser's own real, documented APIs — this interface is
 * just that chain typed narrowly to only what's used.
 */
export interface BackgroundHostScene {
  readonly textures: { exists(key: string): boolean }
  readonly add: {
    image(
      x: number,
      y: number,
      key: string,
    ): {
      setDisplaySize(width: number, height: number): { setDepth(depth: number): unknown }
    }
  }
}

/**
 * Draws `level`'s AI-generated background (`public/assets/bg/level<N>.png`,
 * see the directory contract above) into `scene`, sized to `width`×`height`
 * and pinned to `setDepth(-1)` so it always renders behind gameplay objects
 * regardless of future add-order changes in the caller.
 *
 * 🔴 No manifest / no matching texture ⇒ a no-op, returning `false` — the
 * caller's own existing plain background-color fill and placeholder shapes
 * ARE this game's "shape placeholder" for a level background, so there is
 * nothing else for this helper to draw as a fallback. This never re-parses
 * `game-assets.json` and never loads anything itself (loading already
 * happened in `PreloadScene`, or the file 404'd and never registered) — it
 * only ever asks the texture manager, same discipline as every other
 * consumer in this template.
 *
 * A new playable scene (a `Level<N>Scene` replacing `GameScene`, or an
 * additional level alongside it) should call this once, near the top of its
 * `create()`, instead of hand-rolling the `textures.exists()` check +
 * `add.image()` chain again — see `GameScene.ts`'s own `drawLevelBackground()`
 * for the reference call site. Extracting it here, not as a private method
 * on GameScene, is what keeps the check from being lost if GameScene itself
 * is deleted.
 *
 * The return value is for tests (`tests/game-assets.test.mjs`'s mutation
 * check) — production callers don't need to branch on it, the correct
 * fallback is already on screen either way.
 */
export function applyLevelBackground(scene: BackgroundHostScene, level: number, width: number, height: number): boolean {
  const key = backgroundTextureKey(level)
  if (!scene.textures.exists(key)) return false
  scene.add.image(width / 2, height / 2, key).setDisplaySize(width, height).setDepth(-1)
  return true
}
