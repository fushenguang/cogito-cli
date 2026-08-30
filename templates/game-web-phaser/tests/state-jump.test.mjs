// Traversal assertion for the state-jump contract (design D5) — this is the
// "gate lives as an artifact, not a prompt" pattern the whole change is
// about: it doesn't ask an agent whether it wired states up correctly, it
// runs the contract and checks.
//
// 🔴 Legality and reproducibility are two independent assertions on
// purpose — do not merge them into one. A jump() that's reproducible but
// illegal, or legal but non-deterministic, is still broken.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listStates, jump, isValidStart } from '../src/debug/state-jump.ts'

test('every listed state: jump() produces a legal start (合法)', () => {
  for (const id of listStates()) {
    const state = jump(id, 42)
    assert.equal(
      isValidStart(id, state),
      true,
      `jump(${id}, 42) produced an illegal start: ${JSON.stringify(state)}`,
    )
  }
})

test('every listed state: jump() with the same seed is reproducible (可复现)', () => {
  for (const id of listStates()) {
    const first = jump(id, 7)
    const second = jump(id, 7)
    assert.deepEqual(second, first, `jump(${id}, 7) was not reproducible across two calls`)
  }
})

test('negative case: a half-baked state is rejected by isValidStart', () => {
  // Deliberately construct an illegal "Game" start — a player sitting far
  // outside the world bounds GameScene actually enforces. If isValidStart
  // were written as `return true`, this is the test that would catch it.
  const brokenState = { id: 'Game', seed: 0, score: 0, playerX: -999, playerY: 10 }
  assert.equal(isValidStart('Game', brokenState), false)

  // Also cover an id/state mismatch and a negative score, since those are
  // exactly as "half-baked" and just as easy to accidentally accept.
  const mismatchedId = { id: 'Boot', seed: 0, score: 0, playerX: 0, playerY: 0 }
  assert.equal(isValidStart('Game', mismatchedId), false)

  const negativeScore = { id: 'Game', seed: 0, score: -1, playerX: 10, playerY: 10 }
  assert.equal(isValidStart('Game', negativeScore), false)
})
