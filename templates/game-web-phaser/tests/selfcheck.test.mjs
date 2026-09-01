// Tests for scripts/selfcheck.mjs's pure helpers. The browser half of that
// script is the postbuild gate itself (run via `pnpm build:play`); what can
// rot silently is exactly the timing/geometry math below, so it is unit
// tested like every other script lib (same pattern as tests/playtest.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planJumpTaps, scaleRect, rectCenter } from '../scripts/selfcheck.mjs'

test('planJumpTaps schedules the first hop after one interval, not at t=0', () => {
  const taps = planJumpTaps(3000, 800, 200)
  assert.deepEqual(taps.map((t) => t.atMs), [800, 1600, 2400])
})

test('planJumpTaps never schedules a tap whose hold would outlast the horizon', () => {
  const taps = planJumpTaps(2000, 800, 200)
  // 1600 + 200 = 1800 ≤ 2000 ✓; a 2400 tap would exceed — absent.
  assert.deepEqual(taps.map((t) => t.atMs), [800, 1600])
  assert.ok(taps.every((t) => t.atMs + t.holdMs <= 2000))
})

test('planJumpTaps returns empty for a horizon shorter than one interval+hold', () => {
  assert.deepEqual(planJumpTaps(500, 800, 200), [])
})

test('scaleRect multiplies every field by the device pixel ratio', () => {
  assert.deepEqual(
    scaleRect({ x: 10, y: 20, width: 30, height: 40 }, 2),
    { x: 20, y: 40, width: 60, height: 80 },
  )
  assert.deepEqual(
    scaleRect({ x: 10, y: 20, width: 30, height: 40 }, 1),
    { x: 10, y: 20, width: 30, height: 40 },
  )
})

test('rectCenter lands mid-rect — where a real click aims', () => {
  assert.deepEqual(rectCenter({ x: 100, y: 200, width: 60, height: 40 }), { x: 130, y: 220 })
})
