// Tests for scripts/lib/png.mjs — design D4.
//
// 🔴 The required negative case: a solid-colour PNG is a perfectly valid
// PNG and MUST be judged empty. Without this test, judgeScreenshotNonEmpty
// could be `return { nonEmpty: true }` and every positive-only test would
// still pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodePng, judgeScreenshotNonEmpty } from '../scripts/lib/png.mjs'
import { encodeTestPng } from './helpers/make-test-png.mjs'

test('decodePng round-trips a known pixel pattern', () => {
  const base64 = encodeTestPng(2, 2, (x, y) => [x * 10, y * 20, 5])
  const decoded = decodePng(base64)

  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.equal(decoded.channels, 3)

  const pixelAt = (x, y) => {
    const base = (y * decoded.width + x) * decoded.channels
    return [decoded.pixels[base], decoded.pixels[base + 1], decoded.pixels[base + 2]]
  }
  assert.deepEqual(pixelAt(0, 0), [0, 0, 5])
  assert.deepEqual(pixelAt(1, 0), [10, 0, 5])
  assert.deepEqual(pixelAt(0, 1), [0, 20, 5])
  assert.deepEqual(pixelAt(1, 1), [10, 20, 5])
})

test('negative case: a solid-colour PNG is judged EMPTY', () => {
  const base64 = encodeTestPng(24, 24, () => [29, 31, 43]) // this template's own bg colour, solid
  const decoded = decodePng(base64)
  const judged = judgeScreenshotNonEmpty(decoded)

  assert.equal(
    judged.nonEmpty,
    false,
    `expected a solid-colour PNG to be judged empty, got: ${JSON.stringify(judged)}`,
  )
  assert.equal(judged.uniqueColors, 1)
})

test('a PNG with real visual content is judged NON-EMPTY', () => {
  const base64 = encodeTestPng(24, 24, (x, y) =>
    (x + y) % 2 === 0 ? [96, 165, 250] : [29, 31, 43],
  )
  const decoded = decodePng(base64)
  const judged = judgeScreenshotNonEmpty(decoded)

  assert.equal(
    judged.nonEmpty,
    true,
    `expected a checkerboard PNG to be judged non-empty, got: ${JSON.stringify(judged)}`,
  )
  assert.ok(judged.uniqueColors >= 2)
  assert.ok(judged.variance >= 1)
})

test('a zero-size image is judged EMPTY without throwing', () => {
  const judged = judgeScreenshotNonEmpty({
    width: 0,
    height: 0,
    channels: 3,
    pixels: Buffer.alloc(0),
  })
  assert.equal(judged.nonEmpty, false)
})

// 2026-08-30 (`cogito-cli` extraction): the `maxDominantRatio` void detector.
// The shape below is the M1 run2 void in miniature: ~90% one dark slate, a
// thin strip of "floor", nothing else. The OLD defaults (minUniqueColors 2,
// minVariance 1) judge this world non-empty — that green is exactly how a
// 87%-single-colour frame shipped as a rendered level (cogito-lib #138).

test('run2 void shape: mostly-one-colour world passes OLD defaults but is caught by maxDominantRatio', () => {
  const base64 = encodeTestPng(24, 24, (x, y) => (y >= 22 ? [96, 165, 250] : [29, 31, 43]))
  const decoded = decodePng(base64)

  // old gate: two colours and real variance → judged non-empty (the blind spot)
  const oldJudged = judgeScreenshotNonEmpty(decoded)
  assert.equal(oldJudged.nonEmpty, true)
  assert.ok(oldJudged.dominantRatio >= 0.9, `expected dominant share ~0.9, got ${oldJudged.dominantRatio}`)

  // new ceiling: same frame is a void
  const judged = judgeScreenshotNonEmpty(decoded, { maxDominantRatio: 0.8 })
  assert.equal(judged.nonEmpty, false)
  assert.match(judged.reason ?? '', /dominantRatio=/)
})

test('a richly drawn world clears a strict ceiling (dominant well under it)', () => {
  const base64 = encodeTestPng(32, 32, (x, y) => [(x * 8) % 256, (y * 8) % 256, ((x + y) * 4) % 256])
  const decoded = decodePng(base64)
  const judged = judgeScreenshotNonEmpty(decoded, { maxDominantRatio: 0.8 })

  assert.equal(judged.nonEmpty, true)
  assert.ok(judged.dominantRatio < 0.1, `expected gradient dominant share tiny, got ${judged.dominantRatio}`)
})

test('default thresholds keep maxDominantRatio at Infinity — existing callers see no behavior change', () => {
  // solid colour: still empty via uniqueColors, reason does NOT mention dominant
  const decoded = decodePng(encodeTestPng(8, 8, () => [29, 31, 43]))
  const judged = judgeScreenshotNonEmpty(decoded)
  assert.equal(judged.nonEmpty, false)
  assert.doesNotMatch(judged.reason ?? '', /dominantRatio=/)
})
