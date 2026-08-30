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

  return {
    title: candidate.title,
    background: candidate.background,
    controls: candidate.controls,
    overallGoal: candidate.overallGoal,
    levels: candidate.levels,
    notDoing: candidate.notDoing,
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
