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
  getLevelByIndex,
  getLevelCount,
  getGameRules,
  getVocabulary,
  getConsumedEntries,
  listDeclaredEntries,
  buildDataUsageEvidence,
  getPersistValueNames,
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
      platforms: [{ x: 0, y: 436, width: 960, height: 40 }],
      goal: { x: 900, y: 412 },
      initialCoins: [{ x: 160, y: 120 }],
      initialObstacles: [{ x: 240, y: 360 }],
    },
  ],
  rules: { playerSpeed: 260, jumpVelocity: 500, gravityY: 1000, coinValue: 1 },
})

// Two-level manifest — the multi-level flow (0.9.0) shape: levels[1..] is
// now reachable via getLevelByIndex, which is what makes it count as
// consumed in the evidence layer.
const SECOND_LEVEL = {
  id: 'level-2',
  name: '第二关',
  backgroundLevel: 2,
  playerSpawn: { x: 100, y: 396 },
  platforms: [{ x: 0, y: 436, width: 960, height: 40 }],
  goal: { x: 860, y: 412 },
  initialCoins: [],
  initialObstacles: [],
}
const TWO_LEVEL_TEXT = JSON.stringify({ levels: [JSON.parse(VALID_MANIFEST_TEXT).levels[0], SECOND_LEVEL], rules: JSON.parse(VALID_MANIFEST_TEXT).rules })

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
  assert.deepEqual(level.platforms, [{ x: 0, y: 436, width: 960, height: 40 }])
  assert.deepEqual(level.goal, { x: 900, y: 412 })
  assert.deepEqual(level.initialCoins, [{ x: 160, y: 120 }])
  assert.deepEqual(manifest.rules, { playerSpeed: 260, jumpVelocity: 500, gravityY: 1000, coinValue: 1 })
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
      { id: 'level-1', name: 'x', backgroundLevel: 1, playerSpawn: { x: 100, y: PLAYFIELD_HEIGHT + 50 }, platforms: [{ x: 0, y: 436, width: 960, height: 40 }], goal: { x: 900, y: 412 }, initialCoins: [], initialObstacles: [] },
    ],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /playerSpawn\.y/)
})

test('empty platforms is the "empty runway" shape and throws — the 小小财迷 garbage-game root', () => {
  const broken = {
    levels: [
      { id: 'level-1', name: 'x', backgroundLevel: 1, playerSpawn: { x: 100, y: 100 }, platforms: [], goal: { x: 900, y: 412 }, initialCoins: [], initialObstacles: [] },
    ],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /空跑道/)
})

test('a platform hanging into the HUD band throws naming the bound it broke', () => {
  const broken = {
    levels: [
      { id: 'level-1', name: 'x', backgroundLevel: 1, playerSpawn: { x: 100, y: 100 }, platforms: [{ x: 0, y: 460, width: 960, height: 40 }], goal: { x: 900, y: 412 }, initialCoins: [], initialObstacles: [] },
    ],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /platforms\[0\]\.y/)
})

test('a level missing goal throws naming its path — no exit, no factory-playable floor', () => {
  const broken = {
    levels: [
      { id: 'level-1', name: 'x', backgroundLevel: 1, playerSpawn: { x: 100, y: 100 }, platforms: [{ x: 0, y: 436, width: 960, height: 40 }], initialCoins: [], initialObstacles: [] },
    ],
  }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /levels\[0\]\.goal/)
})

test('backgroundLevel 0 breaks the game-assets level<N> numbering contract and throws', () => {
  const broken = {
    levels: [{ id: 'level-1', name: 'x', backgroundLevel: 0, playerSpawn: { x: 10, y: 10 }, platforms: [{ x: 0, y: 436, width: 960, height: 40 }], goal: { x: 900, y: 412 }, initialCoins: [], initialObstacles: [] }],
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

test('getLevelByIndex reaches levels[1..] (multi-level flow) and records consumption on hit only', () => {
  initGameData(TWO_LEVEL_TEXT)
  assert.equal(getLevelCount(), 2)
  assert.equal(getLevelByIndex(1).id, 'level-2')
  // Before 0.9.0, levels[1] had NO consumer at all — that is exactly the
  // evidence gap this accessor closes, so the consumption side is the
  // assertion, not an afterthought.
  assert.deepEqual(getConsumedEntries(), [{ id: 'levels:level-2', section: 'levels' }])
  // Miss consumes nothing and hands back null — the caller owns the branch.
  assert.equal(getLevelByIndex(2), null)
  assert.equal(getLevelByIndex(-1), null)
  assert.deepEqual(getConsumedEntries(), [{ id: 'levels:level-2', section: 'levels' }])
})

test('getLevelCount has no consumption side effect — the branch check itself is free', () => {
  initGameData(VALID_MANIFEST_TEXT)
  assert.equal(getLevelCount(), 1)
  assert.deepEqual(getConsumedEntries(), [])
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
        platforms: [{ x: 0, y: 436, width: 960, height: 40 }],
        goal: { x: 500, y: 412 },
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

// ───────────────────────────────────────────────────────────────────────
// levels[i].extension — the project-mechanics hook (2026-09-01, first
// consumer: the 小小财迷 v2 reopen). The validation boundary that matters:
// module charset is the path-traversal guard (the runtime resolves it to
// src/extensions/<module>.ts inside the bundle), config is shape-only
// (its fields belong to the extension, never to this schema).
// ───────────────────────────────────────────────────────────────────────

const LEVEL_WITH_EXTENSION = {
  id: 'level-1', name: '第一个愿望', backgroundLevel: 1,
  playerSpawn: { x: 80, y: 400 },
  platforms: [{ x: 0, y: 436, width: 960, height: 40 }],
  goal: { x: 910, y: 412 }, initialCoins: [], initialObstacles: [],
}

test('a level with a well-formed extension declaration validates and round-trips module + config', () => {
  const manifest = {
    levels: [{
      ...LEVEL_WITH_EXTENSION,
      extension: { module: 'opportunity-window', config: { windowMs: 8000, opportunities: [{ order: 1, x: 400, y: 404 }] } },
    }],
  }
  const parsed = parseAndValidateGameData(JSON.stringify(manifest))
  assert.equal(parsed.levels[0].extension?.module, 'opportunity-window')
  assert.deepEqual(parsed.levels[0].extension?.config, { windowMs: 8000, opportunities: [{ order: 1, x: 400, y: 404 }] })
})

test('extension.module is the path-traversal guard: ../, slashes, dots and spaces all throw', () => {
  // The runtime resolves module to src/extensions/<module>.ts — anything
  // outside that directory (or outside the bundle's key format) must die
  // at validation, never at runtime.
  for (const module of ['../hack', 'a/b', '..', 'a.ts', 'mod ule', '']) {
    const broken = { levels: [{ ...LEVEL_WITH_EXTENSION, extension: { module } }] }
    assert.throws(
      () => parseAndValidateGameData(JSON.stringify(broken)),
      /extension\.module/,
      `module=${JSON.stringify(module)} must be rejected`,
    )
  }
})

test('extension.config must be a plain object when present (arrays/scalars/strings throw)', () => {
  for (const config of [[1, 2], 42, 'ops', true]) {
    const broken = { levels: [{ ...LEVEL_WITH_EXTENSION, extension: { module: 'ok-mod', config } }] }
    assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /extension\.config/)
  }
})

test('extension itself must be an object, not a bare string', () => {
  const broken = { levels: [{ ...LEVEL_WITH_EXTENSION, extension: 'opportunity-window' }] }
  assert.throws(() => parseAndValidateGameData(JSON.stringify(broken)), /extension/)
})

test('a level without the extension key is unchanged — the hook is strictly optional', () => {
  const parsed = parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION] }))
  assert.equal(parsed.levels[0].extension, undefined)
})

// ───────────────────────────────────────────────────────────────────────
// persistValues — the data-declared "survives restarts" registry keys
// (GameScene gives them highScore's has-once init; harness's readValues
// reports them — that pair is what makes value_persists able to see a
// project's own persistent value at all).
// ───────────────────────────────────────────────────────────────────────

test('a well-formed persistValues declaration validates and round-trips', () => {
  const parsed = parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: ['jar', 'chapterProgress'] }))
  assert.deepEqual(parsed.persistValues, ['jar', 'chapterProgress'])
})

test('persistValues rejects non-arrays and non-identifier entries', () => {
  for (const broken of ['jar', 42, { jar: true }]) {
    assert.throws(
      () => parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: broken })),
      /persistValues/,
    )
  }
  for (const name of ['1jar', 'my-jar', 'my jar', '', '罐']) {
    assert.throws(
      () => parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: [name] })),
      /persistValues\[0\]/,
      `name=${JSON.stringify(name)} must be rejected`,
    )
  }
})

test('persistValues rejects the reserved names score and highScore, and duplicates', () => {
  // score is re-zeroed every create() and highScore belongs to the reference
  // scene — declaring either would promise a persistence it does not have.
  for (const name of ['score', 'highScore']) {
    assert.throws(
      () => parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: [name] })),
      new RegExp(`"${name}" 是模板保留名`),
    )
  }
  assert.throws(
    () => parseAndValidateGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: ['jar', 'jar'] })),
    /重复声明/,
  )
})

test('getPersistValueNames: declared names after init, [] before init and when absent', () => {
  // Lenient by contract — the harness reads this on Boot/Preload where the
  // manifest may not be initialized yet; absence must read as [], not throw.
  assert.deepEqual(getPersistValueNames(), [])
  initGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION] }))
  assert.deepEqual(getPersistValueNames(), [])
  __resetGameDataForTests()
  initGameData(JSON.stringify({ levels: [LEVEL_WITH_EXTENSION], persistValues: ['jar'] }))
  assert.deepEqual(getPersistValueNames(), ['jar'])
})
