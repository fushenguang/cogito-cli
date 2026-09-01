// Tests for scripts/lib/ink.mjs — the pixel half of selfcheck's critical-copy
// assertion. Same zero-dep fixture trick as tests/png.test.mjs: synthesize a
// PNG, decode it with scripts/lib/png.mjs, run the region analysis on it.
//
// 🔴 Required negative cases (the whole point of this module's design — see
// its header doc): a solid-colour region MUST read inkRatio 0, and the
// measurement method is only trustworthy when it can also read ~0 where
// nothing is drawn while reading high where text is.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodePng } from '../scripts/lib/png.mjs'
import { encodeTestPng } from './helpers/make-test-png.mjs'
import { clampRect, regionInkStats } from '../scripts/lib/ink.mjs'

// Fixed-page backdrop #141824, heading ink #f4f6fb (src/game-doc.ts DEFAULT_THEME).
const BACKDROP = [20, 24, 36]
const HEADING = [244, 246, 251]

function decodeFixture(width, height, pixelFn) {
  return decodePng(encodeTestPng(width, height, pixelFn))
}

test('a solid-backdrop region reads inkRatio 0 — the required negative case', () => {
  const decoded = decodeFixture(40, 40, () => BACKDROP)
  const stats = regionInkStats(decoded, { x: 0, y: 0, width: 40, height: 40 })
  assert.equal(stats.inkRatio, 0)
  assert.equal(stats.sampled, 1600)
  assert.deepEqual(stats.modalColor, BACKDROP)
  assert.equal(stats.modalRatio, 1)
})

test('a text-like region (ink pixels on the backdrop) reads a high inkRatio', () => {
  // 100x100 backdrop with a 40x8 "word" of heading-colour pixels inside it.
  const decoded = decodeFixture(100, 100, (x, y) =>
    x >= 20 && x < 60 && y >= 46 && y < 54 ? HEADING : BACKDROP,
  )
  const stats = regionInkStats(decoded, { x: 10, y: 40, width: 80, height: 20 })
  // 320 ink px / 1600 sampled = 0.2
  assert.equal(stats.inkRatio, 0.2)
  assert.deepEqual(stats.modalColor, BACKDROP)
})

test('ink threshold is distance-from-modal, not a target colour: grey text on dark counts', () => {
  // The 2026-09-01 hand-rolled predicate this module replaced failed exactly
  // here — grey #9ca3af copy was excluded by a "bright pixel" threshold.
  const grey = [156, 163, 175]
  const decoded = decodeFixture(60, 20, (x, y) => (y >= 8 && y < 12 ? grey : BACKDROP))
  const stats = regionInkStats(decoded, { x: 0, y: 0, width: 60, height: 20 })
  assert.ok(stats.inkRatio > 0, `grey text must count as ink, got ${stats.inkRatio}`)
})

test('a rect entirely outside the image throws — a coordinate bug must not read as "no ink"', () => {
  const decoded = decodeFixture(10, 10, () => BACKDROP)
  assert.throws(() => regionInkStats(decoded, { x: 50, y: 50, width: 5, height: 5 }), /entirely outside/)
})

test('clampRect clips partial overhang and integerizes', () => {
  // x: -3.2..6.8 clipped to [0,8] → [0,7] (ceil 6.8 = 7); y: 1.7..11.7 → [1,12]
  assert.deepEqual(clampRect({ x: -3.2, y: 1.7, width: 10, height: 10 }, { width: 8, height: 100 }), {
    x: 0,
    y: 1,
    width: 7,
    height: 11,
  })
})
