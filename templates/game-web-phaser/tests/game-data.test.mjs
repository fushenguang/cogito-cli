// Contract tests for game-data.json's validation, accessors, consumption
// registry, and the three-layer evidence builder (see src/game-data.ts).
// Pure, bare-Node — same leaf-module discipline as tests/game-assets.test.mjs
// (src/game-data.ts imports only src/game-assets.ts and src/dimensions.ts,
// both import-free).
//
// 🔴 This module has STATE (initialized flag + consumption registry), unlike
// game-assets.ts's pure functions — every stateful test starts from
// __resetGameDataForTests() so a previous test's consumption can never leak
// into the next one's evidence.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAndValidateGameData,
  initGameData,
  isGameDataInitialized,
  getActiveLevel,
  getLevelById,
  getGameRules,
  getVocabulary,
  getConsumedEntries,
  listDeclaredEntries,
  buildDataUsageEvidence,
  __resetGameDataForTests,
} from '../src/game-data.ts'

beforeEach(() => __resetGameDataForTests())

const VALID_MANIFEST_TEXT = JSON.stringify({
  levels: [
    {
      id: 'level-1',
      name: '第一关：捡星尘',
      backgroundLevel: 1,
      playerSpawn: { x: 480, y: 396 },
      initialCoins: [{ x: 160, y: 120 }],
      initialObstacles: [{ x: 240, y: 360 }],
    },
  ],
  rules: { playerSpeed: 260, bulletSpeed: 420, coinValue: 1, shootValue: 1 },
})

// GAME_WIDTH=960, PLAYFIELD_HEIGHT=476 (src/dimensions.ts).
const PLAYFIELD_HEIGHT = 540 - 64

// ───────────────────────────────────────────────────────────────────────
// 1. Validation — strict by design (empty shells die here, spec)
// ───────────────────────────────────────────────────────────────────────

test('a valid manifest parses with its content intact', () => {
  const manifest = parseAndValidateGameData(VALID_MANIFEST_TEXT)
  assert.equal(manifest.levels.length, 1)
  const level = manifest.levels[0]
  assert.equal(level.id, 'level-1')
  assert.equal(level.backgroundLevel, 1)
  assert.deepEqual(level.playerSpawn, { x: 480, y: 396 })
  assert.deepEqual(level.initialCoins, [{ x: 160, y: 120 }])
  assert.deepEqual(manifest.rules, { playerSpeed: 260, bulletSpeed: 420, coinValue: 1, shootValue: 1 })
})

test('vocabulary is optional and passes through when present', () => {
  const manifest = parseAndValidateGameData(
    JSON.stringify({ levels: JSON.parse(VALID_MANIFEST_TEXT).levels, vocabulary: { build: ['platform', 'jump'] } }),
  )
  assert.deepEqual(manifest.vocabulary, { build: ['platform', 'jump'] })
})

test('missing file (raw undefined) throws — the data layer is required, not optional', () => {
  assert.throws(() => parseAndValidateGameData(undefined), /未能加载/)
})

test('malformed JSON throws with a locatable root path', () => {
  assert.throws(() => parseAndValidateGameData('{ not valid json'), /game-data\.json: \(root\)/)
})

test('non-object root throws', () => {
  assert.throws(() => parseAndValidateGameData('[1,2,3]'), /必须是对象/)
})

test('missing levels section throws', () => {
  assert.throws(() => parseAndValidateGameData(JSON.stringify({ rules: {} })), /levels/)
})

test('empty levels array is an empty shell and throws — never a silent empty', () => {
  assert.throws(() => parseAndValidateGameData(JSON.stringify({ levels: [] })), /空壳/)
})

test('a level entry missing playerSpawn throws naming its path', () => {
  const broken = { levels: [{ id: 'level-1', name: 'x', backgroundLevel: 1 }] }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /levels\[0\]\.playerSpawn/)
})

test('a spawn point outside the playfield throws naming the bound it broke', () => {
  const broken = {
    levels: [
      { id: 'level-1', name: 'x', backgroundLevel: 1, playerSpawn: { x: 100, y: PLAYFIELD_HEIGHT + 50 }, initialCoins: [], initialObstacles: [] },
    ],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /playerSpawn\.y/)
})

test('backgroundLevel 0 breaks the game-assets level<N> numbering contract and throws', () => {
  const broken = {
    levels: [{ id: 'level-1', name: 'x', backgroundLevel: 0, playerSpawn: { x: 10, y: 10 }, initialCoins: [], initialObstacles: [] }],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /backgroundLevel/)
})

// ───────────────────────────────────────────────────────────────────────
// 2. Module state, accessors, consumption registry (design D2)
// ───────────────────────────────────────────────────────────────────────

test('accessors throw before initGameData — never hand out data that was never loaded', () => {
  assert.throws(() => getActiveLevel(), /未初始化/)
  assert.throws(() => getGameRules(), /未初始化/)
})

test('initGameData initializes; getActiveLevel/getGameRules return entries and record consumption', () => {
  initGameData(VALID_MANIFEST_TEXT)
  assert.equal(isGameDataInitialized(), true)

  const level = getActiveLevel()
  assert.equal(level.id, 'level-1')
  const rules = getGameRules()
  assert.equal(rules.playerSpeed, 260)

  assert.deepEqual(getConsumedEntries(), [
    { id: 'levels:level-1', section: 'levels' },
    { id: 'rules', section: 'rules' },
  ])
})

test('rules is optional in the manifest; consuming it without declaring it throws locatably', () => {
  initGameData(JSON.stringify({ levels: JSON.parse(VALID_MANIFEST_TEXT).levels }))
  assert.equal(getActiveLevel().id, 'level-1')
  assert.throws(() => getGameRules(), /rules/)
})

test('getLevelById consumes on hit and returns null (consuming nothing) on miss', () => {
  initGameData(VALID_MANIFEST_TEXT)
  assert.equal(getLevelById('nope'), null)
  assert.deepEqual(getConsumedEntries(), [])
  assert.equal(getLevelById('level-1').id, 'level-1')
  assert.deepEqual(getConsumedEntries(), [{ id: 'levels:level-1', section: 'levels' }])
})

test('getVocabulary consumes every key it hands out', () => {
  initGameData(JSON.stringify({ levels: JSON.parse(VALID_MANIFEST_TEXT).levels, vocabulary: { build: ['a'], move: ['b'] } }))
  getVocabulary()
  assert.deepEqual(
    [...getConsumedEntries()].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'vocabulary:build', section: 'vocabulary' },
      { id: 'vocabulary:move', section: 'vocabulary' },
    ],
  )
})

// ───────────────────────────────────────────────────────────────────────
// 3. Three-layer evidence (design D2) — each gap has its own signature
// ───────────────────────────────────────────────────────────────────────

test('no text cached + never initialized => evidence is null (「从未声明」, not an empty set)', () => {
  assert.equal(buildDataUsageEvidence(undefined), null)
})

test('manifest present but loader never ran => declared non-empty, loaded empty — the V2 "清单可以有，没人碰" shape survives intact', () => {
  const evidence = buildDataUsageEvidence(VALID_MANIFEST_TEXT)
  assert.deepEqual(evidence.declared, [
    { id: 'levels:level-1', section: 'levels' },
    { id: 'rules', section: 'rules' },
  ])
  assert.deepEqual(evidence.loaded, [])
  assert.deepEqual(evidence.usedInScene, [])
})

test('initialized + consumed => all three layers populated', () => {
  initGameData(VALID_MANIFEST_TEXT)
  getActiveLevel()
  getGameRules()
  const evidence = buildDataUsageEvidence(VALID_MANIFEST_TEXT)
  assert.equal(evidence.declared.length, 2)
  assert.equal(evidence.loaded.length, 2)
  assert.equal(evidence.usedInScene.length, 2)
})

test('lenient listing: even an invalid manifest yields its declared entries (strict validation would hide exactly the shape this layer exists to expose)', () => {
  const emptyShell = JSON.stringify({ levels: [] })
  const evidence = buildDataUsageEvidence(emptyShell)
  assert.deepEqual(evidence.declared, [])
  assert.deepEqual(evidence.loaded, [])
  assert.deepEqual(evidence.usedInScene, [])
  // Non-null: the file IS there; it just declares nothing. The judge treats
  // declared.length === 0 the same as null — both fail data_from_files.
  assert.notEqual(evidence, null)
})

test('lenient listing of a level without an id falls back to its index, never throws', () => {
  const evidence = buildDataUsageEvidence(JSON.stringify({ levels: [{ playerSpawn: { x: 1, y: 1 } }] }))
  assert.deepEqual(evidence.declared, [{ id: 'levels:0', section: 'levels' }])
})

// ───────────────────────────────────────────────────────────────────────
// 4. 「换数据即换关」— re-init with different data changes what scenes get,
//    with no code change anywhere (spec scenario, tested at the data layer;
//    the built-artifact version of this is pnpm verify on the template)
// ───────────────────────────────────────────────────────────────────────

test('re-initializing with different data changes the active level, and stale consumption never counts as use of the new manifest', () => {
  initGameData(VALID_MANIFEST_TEXT)
  getActiveLevel() // consumed levels:level-1

  const level2Text = JSON.stringify({
    levels: [
      {
        id: 'level-2',
        name: '第二关',
        backgroundLevel: 2,
        playerSpawn: { x: 100, y: 100 },
        initialCoins: [],
        initialObstacles: [],
      },
    ],
  })
  initGameData(level2Text)
  const level = getActiveLevel()
  assert.equal(level.id, 'level-2')
  assert.deepEqual(level.playerSpawn, { x: 100, y: 100 })

  const evidence = buildDataUsageEvidence(level2Text)
  // declared is the NEW manifest only; the stale levels:level-1 consumption
  // is filtered out by the declared-intersection, and level-2 counts.
  assert.deepEqual(evidence.declared, [{ id: 'levels:level-2', section: 'levels' }])
  assert.deepEqual(evidence.usedInScene, [{ id: 'levels:level-2', section: 'levels' }])
})
