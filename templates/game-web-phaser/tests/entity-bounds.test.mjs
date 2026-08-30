// Tests for scripts/lib/entity-bounds.mjs — trigger-integrity-and-onscreen-gate
// task 2.2 / design D4. Pure function, no browser needed — same shape as
// tests/png.test.mjs's coverage of judgeScreenshotNonEmpty().

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeEntitiesWithinBounds, ENTITY_BOUNDS_MARGIN_PX, BOUNDS_OBSERVATION_MS } from '../scripts/lib/entity-bounds.mjs'

const WORLD_BOUNDS = { x: 0, y: 0, width: 960, height: 540, source: 'physics.world.bounds' }

test('judgeEntitiesWithinBounds: passes when every entity is inside the world', () => {
  const entities = [
    { name: 'player', x: 480, y: 460 },
    { name: 'goal', x: 100, y: 100 },
  ]
  const result = judgeEntitiesWithinBounds(entities, WORLD_BOUNDS)
  assert.equal(result.ok, true)
  assert.deepEqual(result.outOfBounds, [])
})

test('judgeEntitiesWithinBounds: an entity sitting a bit past the edge, inside the margin, still passes', () => {
  const entities = [{ name: 'player', x: 960 + ENTITY_BOUNDS_MARGIN_PX, y: 200 }]
  const result = judgeEntitiesWithinBounds(entities, WORLD_BOUNDS)
  assert.equal(result.ok, true)
})

test('judgeEntitiesWithinBounds: fails when a named entity has fallen well outside the world (E-15\'s shape — a flag/spike falling forever under gravity)', () => {
  const entities = [
    { name: 'player', x: 480, y: 460 },
    { name: 'goal', x: 300, y: 5000 }, // fell straight through the floor
  ]
  const result = judgeEntitiesWithinBounds(entities, WORLD_BOUNDS)
  assert.equal(result.ok, false)
  assert.equal(result.outOfBounds.length, 1)
  assert.equal(result.outOfBounds[0].name, 'goal')
})

test('judgeEntitiesWithinBounds: negative x/y (fell off the top/left) is also out of bounds', () => {
  const entities = [{ name: 'spike', x: -900, y: 50 }]
  const result = judgeEntitiesWithinBounds(entities, WORLD_BOUNDS)
  assert.equal(result.ok, false)
  assert.equal(result.outOfBounds[0].name, 'spike')
})

test('judgeEntitiesWithinBounds: reports every out-of-bounds entity, not just the first (negative case — a `some()`-only check would miss the second one)', () => {
  const entities = [
    { name: 'goal', x: 300, y: 5000 },
    { name: 'spike', x: 400, y: 6000 },
    { name: 'player', x: 480, y: 460 },
  ]
  const result = judgeEntitiesWithinBounds(entities, WORLD_BOUNDS)
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.outOfBounds.map((e) => e.name).sort(),
    ['goal', 'spike'],
  )
})

test('judgeEntitiesWithinBounds: an empty entity list passes trivially — nothing to be out of bounds', () => {
  const result = judgeEntitiesWithinBounds([], WORLD_BOUNDS)
  assert.equal(result.ok, true)
})

// ───────────────────────────────────────────────────────────────────────
// BOUNDS_OBSERVATION_MS — design D8's own-observation-window constant.
// Not much to unit test about a constant beyond "it's the documented
// value and stays a positive, sane number" — the real coverage for D8's
// logic (applyState -> wait -> sample, and the "no gameplay state" note)
// lives in the real-machine verification in the PR/report, since it needs
// a live harness driving a real scene transition, which this bare-Node
// suite deliberately has none of (see judgeEntitiesWithinBounds's own
// header comment on why the pure geometry judge is what's unit tested here).
// ───────────────────────────────────────────────────────────────────────

test('BOUNDS_OBSERVATION_MS is the documented 2000ms floor, not silently redefined', () => {
  assert.equal(BOUNDS_OBSERVATION_MS, 2000)
})
