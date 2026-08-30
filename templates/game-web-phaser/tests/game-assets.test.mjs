// Contract tests for game-assets.json's validation/normalization and load
// planning (see src/game-assets.ts). Pure, bare-Node — same leaf-module
// discipline as src/dimensions.ts / src/game-doc.ts.
//
// Three things this file exists to prove, matching AGENTS.md's brief for
// this change:
//   1. Manifest parsing — a valid manifest normalizes with its content intact.
//   2. Missing-manifest degrade — `normalizeGameAssets(undefined)` is `null`,
//      and `planAssetLoads(null)` queues literally nothing (never a guessed
//      request for title.png/bg/bgm/char files it has no manifest evidence
//      for).
//   3. "level<N>" keys correspond to the level ordinal the directory
//      contract (`public/assets/bg/level<N>.png`) requires.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeGameAssets,
  planAssetLoads,
  parseBackgroundLevelKey,
  backgroundTextureKey,
  safeParseJson,
  applyLevelBackground,
  TITLE_TEXTURE_KEY,
  BGM_AUDIO_KEY,
} from '../src/game-assets.ts'

const VALID_MANIFEST = {
  title: { path: 'assets/title.png', description: '开始页主视觉' },
  backgrounds: {
    level1: { path: 'assets/bg/level1.png', description: '第一关背景' },
    level2: { path: 'assets/bg/level2.png', description: '第二关背景' },
  },
  characters: {
    player: { path: 'assets/char/player.png', description: '主角，已去背透明 PNG' },
    guard: { path: 'assets/char/guard.png', description: '第二关的守卫敌人', level: 2 },
  },
  bgm: { path: 'assets/bgm/main.mp3', description: '循环播放的背景音乐' },
}

// ───────────────────────────────────────────────────────────────────────
// 1. Manifest parsing
// ───────────────────────────────────────────────────────────────────────

test('a fully valid manifest normalizes with its content intact', () => {
  const assets = normalizeGameAssets(VALID_MANIFEST)
  assert.notEqual(assets, null)
  assert.deepEqual(assets.title, VALID_MANIFEST.title)
  assert.deepEqual(assets.bgm, VALID_MANIFEST.bgm)
  assert.deepEqual(assets.backgrounds.level1, VALID_MANIFEST.backgrounds.level1)
  assert.deepEqual(assets.backgrounds.level2, VALID_MANIFEST.backgrounds.level2)
  assert.deepEqual(assets.characters.player, VALID_MANIFEST.characters.player)
  assert.deepEqual(assets.characters.guard, VALID_MANIFEST.characters.guard)
})

test('a manifest with only one field populated is still valid (fields are independent)', () => {
  const assets = normalizeGameAssets({ bgm: VALID_MANIFEST.bgm })
  assert.notEqual(assets, null)
  assert.equal(assets.title, undefined)
  assert.deepEqual(assets.backgrounds, {})
  assert.deepEqual(assets.characters, {})
  assert.deepEqual(assets.bgm, VALID_MANIFEST.bgm)
})

test('a malformed title entry is dropped without invalidating an otherwise-valid manifest', () => {
  const assets = normalizeGameAssets({ ...VALID_MANIFEST, title: { path: '' /* empty */, description: 'x' } })
  assert.notEqual(assets, null)
  assert.equal(assets.title, undefined)
  assert.deepEqual(assets.bgm, VALID_MANIFEST.bgm) // the rest survives
})

test('a character missing a description is dropped, other characters survive', () => {
  const assets = normalizeGameAssets({
    ...VALID_MANIFEST,
    characters: { ...VALID_MANIFEST.characters, broken: { path: 'assets/char/broken.png' } },
  })
  assert.notEqual(assets, null)
  assert.equal(assets.characters.broken, undefined)
  assert.deepEqual(assets.characters.player, VALID_MANIFEST.characters.player)
})

test('a character with a non-integer or non-positive level is dropped', () => {
  const assets = normalizeGameAssets({
    characters: {
      bad1: { path: 'a.png', description: 'd', level: 0 },
      bad2: { path: 'a.png', description: 'd', level: 1.5 },
      bad3: { path: 'a.png', description: 'd', level: -1 },
      good: { path: 'a.png', description: 'd', level: 3 },
    },
  })
  assert.notEqual(assets, null)
  assert.equal(assets.characters.bad1, undefined)
  assert.equal(assets.characters.bad2, undefined)
  assert.equal(assets.characters.bad3, undefined)
  assert.deepEqual(assets.characters.good, { path: 'a.png', description: 'd', level: 3 })
})

test('a character with no level field at all is valid (level-agnostic character)', () => {
  const assets = normalizeGameAssets({ characters: { hero: { path: 'a.png', description: 'd' } } })
  assert.deepEqual(assets.characters.hero, { path: 'a.png', description: 'd' })
})

// ───────────────────────────────────────────────────────────────────────
// safeParseJson — the guard that keeps a malformed-but-200 manifest from
// throwing (PreloadScene loads this file as text + this function, never
// Phaser's own this.load.json(), specifically to avoid this).
// ───────────────────────────────────────────────────────────────────────

test('safeParseJson() parses valid JSON text', () => {
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 })
  assert.deepEqual(safeParseJson('[1,2,3]'), [1, 2, 3])
})

test('safeParseJson() returns undefined for undefined input (file never loaded), never throws', () => {
  assert.equal(safeParseJson(undefined), undefined)
})

test('safeParseJson() returns undefined for malformed JSON text, never throws', () => {
  assert.equal(safeParseJson('not valid json {{{'), undefined)
  assert.equal(safeParseJson(''), undefined)
  assert.equal(safeParseJson('{"unterminated": '), undefined)
})

test('safeParseJson(malformed) chained into normalizeGameAssets() degrades to null, same as a missing file', () => {
  assert.equal(normalizeGameAssets(safeParseJson('not valid json {{{')), null)
  assert.equal(normalizeGameAssets(safeParseJson(undefined)), null)
})

// ───────────────────────────────────────────────────────────────────────
// 2. Missing-manifest degrade
// ───────────────────────────────────────────────────────────────────────

test('undefined (the "file was never loaded" shape from Phaser\'s cache.json.get()) normalizes to null', () => {
  assert.equal(normalizeGameAssets(undefined), null)
})

test('null, a bare string, and an array all normalize to null (not an object shape at all)', () => {
  assert.equal(normalizeGameAssets(null), null)
  assert.equal(normalizeGameAssets('not an object'), null)
  assert.equal(normalizeGameAssets([1, 2, 3]), null)
})

test('an object with nothing valid inside it normalizes to null — indistinguishable from "no manifest"', () => {
  assert.equal(normalizeGameAssets({}), null)
  assert.equal(normalizeGameAssets({ title: { path: '' }, backgrounds: 'nope', characters: 42 }), null)
})

test('planAssetLoads(null) queues nothing — the literal proof "missing manifest never guesses a request"', () => {
  assert.deepEqual(planAssetLoads(null), [])
})

test('planAssetLoads() of a fully valid manifest queues exactly the described files, with well-known keys', () => {
  const assets = normalizeGameAssets(VALID_MANIFEST)
  const tasks = planAssetLoads(assets)

  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]))
  assert.equal(tasks.length, 6) // title + 2 backgrounds + 2 characters + bgm
  assert.deepEqual(byKey[TITLE_TEXTURE_KEY], { key: TITLE_TEXTURE_KEY, path: 'assets/title.png', kind: 'image' })
  assert.deepEqual(byKey[backgroundTextureKey(1)], {
    key: backgroundTextureKey(1),
    path: 'assets/bg/level1.png',
    kind: 'image',
  })
  assert.deepEqual(byKey[backgroundTextureKey(2)], {
    key: backgroundTextureKey(2),
    path: 'assets/bg/level2.png',
    kind: 'image',
  })
  assert.deepEqual(byKey.player, { key: 'player', path: 'assets/char/player.png', kind: 'image' })
  assert.deepEqual(byKey.guard, { key: 'guard', path: 'assets/char/guard.png', kind: 'image' })
  assert.deepEqual(byKey[BGM_AUDIO_KEY], { key: BGM_AUDIO_KEY, path: 'assets/bgm/main.mp3', kind: 'audio' })
})

// 🔴 Mutation check (AGENTS.md's brief for this change: "把'清单缺失时退化'
// 改成'直接 load' ⇒ 必须有测试变红"). This is the permanent, in-suite half
// of that verification. The one-off manual half — temporarily changing
// `planAssetLoads()`'s `if (!assets) return []` guard to instead return a
// hardcoded task unconditionally, re-running `pnpm test`, watching this
// exact test go red, then reverting — was performed for this change; see
// the PR description for that run's output.
test('mutation check: a load-plan that queues something even with no manifest has no discriminating power', () => {
  // Simulates the exact regression the guard above exists to prevent —
  // constructed by hand, not by actually mutating the source, so this test
  // keeps passing/failing on the real function's real behaviour.
  const brokenPlanWithNoGuard = (assets) => [
    { key: TITLE_TEXTURE_KEY, path: 'assets/title.png', kind: 'image' },
    ...planAssetLoads(assets),
  ]

  assert.notDeepEqual(
    brokenPlanWithNoGuard(null),
    [],
    'sanity: the deliberately-broken plan above does request something for a null manifest',
  )
  // ...and the real function must NOT do that — this is the assertion that
  // actually has teeth.
  assert.deepEqual(
    planAssetLoads(null),
    [],
    'planAssetLoads(null) queued a request with no manifest evidence to justify it',
  )
})

// ───────────────────────────────────────────────────────────────────────
// 3. "level<N>" keys correspond to the level ordinal
// ───────────────────────────────────────────────────────────────────────

test('parseBackgroundLevelKey() accepts "level<N>" for N >= 1 and extracts N', () => {
  assert.equal(parseBackgroundLevelKey('level1'), 1)
  assert.equal(parseBackgroundLevelKey('level2'), 2)
  assert.equal(parseBackgroundLevelKey('level42'), 42)
})

test('parseBackgroundLevelKey() rejects anything that is not exactly "level<positive integer>"', () => {
  assert.equal(parseBackgroundLevelKey('level0'), null)
  assert.equal(parseBackgroundLevelKey('level01'), null) // leading zero — ambiguous, reject
  assert.equal(parseBackgroundLevelKey('level-1'), null)
  assert.equal(parseBackgroundLevelKey('levelX'), null)
  assert.equal(parseBackgroundLevelKey('Level1'), null) // case-sensitive, matches the directory contract literally
  assert.equal(parseBackgroundLevelKey('bg1'), null)
  assert.equal(parseBackgroundLevelKey('level'), null)
  assert.equal(parseBackgroundLevelKey(''), null)
})

test('backgroundTextureKey() round-trips with parseBackgroundLevelKey() for every level it produces a key for', () => {
  for (const level of [1, 2, 3, 10]) {
    const key = backgroundTextureKey(level)
    // The texture key itself is a *different* string namespace from the
    // manifest's "level<N>" key (see game-assets.ts's header doc on why
    // PreloadScene needs both) — round-trip via the manifest key shape
    // instead, which is what parseBackgroundLevelKey() actually parses.
    assert.equal(parseBackgroundLevelKey(`level${level}`), level)
    assert.equal(key, `bg-level${level}`)
  }
})

test('normalizeGameAssets() drops a backgrounds key that does not match "level<N>", keeping valid siblings', () => {
  const assets = normalizeGameAssets({
    backgrounds: {
      level1: { path: 'a.png', description: 'd' },
      background: { path: 'b.png', description: 'd' }, // wrong key shape
      level0: { path: 'c.png', description: 'd' }, // N must be >= 1
    },
  })
  assert.notEqual(assets, null)
  assert.deepEqual(Object.keys(assets.backgrounds), ['level1'])
})

test('planAssetLoads() derives each background texture key from its manifest key\'s level number', () => {
  const assets = normalizeGameAssets({
    backgrounds: {
      level3: { path: 'assets/bg/level3.png', description: 'd' },
    },
  })
  const tasks = planAssetLoads(assets)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].key, backgroundTextureKey(3))
  assert.equal(tasks[0].key, 'bg-level3')
})

// ───────────────────────────────────────────────────────────────────────
// applyLevelBackground() — the helper shared by GameScene.ts (and any
// Level<N>Scene a real project writes in its place, see
// ../skills/game-flow-and-hud/SKILL.md's "Writing a New Playable Scene?"
// section) so the "check the texture manager, draw it, pin it behind
// gameplay, no-op if missing" logic is not private to one scene class.
//
// Exercised here against a plain duck-typed mock (`BackgroundHostScene` in
// ../src/game-assets.ts), no Phaser/DOM/WebGL — same bare-Node discipline
// as every other test in this file.
// ───────────────────────────────────────────────────────────────────────

/** A minimal fake `Phaser.GameObjects.Image`-shaped chain that records calls. */
function makeFakeImage(calls) {
  const image = {
    setDisplaySize(width, height) {
      calls.setDisplaySize.push([width, height])
      return image
    },
    setDepth(depth) {
      calls.setDepth.push(depth)
      return image
    },
  }
  return image
}

function makeFakeScene({ hasTexture }) {
  const calls = { image: [], setDisplaySize: [], setDepth: [] }
  const scene = {
    textures: { exists: (key) => hasTexture(key) },
    add: {
      image(x, y, key) {
        calls.image.push([x, y, key])
        return makeFakeImage(calls)
      },
    },
  }
  return { scene, calls }
}

test('applyLevelBackground() is a no-op and returns false when the level texture is missing', () => {
  const { scene, calls } = makeFakeScene({ hasTexture: () => false })
  const drew = applyLevelBackground(scene, 1, 960, 476)
  assert.equal(drew, false)
  assert.deepEqual(calls.image, [])
  assert.deepEqual(calls.setDisplaySize, [])
  assert.deepEqual(calls.setDepth, [])
})

test('applyLevelBackground() draws the matching level texture, centered, sized, and depth-pinned, when it exists', () => {
  const { scene, calls } = makeFakeScene({ hasTexture: (key) => key === backgroundTextureKey(2) })
  const drew = applyLevelBackground(scene, 2, 960, 476)
  assert.equal(drew, true)
  assert.deepEqual(calls.image, [[480, 238, backgroundTextureKey(2)]])
  assert.deepEqual(calls.setDisplaySize, [[960, 476]])
  assert.deepEqual(calls.setDepth, [-1]) // behind gameplay regardless of add-order
})

test("applyLevelBackground() checks this level's own texture key, not just any background", () => {
  // Manifest has level1's background loaded, but this scene is level 2 —
  // must not draw level1's art under level2's key.
  const { scene, calls } = makeFakeScene({ hasTexture: (key) => key === backgroundTextureKey(1) })
  const drew = applyLevelBackground(scene, 2, 960, 476)
  assert.equal(drew, false)
  assert.deepEqual(calls.image, [])
})

// 🔴 Mutation check (AGENTS.md's brief for this change: flipping the
// degrade-to-shapes branch into an unconditional load must turn a test red).
test('mutation check: a background-apply that ignores the texture-exists guard has no discriminating power', () => {
  const brokenApplyWithNoGuard = (scene, level, width, height) => {
    scene.add.image(width / 2, height / 2, backgroundTextureKey(level))
    return true
  }

  const brokenRun = makeFakeScene({ hasTexture: () => false })
  brokenApplyWithNoGuard(brokenRun.scene, 3, 960, 476)
  assert.notDeepEqual(
    brokenRun.calls.image,
    [],
    'sanity: the deliberately-broken version does draw with no texture evidence',
  )

  const realRun = makeFakeScene({ hasTexture: () => false })
  applyLevelBackground(realRun.scene, 3, 960, 476)
  assert.deepEqual(
    realRun.calls.image,
    [],
    'applyLevelBackground() drew without texture evidence to justify it',
  )
})
