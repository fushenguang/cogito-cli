/**
 * `game-doc.json` contract — the in-game documentation panel's content
 * shape (see `./doc-panel.ts` for the panel itself, `./scenes/UiScene.ts`
 * for the entry button that opens it).
 *
 * Why this exists: the platform's machine gate can judge whether a
 * generated project *runs* (BH-0/1/2) and whether a handful of gameplay
 * behaviours are wired up (IA templates in `assertions.json`), but it
 * cannot judge "is this a good, on-brief GAME" — that's a human call. A
 * human can only make that call if they know what the game was supposed to
 * be: its premise, how to play it, what the current build is trying to
 * demonstrate, and what it deliberately does not attempt yet. This module
 * is the data contract for that — a small, generated-per-project JSON file
 * a human reads before/while playing, not a debug tool.
 *
 * Kept as a leaf-ish module (imports nothing) so both the panel-building
 * code (browser) and a bare-Node test (`tests/game-doc.test.mjs`) can
 * import it without pulling in Phaser or a DOM — same reasoning as
 * `./dimensions.ts` and `./debug/state-jump.ts`.
 *
 * 🔴 `normalizeGameDoc()` returning `null` is the ONE mechanism that
 * decides whether the doc entry button shows up at all — see
 * `UiScene.ts`'s `mountDocEntry()`. There is deliberately no separate
 * "doc panel enabled" flag: an absent, unreadable, or incomplete
 * `game-doc.json` and a present-but-invalid one are treated identically
 * (button does not render) rather than showing a half-empty panel to a
 * child. Writing a `game-doc.json` for a project is the only way to turn
 * the feature on.
 */

/** One entry in `levels` — what a single scene/level's doc content looks like. */
export interface GameDocLevel {
  /** Short, human-facing name for this level, e.g. "第一关". */
  readonly name: string
  /** What this level specifically asks the player to do/notice. */
  readonly goal: string
}

/**
 * Fixed-screen copy (issue #11, 2026-09-01) — every string the template's
 * built-in Start/GameOver/Settings pages render. ALL OPTIONAL at the
 * `game-doc.json` level: a doc without a `screens` section still gets fully
 * rendered pages using `DEFAULT_SCREENS` below (see `resolveScreens()`).
 * The scaffold's own `game-doc.json` declares all of them — a real project
 * customizes them there, never in scene code.
 */
export interface GameDocScreens {
  /** Start page title — defaults to the project's display name. */
  readonly startTitle?: string
  /** Start page subtitle, one line under the title (defaults to overallGoal's role). */
  readonly startSubtitle?: string
  /** The start button's label. */
  readonly startButton?: string
  /** The settings button's label on the Start page. */
  readonly settingsButton?: string
  /** Settings panel heading. */
  readonly settingsTitle?: string
  /** Mute toggle label while sound is on. */
  readonly muteLabel?: string
  /** Mute toggle label while muted. */
  readonly unmuteLabel?: string
  /** Settings panel close button. */
  readonly settingsClose?: string
  /** GameOver page heading, win variant. */
  readonly winTitle?: string
  /** GameOver page sub-line, win variant. */
  readonly winSubtitle?: string
  /** GameOver page heading, lose variant. */
  readonly loseTitle?: string
  /** GameOver page sub-line, lose variant. */
  readonly loseSubtitle?: string
  /** Prefix of the final-score line on the GameOver page. */
  readonly scoreLabel?: string
  /** GameOver "retry this level" button. */
  readonly retryButton?: string
  /** GameOver "back to the title page" button. */
  readonly backToTitleButton?: string
}

/**
 * Fixed-screen palette (issue #11). Hex `#rrggbb` strings. All optional —
 * `resolveTheme()` fills any gap from `DEFAULT_THEME`, so a doc can override
 * one color without restating the rest.
 *
 * The default set is deliberately high-contrast against the template's flat
 * background (`src/config.ts`, issue #10) so critical copy stays
 * pixel-assertable in a headless screenshot — see `scripts/selfcheck.mjs`.
 */
export interface GameDocTheme {
  /** Page backdrop colour, drawn OVER the canvas (with slight transparency applied in CSS). */
  readonly backdrop?: string
  /** Title / heading text. */
  readonly heading?: string
  /** Body / secondary text. */
  readonly text?: string
  /** Primary button fill. */
  readonly accent?: string
  /** Text on the primary button fill. */
  readonly accentText?: string
}

/** Normalized, validated shape of `game-doc.json` — what the panel actually renders. */
export interface GameDoc {
  /** Game's display name, shown at the top of the panel. */
  readonly title: string
  /** World/story background — "why does this game exist, what's it about". */
  readonly background: string
  /** Controls/操作手册, one short line per control (e.g. "方向键：移动"). */
  readonly controls: readonly string[]
  /** One or two sentences: what the player is trying to do overall. */
  readonly overallGoal: string
  /**
   * Per-scene-key doc content. Keyed by the Phaser scene key that scene
   * registers itself under (this template's reference scene is `"Game"`
   * — see `GameScene.ts`'s `super('Game')`). A generated project with more
   * than one playable scene/level adds one entry per scene key here; the
   * panel looks up the *currently running* scene's key and falls back to a
   * generic note if that key has no entry (see `doc-panel.ts`).
   */
  readonly levels: Readonly<Record<string, GameDocLevel>>
  /**
   * Explicitly-not-doing list — what this build deliberately does not
   * attempt yet, so a human reviewer doesn't mistake "not built" for
   * "broken". Required to be non-empty: a doc with nothing here is almost
   * certainly a copy-paste placeholder, not a real answer.
   */
  readonly notDoing: readonly string[]
  /** Fixed-screen copy overrides (issue #11) — optional; `resolveScreens()` fills gaps. */
  readonly screens?: GameDocScreens
  /** Fixed-screen palette overrides — optional; `resolveTheme()` fills gaps. */
  readonly theme?: GameDocTheme
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0
}

function isGameDocLevel(value: unknown): value is GameDocLevel {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return isNonEmptyString(candidate.name) && isNonEmptyString(candidate.goal)
}

function isLevelsRecord(value: unknown): value is Record<string, GameDocLevel> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isGameDocLevel)
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value)
}

function readScreens(value: unknown): GameDocScreens | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) return {}
  const fields: readonly (keyof GameDocScreens)[] = [
    'startTitle', 'startSubtitle', 'startButton', 'settingsButton', 'settingsTitle',
    'muteLabel', 'unmuteLabel', 'settingsClose', 'winTitle', 'winSubtitle',
    'loseTitle', 'loseSubtitle', 'scoreLabel', 'retryButton', 'backToTitleButton',
  ]
  const out: Record<string, string> = {}
  for (const field of fields) {
    const v = value[field]
    if (!isOptionalString(v)) return {}
    if (v !== undefined) out[field] = v
  }
  return out
}

function readTheme(value: unknown): GameDocTheme | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) return {}
  const fields: readonly (keyof GameDocTheme)[] = ['backdrop', 'heading', 'text', 'accent', 'accentText']
  const out: Record<string, string> = {}
  for (const field of fields) {
    const v = value[field]
    if (v === undefined) continue
    if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) return {}
    out[field] = v
  }
  return out
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates and normalizes a raw parsed JSON value into a `GameDoc`, or
 * returns `null` if it doesn't satisfy the contract above.
 *
 * `null` covers three cases the caller (`UiScene.ts`) deliberately does
 * NOT distinguish between: the file is missing (Phaser's loader leaves the
 * cache key absent, so `raw` is `undefined`), the file failed to parse
 * (same — Phaser's JSONFile drops it from the cache on a parse error), and
 * the file parsed but is missing required fields. All three mean "no doc
 * to show" (see this module's header doc) — never a half-rendered panel.
 */
export function normalizeGameDoc(raw: unknown): GameDoc | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>

  if (!isNonEmptyString(candidate.title)) return null
  if (!isNonEmptyString(candidate.background)) return null
  if (!isNonEmptyStringArray(candidate.controls)) return null
  if (!isNonEmptyString(candidate.overallGoal)) return null
  if (!isLevelsRecord(candidate.levels)) return null
  if (!isNonEmptyStringArray(candidate.notDoing)) return null

  const screens = readScreens(candidate['screens'])
  const theme = readTheme(candidate['theme'])
  return {
    title: candidate.title,
    background: candidate.background,
    controls: candidate.controls,
    overallGoal: candidate.overallGoal,
    levels: candidate.levels,
    notDoing: candidate.notDoing,
    ...(screens !== undefined ? { screens } : {}),
    ...(theme !== undefined ? { theme } : {}),
  }
}

/**
 * Looks up the doc content for the currently running level/scene, with a
 * generic fallback when `levelKey` has no entry in `doc.levels` — a
 * project that hasn't written per-level content yet still gets a coherent
 * panel instead of a missing section.
 */
export function resolveLevelDoc(doc: GameDoc, levelKey: string): GameDocLevel {
  return (
    doc.levels[levelKey] ?? {
      name: levelKey,
      goal: '这一关还没有单独的说明，请先参考上面的整体玩法介绍。',
    }
  )
}


// ───────────────────────────────────────────────────────────────────────
// Fixed-screen defaults + resolvers (issue #11, 2026-09-01)
//
// The Start/GameOver/Settings pages are TEMPLATE-owned infrastructure: they
// must render complete and legible even when `game-doc.json` is missing or
// invalid (`normalizeGameDoc() → null`), because "the auxiliary pages didn't
// exist yet" is exactly the shape the 小小财迷 M1 post-mortem ruled out —
// scaffolded projects are fully playable BEFORE any AI task runs. These
// defaults are infrastructure fallback copy, not project content: a real
// project overrides every string in `game-doc.json`'s `screens` section.
// ───────────────────────────────────────────────────────────────────────

export const DEFAULT_SCREENS: Readonly<Required<GameDocScreens>> = {
  startTitle: '', // resolved from the project display name when empty — see resolveScreens()
  startSubtitle: '点击「开始游戏」出发——终点门在右边',
  startButton: '开始游戏',
  settingsButton: '设置',
  settingsTitle: '设置',
  muteLabel: '声音：开（点击静音）',
  unmuteLabel: '声音：关（点击恢复）',
  settingsClose: '关闭',
  winTitle: '过关！',
  winSubtitle: '你抵达了终点门',
  loseTitle: '游戏结束',
  loseSubtitle: '碰到了危险物',
  scoreLabel: '得分',
  retryButton: '再玩一次',
  backToTitleButton: '回标题页',
}

export const DEFAULT_THEME: Readonly<Required<GameDocTheme>> = {
  backdrop: '#141824',
  heading: '#f4f6fb',
  text: '#b7c0d4',
  accent: '#4f8cff',
  accentText: '#0b1220',
}

/**
 * Merges a doc's `screens` overrides onto the defaults. `startTitle` is
 * special: it falls back to the project's display `title` (the same field
 * the doc panel shows), so the Start page can never show an empty heading.
 */
export function resolveScreens(doc: GameDoc | null): Required<GameDocScreens> {
  const overrides = doc?.screens ?? {}
  return {
    ...DEFAULT_SCREENS,
    ...overrides,
    startTitle: overrides.startTitle?.trim() || doc?.title || DEFAULT_SCREENS.startTitle || '开始',
  }
}

/** Merges a doc's `theme` overrides onto the defaults (per-colour granularity). */
export function resolveTheme(doc: GameDoc | null): Required<GameDocTheme> {
  return { ...DEFAULT_THEME, ...(doc?.theme ?? {}) }
}
