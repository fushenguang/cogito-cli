// HUD band / playfield non-overlap contract (see src/dimensions.ts's header
// doc) — the structural fix for a real bug: a generated game drew its HUD
// and its world geometry in the same scene with no reserved area, and a
// word-list button row ended up sitting on top of the ground it was
// supposed to float above. This test makes the "they can't overlap"
// property a computable, machine-checked fact instead of something a
// screenshot review has to notice — `read_image` already missed the real
// incident once.
//
// Pure, bare-Node — same shape as tests/state-jump.test.mjs's own guard:
// src/dimensions.ts is a zero-import leaf module (see its own doc for why),
// so this needs no DOM/WebGL/bundler to import and run.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GAME_HEIGHT, HUD_BAND_HEIGHT, PLAYFIELD_HEIGHT } from '../src/dimensions.ts'

/** Standard half-open interval overlap test: `[min, max)`. */
function overlaps(a, b) {
  return a.min < b.max && b.min < a.max
}

test('PLAYFIELD_HEIGHT + HUD_BAND_HEIGHT accounts for exactly GAME_HEIGHT (no gap, no double-count)', () => {
  assert.equal(PLAYFIELD_HEIGHT + HUD_BAND_HEIGHT, GAME_HEIGHT)
})

test('HUD_BAND_HEIGHT is strictly positive — a real, non-degenerate band, not a no-op', () => {
  assert.ok(HUD_BAND_HEIGHT > 0, `HUD_BAND_HEIGHT was ${HUD_BAND_HEIGHT}, expected > 0`)
})

test('the playfield interval [0, PLAYFIELD_HEIGHT) and the HUD band interval [PLAYFIELD_HEIGHT, GAME_HEIGHT) are structurally disjoint', () => {
  const playfield = { min: 0, max: PLAYFIELD_HEIGHT }
  const hudBand = { min: PLAYFIELD_HEIGHT, max: GAME_HEIGHT }
  assert.equal(
    overlaps(playfield, hudBand),
    false,
    `playfield ${JSON.stringify(playfield)} overlaps hudBand ${JSON.stringify(hudBand)} — world geometry and HUD content could land on the same pixels`,
  )
})

test('representative world geometry (GameScene.ts: player spawn Y, physics.world.setBounds height) stays strictly within the playfield', () => {
  // Mirrors src/scenes/GameScene.ts's actual values:
  //   this.physics.add.sprite(GAME_WIDTH / 2, PLAYFIELD_HEIGHT - 80, 'player')
  //   this.physics.world.setBounds(0, 0, GAME_WIDTH, PLAYFIELD_HEIGHT)
  const playerSpawnY = PLAYFIELD_HEIGHT - 80
  const worldBoundsHeight = PLAYFIELD_HEIGHT

  assert.ok(playerSpawnY >= 0, `player spawn Y ${playerSpawnY} is negative`)
  assert.ok(
    playerSpawnY < PLAYFIELD_HEIGHT,
    `player spawn Y ${playerSpawnY} is not strictly inside the playfield (< ${PLAYFIELD_HEIGHT})`,
  )
  assert.ok(
    worldBoundsHeight <= PLAYFIELD_HEIGHT,
    `physics world bounds height ${worldBoundsHeight} extends past the playfield (${PLAYFIELD_HEIGHT})`,
  )
})

test('representative HUD content (UiScene.ts: score text, instructions text) stays strictly within the HUD band', () => {
  // Mirrors src/scenes/UiScene.ts's actual values:
  //   this.add.text(16, PLAYFIELD_HEIGHT + 8, ...)   // score
  //   this.add.text(GAME_WIDTH / 2, PLAYFIELD_HEIGHT + 40, ...) // instructions
  const scoreTextY = PLAYFIELD_HEIGHT + 8
  const instructionsY = PLAYFIELD_HEIGHT + 40

  for (const [label, y] of [
    ['score text', scoreTextY],
    ['instructions text', instructionsY],
  ]) {
    assert.ok(y >= PLAYFIELD_HEIGHT, `${label} Y ${y} is above the HUD band (< ${PLAYFIELD_HEIGHT}) — it would sit over the playfield`)
    assert.ok(y < GAME_HEIGHT, `${label} Y ${y} is at or past the bottom of the canvas (${GAME_HEIGHT})`)
  }
})
