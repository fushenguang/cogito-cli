// entity-bounds.mjs — BH-2's "命名实体是否仍在世界边界内" judgement
// (trigger-integrity-and-onscreen-gate task 2.2, design D4).
//
// Pure, bare-Node function — no CDP, no Phaser — same shape as
// scripts/lib/png.mjs's judgeScreenshotNonEmpty(), so it can be unit tested
// without a browser. verify.mjs is the only caller: it hands this whatever
// `getSnapshot()` (src/debug/harness.ts) returned over CDP.
//
// design D4: the boundary source is decided by harness.ts's
// readWorldBounds() (prefer `physics.world.bounds`, fall back to canvas
// size) — this function does not care which one it got, it only judges
// against whatever `worldBounds` the caller hands it. `source` is carried
// straight through into the caller's detail string so `.verify-result.json`
// always shows which one was used — D4's explicit "不静默" requirement for
// the canvas fallback, which has a real false-positive risk on a
// horizontally-scrolling game.

/**
 * Slack applied on every side of the world-bounds rectangle before an
 * entity is judged out of bounds. `EntitySnapshot` carries no width/height
 * (harness-types.ts), so this can't be size-aware — it exists only to
 * absorb an entity whose origin sits legitimately near the edge (a sprite's
 * texture origin is commonly its center, so half its width/height can sit
 * past its own x/y without the entity actually being "gone"). It is
 * deliberately small: this gate exists to catch an object that has clearly
 * left the world (E-15's flag/spikes falling forever under an unbounded
 * gravity bug), not to nitpick a few pixels of edge overlap.
 */
export const ENTITY_BOUNDS_MARGIN_PX = 48

/**
 * @param {readonly { name: string, x: number, y: number }[]} entities
 * @param {{ x: number, y: number, width: number, height: number, source: string }} worldBounds
 * @param {number} [marginPx]
 * @returns {{ ok: true, outOfBounds: [] } | { ok: false, outOfBounds: readonly { name: string, x: number, y: number }[] }}
 */
export function judgeEntitiesWithinBounds(entities, worldBounds, marginPx = ENTITY_BOUNDS_MARGIN_PX) {
  const minX = worldBounds.x - marginPx
  const minY = worldBounds.y - marginPx
  const maxX = worldBounds.x + worldBounds.width + marginPx
  const maxY = worldBounds.y + worldBounds.height + marginPx

  const outOfBounds = entities.filter((e) => e.x < minX || e.x > maxX || e.y < minY || e.y > maxY)
  if (outOfBounds.length === 0) return { ok: true, outOfBounds: [] }
  return { ok: false, outOfBounds }
}

// ───────────────────────────────────────────────────────────────────────
// Two-point sampling window (design D8, 2026-08-19 — supersedes D7)
// ───────────────────────────────────────────────────────────────────────
//
// 🔴 History, kept because the failure mode is instructive and this is the
// THIRD time this change has hit the same disease (design.md D8 has the
// full writeup — read it before touching this file again):
//
//   - E-15 itself: the assertion's own trigger handler moved the thing it
//     was supposed to be checking (the player), so it always passed.
//   - D7 (first fix attempt, REJECTED): took a single post-load sample —
//     provably missed a real-gravity falling object, because this
//     template's Boot -> Preload -> Game transitions eat almost all of the
//     ~1000ms post-load settle.
//   - D7's own fix (ALSO REJECTED): sample again right after IA finishes,
//     reusing IA's elapsed wall-clock time for free. Empirically falsified:
//     this template's own `assertions.json` ends with `game_over_trigger`,
//     whose last action tears the Game scene down, so the "free" second
//     sample lands in a scene that no longer has the entity in it at all —
//     `judgeEntitiesWithinBounds([], …)` passes vacuously, not because
//     nothing is out of bounds, but because nothing is observable anymore.
//
// All three are the same shape: **the judgement finishes observing before,
// or after, the defect is visible — never while.**
//
// The actual fix (D8): the second sample establishes its OWN observation
// window instead of reusing anything left over by IA. It calls
// `applyState()` onto the gameplay-role state — the SAME discipline every
// IA judge function already follows per design D6 ("每条断言前强制
// applyState") — waits `BOUNDS_OBSERVATION_MS`, then samples. This costs a
// few real seconds of `pnpm verify` wall-clock time (deliberately: the
// alternative is a judgement that can't be trusted), and both samples now
// run BEFORE IA so BH-2 is fully decided before IA ever starts.
//
// Rejected alternatives (recorded so nobody re-proposes them; design.md D8
// has the same list):
//   - "only take the second sample if IA happened to still be in gameplay
//     afterward" — an escape-hatch shape, forbidden outright by this
//     template's own rules.
//   - "sample repeatedly throughout IA" — turns two samples into N, and the
//     result would depend on `assertions.json`'s item order — not
//     reproducible.
//   - "require the last assertions.json item to never leave gameplay" —
//     `pnpm verify` has no authority over a project's own assertions file.

/**
 * How long the second sample waits, after `applyState()` onto the
 * gameplay-role state, before taking `getSnapshot()`.
 *
 * Derivation (not a guess — written down so it isn't re-guessed later):
 * world height 540, margin `ENTITY_BOUNDS_MARGIN_PX` (48), an object
 * starting at `y = 100` under gravity `g` clears the boundary after
 * `t = sqrt(2 * (540 + 48 - 100) / g)` seconds. At the real-repro gravity
 * used to validate this change (`g = 2000`), `t = sqrt(2*488/2000) ≈ 0.70s`.
 * `2000ms` gives headroom down to roughly `g ≳ 250`.
 *
 * 🔴 Honest limit, written down rather than swept under the rug: this is a
 * SAMPLING judgement, not an invariant. A drift slower than roughly
 * `g ≈ 250` — or any drift that simply takes longer than ~2s to clear the
 * boundary — will NOT be caught by this window. Widening the window trades
 * `pnpm verify` runtime for sensitivity to slower drifts; that is a real,
 * open trade-off, not a bug, and not something this constant tries to hide.
 */
export const BOUNDS_OBSERVATION_MS = 2000
