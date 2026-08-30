/**
 * Design-space geometry for the in-game documentation entry button (see
 * `./doc-panel.ts` and `./scenes/UiScene.ts`).
 *
 * 🔴 Deliberately its own leaf-ish module instead of new constants bolted
 * onto `./dimensions.ts` directly. This change is explicitly forbidden
 * from touching that file's existing constants or its zero-import rule
 * (see AGENTS.md's brief for this change) — putting new, unrelated
 * geometry there risks brushing up against both by accident. This module
 * imports `dimensions.ts`'s constants (read-only) and derives new numbers
 * from them; it adds nothing to `dimensions.ts` itself.
 *
 * Kept importable by bare Node (imports only the zero-import
 * `dimensions.ts`, with the `.ts` extension — same convention
 * `debug/state-jump.ts` uses) so `tests/doc-panel-geometry.test.mjs` can
 * assert the button's placement without a browser/DOM, the same way
 * `tests/dimensions.test.mjs` asserts the HUD band / playfield contract
 * itself.
 */
import { GAME_WIDTH, GAME_HEIGHT, PLAYFIELD_HEIGHT } from './dimensions.ts'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Diameter, in design pixels, of the circular doc-entry button. */
export const DOC_BUTTON_DIAMETER = 36

/** Gap, in design pixels, between the button and the right edge of the canvas. */
export const DOC_BUTTON_MARGIN_X = 12

/** Gap, in design pixels, between the button and the top edge of the reserved HUD band. */
export const DOC_BUTTON_MARGIN_Y = 10

/**
 * Design-space rect (in the 960x540 space every scene draws in — see
 * `dimensions.ts`) of the doc-entry button.
 *
 * Placed at the right edge, flush against the *top* of the reserved HUD
 * band (`y = PLAYFIELD_HEIGHT + margin`) — the closest this template's
 * single bottom HUD band can get to "top-right of the game" while staying
 * strictly inside the band the HUD band / playfield contract reserves.
 * `isRectWithinHudBand()` below is what makes that a checked fact, not an
 * assumption — see `tests/doc-panel-geometry.test.mjs`.
 */
export function getDocButtonRect(): Rect {
  const width = DOC_BUTTON_DIAMETER
  const height = DOC_BUTTON_DIAMETER
  const x = GAME_WIDTH - DOC_BUTTON_MARGIN_X - width
  const y = PLAYFIELD_HEIGHT + DOC_BUTTON_MARGIN_Y
  return { x, y, width, height }
}

/**
 * True if `rect` stays entirely inside the reserved HUD band
 * (`y ∈ [PLAYFIELD_HEIGHT, GAME_HEIGHT]`) — i.e. it does not extend up
 * into the playfield world-geometry area at all.
 */
export function isRectWithinHudBand(rect: Rect): boolean {
  return rect.y >= PLAYFIELD_HEIGHT && rect.y + rect.height <= GAME_HEIGHT
}

/**
 * True if `rect` overlaps the playfield (`y ∈ [0, PLAYFIELD_HEIGHT)`) at
 * all — the property that must NEVER hold for the closed-state button.
 * Exists so the mutation test in `tests/doc-panel-geometry.test.mjs` has a
 * named predicate to assert against, rather than re-deriving the interval
 * math inline.
 */
export function overlapsPlayfield(rect: Rect): boolean {
  return rect.y < PLAYFIELD_HEIGHT
}
