// Unit tests for the pure half of scripts/playtest.mjs — argument parsing,
// default-state selection, and the entity delta formatter.
//
// The browser half is deliberately not unit-tested (it needs a real Chromium);
// what IS testable is exactly the part that would rot silently, so it's covered
// here rather than left to "it worked when I ran it once".
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, pickDefaultState, formatEntityDelta } from '../scripts/playtest.mjs'

test('parseArgs: defaults', () => {
  const o = parseArgs([])
  assert.equal(o.state, null)
  assert.deepEqual(o.press, [])
  assert.equal(o.pressMs, 600)
  // 🔴 settle must never default to 0 — applyState() resolves before the scene
  // is live, and reading too early makes a working jump look broken.
  assert.equal(o.settleMs, 400)
  assert.equal(o.trigger, null)
  assert.equal(o.seed, 1)
})

test('parseArgs: every flag', () => {
  const o = parseArgs([
    '--state', 'Level3', '--press', 'ArrowRight, Space ,', '--ms', '800',
    '--settle', '250', '--trigger', 'goal', '--shot', 'out.png', '--seed', '7',
  ])
  assert.equal(o.state, 'Level3')
  assert.deepEqual(o.press, ['ArrowRight', 'Space'])   // trimmed, empties dropped
  assert.equal(o.pressMs, 800)
  assert.equal(o.settleMs, 250)
  assert.equal(o.trigger, 'goal')
  assert.equal(o.shot, 'out.png')
  assert.equal(o.seed, 7)
})

test('pickDefaultState: picks the LAST gameplay state, not the first', () => {
  // A multi-level game lists its levels in order; "can the player still reach
  // the goal in the FINAL level?" is the question worth asking automatically.
  const states = [
    { id: 'Boot', role: 'other' },
    { id: 'Level1', role: 'gameplay' },
    { id: 'Level5', role: 'gameplay' },
    { id: 'GameOver', role: 'gameover' },
  ]
  assert.equal(pickDefaultState(states), 'Level5')
})

test('pickDefaultState: no gameplay state -> null (caller reports, never guesses)', () => {
  assert.equal(pickDefaultState([{ id: 'Boot', role: 'other' }]), null)
})

test('formatEntityDelta: movement, stillness, appearance, disappearance', () => {
  const before = [
    { name: 'player', x: 100, y: 200 },
    { name: 'rock', x: 10, y: 10 },
    { name: 'gone', x: 1, y: 1 },
  ]
  const after = [
    { name: 'player', x: 260, y: 200 },
    { name: 'rock', x: 10, y: 10 },
    { name: 'coin', x: 50, y: 50 },
  ]
  const lines = formatEntityDelta(before, after).join('\n')

  assert.match(lines, /~ player: \(100\.0, 200\.0\) -> \(260\.0, 200\.0\)\s+dx=160\.0 dy=0\.0/)
  // Unchanged entities are reported with their numbers and a `=` marker — and
  // with NO prose. See the next test for why that absence is load-bearing.
  assert.match(lines, /= rock: \(10\.0, 10\.0\) -> \(10\.0, 10\.0\)\s+dx=0\.0 dy=0\.0/)
  assert.match(lines, /\+ coin: \(—\) -> \(50\.0, 50\.0\)/)
  // An entity vanishing is reported, never skipped: "the player object stopped
  // existing" is exactly what this instrument is for.
  assert.match(lines, /- gone: \(1\.0, 1\.0\) -> \(—\)/)
})

test('formatEntityDelta: sub-pixel jitter reads as unchanged (`=`)', () => {
  const lines = formatEntityDelta(
    [{ name: 'player', x: 100, y: 100 }],
    [{ name: 'player', x: 100.3, y: 100.2 }],
  ).join('\n')
  assert.match(lines, /^\s*= player:/)
})

/**
 * 🔴 The load-bearing test of this file: **the output must contain no verdicts.**
 *
 * The first shipped version annotated unchanged entities with `<- did not move`,
 * and AGENTS.md told readers that meant "the control key is dead". A real run
 * showed it firing on `goal` — the level's target, which is *supposed* to stay
 * put — with the exact same wording as a broken control. This script cannot
 * know which entities ought to move, so it must not phrase anything as a
 * conclusion. `dx=0.0` is a reading; "did not move" is a verdict.
 *
 * This test is what stops that from creeping back in one helpful sentence at
 * a time.
 */
test('formatEntityDelta: prints readings, never verdicts', () => {
  const lines = formatEntityDelta(
    [{ name: 'player', x: 100, y: 100 }, { name: 'goal', x: 900, y: 400 }, { name: 'gone', x: 1, y: 1 }],
    [{ name: 'player', x: 100, y: 100 }, { name: 'goal', x: 900, y: 400 }, { name: 'coin', x: 5, y: 5 }],
  ).join('\n')
  for (const verdict of [
    'did not move',
    'appeared',
    'disappeared',
    'dead',
    'broken',
    'failed',
    'should',
    'expected',
    'unreachable',
  ]) {
    assert.ok(!lines.includes(verdict), `output must not contain the verdict word "${verdict}": ${lines}`)
  }
})
