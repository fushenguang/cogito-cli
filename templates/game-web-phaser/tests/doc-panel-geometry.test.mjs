// Placement contract for the in-game documentation entry button (see
// src/doc-panel-geometry.ts, src/scenes/UiScene.ts's mountDocEntry()).
// Same shape as tests/dimensions.test.mjs, on purpose: that file already
// establishes the pattern for making "does not overlap the playfield" a
// computable, machine-checked fact instead of something a screenshot
// review has to notice — this extends the same discipline to the new
// button this change adds.
//
// Pure, bare-Node: src/doc-panel-geometry.ts imports only the zero-import
// src/dimensions.ts, so this needs no DOM/WebGL/bundler to import and run.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GAME_HEIGHT, PLAYFIELD_HEIGHT } from '../src/dimensions.ts'
import {
  getDocButtonRect,
  isRectWithinHudBand,
  overlapsPlayfield,
  DOC_BUTTON_DIAMETER,
} from '../src/doc-panel-geometry.ts'

test('the doc-entry button rect is non-degenerate (real size, not a zero-area no-op)', () => {
  const rect = getDocButtonRect()
  assert.ok(rect.width > 0, `button width was ${rect.width}, expected > 0`)
  assert.ok(rect.height > 0, `button height was ${rect.height}, expected > 0`)
  assert.equal(rect.width, DOC_BUTTON_DIAMETER)
  assert.equal(rect.height, DOC_BUTTON_DIAMETER)
})

test('the doc-entry button (closed state) stays strictly within the reserved HUD band', () => {
  const rect = getDocButtonRect()
  assert.ok(
    isRectWithinHudBand(rect),
    `button rect ${JSON.stringify(rect)} is not fully inside the HUD band ` +
      `[${PLAYFIELD_HEIGHT}, ${GAME_HEIGHT}] — it would cover world geometry`,
  )
})

test('the doc-entry button (closed state) does NOT overlap the playfield at all', () => {
  const rect = getDocButtonRect()
  assert.equal(
    overlapsPlayfield(rect),
    false,
    `button rect ${JSON.stringify(rect)} overlaps the playfield [0, ${PLAYFIELD_HEIGHT}) — ` +
      `it would sit on top of world geometry (dimensions.ts's HUD band / playfield contract)`,
  )
})

// 🔴 Mutation check (AGENTS.md's brief for this change: "把悬浮球挪进
// PLAYFIELD 区 ⇒ 第 3 条断言必须变红；还原 → 绿"). This is the permanent,
// in-suite half of that verification — it proves the predicates above
// actually have teeth by constructing the exact "someone moved the button
// into the playfield" rect by hand and asserting BOTH checks flip. The
// one-off manual half (editing doc-panel-geometry.ts's real margin
// constants, re-running `pnpm test`, watching it fail, then reverting) was
// also performed for this change — see the PR/commit description for that
// run's output — but a manual step leaves no regression coverage behind on
// its own, which is what this test is for.
test('mutation check: a button rect placed inside the playfield fails both placement predicates', () => {
  const badRect = { x: 800, y: 0, width: DOC_BUTTON_DIAMETER, height: DOC_BUTTON_DIAMETER }

  assert.equal(
    isRectWithinHudBand(badRect),
    false,
    'a button rect at y=0 (deep inside the playfield) was reported as within the HUD band — the predicate has no discriminating power',
  )
  assert.equal(
    overlapsPlayfield(badRect),
    true,
    'a button rect at y=0 (deep inside the playfield) was reported as NOT overlapping the playfield — the predicate has no discriminating power',
  )

  // And the real, current placement must NOT trip the same alarm — this is
  // what makes the two assertions above meaningful rather than vacuously
  // true for any input.
  const realRect = getDocButtonRect()
  assert.equal(isRectWithinHudBand(realRect), true)
  assert.equal(overlapsPlayfield(realRect), false)
})
