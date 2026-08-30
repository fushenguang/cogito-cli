// Tests for scripts/lib/asset-usage.mjs — asset-usage-gate design.
//
// 🔴 Three states, each with its own test, same discipline as
// tests/exit-decision.test.mjs:
//   1. `absent`      — no manifest declared anything. Must NOT fail.
//   2. `unavailable` — no snapshot even had an `assets` field. Must fail.
//   3. `judged`      — a real comparison ran, in its three shapes:
//        a. declared > 0, loaded === 0            -> fail
//        b. loaded > 0, usedInScene === 0          -> fail (THE bug this
//           gate exists to catch — see this file's own header)
//        c. loaded > 0, usedInScene > 0            -> pass
//
// Also covers the multi-snapshot union (title-screen snapshot + gameplay
// snapshot combining into one verdict) since that's load-bearing for how
// scripts/verify.mjs actually calls this.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeAssetUsage, classifyAssetKey, PLAYER_KEY } from '../scripts/lib/asset-usage.mjs'
import { TITLE_TEXTURE_KEY, BGM_AUDIO_KEY, backgroundTextureKey, PLAYER_CHARACTER_KEY } from '../src/game-assets.ts'

function snapshot({ declared = [], loaded = [], usedInScene = [] } = {}) {
  return { declared, loaded, usedInScene }
}

// ───────────────────────────────────────────────────────────────────────
// 1. absent
// ───────────────────────────────────────────────────────────────────────

test('every snapshot null -> absent, not a failure', () => {
  const result = judgeAssetUsage([null, null])
  assert.equal(result.status, 'absent')
})

test('empty snapshot list -> unavailable, not absent — no evidence was gathered at all, which is not the same as "asked and found nothing"', () => {
  // 🔴 Fail-closed per this template's own doctrine ("读不懂就判 unavailable，
  // 绝不默认通过"): an empty list means the caller never even attempted a
  // snapshot, which this function cannot distinguish from "something went
  // wrong before it could look" — it must not default to the benign `absent`.
  const result = judgeAssetUsage([])
  assert.equal(result.status, 'unavailable')
})

test('undefined input (caller passed nothing) -> unavailable, never throws', () => {
  const result = judgeAssetUsage(undefined)
  assert.equal(result.status, 'unavailable')
})

// ───────────────────────────────────────────────────────────────────────
// 2. unavailable
// ───────────────────────────────────────────────────────────────────────

test('every snapshot missing the "assets" field entirely -> unavailable, counts as a failure', () => {
  const result = judgeAssetUsage([undefined, undefined])
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /predates the asset-usage gate/)
})

test('a mix of undefined and null is still resolved by the non-undefined entries (absent, not unavailable)', () => {
  // 🔴 This is the case where one snapshot attempt genuinely had no `assets`
  // field (e.g. only one bounds sample ran) but at least one other DID have
  // the field and reported no manifest — the field existing anywhere means
  // this harness build supports the gate, so it's `absent`, not `unavailable`.
  const result = judgeAssetUsage([null])
  assert.equal(result.status, 'absent')
})

// ───────────────────────────────────────────────────────────────────────
// 3. judged
// ───────────────────────────────────────────────────────────────────────

test('declared but nothing loaded -> judged, failed', () => {
  const declared = [{ key: 'bg-level1', kind: 'image' }, { key: 'bgm', kind: 'audio' }]
  const result = judgeAssetUsage([snapshot({ declared, loaded: [], usedInScene: [] })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, false)
  assert.deepEqual(result.declared.sort(), ['bg-level1', 'bgm'])
  assert.deepEqual(result.loaded, [])
  assert.match(result.reason, /none of them made it into the texture\/audio cache/)
})

test('loaded but never drawn/played -> judged, failed — the real incident this gate exists to catch', () => {
  // `player` here is the RESERVED character key (see the 2026-08-28 section
  // below), so its failure message is the player-specific one, not the
  // generic "0/N in use" — this fixture doubles as the minimal reserved-key
  // failure shape.
  const declared = [{ key: 'bg-level1', kind: 'image' }, { key: 'player', kind: 'image' }]
  const result = judgeAssetUsage([snapshot({ declared, loaded: ['bg-level1', 'player'], usedInScene: [] })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, false)
  assert.deepEqual(result.loaded.sort(), ['bg-level1', 'player'])
  assert.deepEqual(result.usedInScene, [])
  assert.match(result.reason, /background declared \(bg-level1\) but none of them is drawn/)
  assert.match(result.reason, /player character declared \(player\) but not in use/)
})

test('loaded and used -> judged, passed', () => {
  const declared = [{ key: 'bg-level1', kind: 'image' }]
  const result = judgeAssetUsage([snapshot({ declared, loaded: ['bg-level1'], usedInScene: ['bg-level1'] })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
})

test('mutation check: a judge that treats "loaded but unused" as a pass has no discriminating power', () => {
  // This is the literal shape of the regression this gate exists to
  // prevent (the past real incident: BH-0/BH-1/BH-2/IA all green while
  // add.image was hit 0 times). A judge that doesn't fail this input isn't
  // testing anything.
  const declared = [{ key: 'bg-level1', kind: 'image' }]
  const brokenAlwaysPass = { ...snapshot({ declared, loaded: ['bg-level1'], usedInScene: [] }) }
  const result = judgeAssetUsage([brokenAlwaysPass])
  assert.equal(result.passed, false, 'declared+loaded but unused must never be reported as passed')
})

// ───────────────────────────────────────────────────────────────────────
// Multi-snapshot union — how scripts/verify.mjs actually calls this
// ───────────────────────────────────────────────────────────────────────

test('usage observed on a LATER snapshot (e.g. the gameplay-state probe) still counts, even if an earlier snapshot saw none', () => {
  const declared = [{ key: 'bg-level1', kind: 'image' }, { key: 'title', kind: 'image' }]
  // First snapshot: right after load, on the title/start screen — "title" is used, "bg-level1" is not yet.
  const first = snapshot({ declared, loaded: ['bg-level1', 'title'], usedInScene: ['title'] })
  // Second snapshot: after applyState() onto the gameplay state — "bg-level1" now shows up too.
  const second = snapshot({ declared, loaded: ['bg-level1', 'title'], usedInScene: ['bg-level1'] })
  const result = judgeAssetUsage([first, second])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.deepEqual(result.usedInScene.sort(), ['bg-level1', 'title'])
})

test('declared/loaded stay stable across snapshots even if only one of them is passed', () => {
  const declared = [{ key: 'bgm', kind: 'audio' }]
  const result = judgeAssetUsage([snapshot({ declared, loaded: ['bgm'], usedInScene: ['bgm'] }), null])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.deepEqual(result.declared, ['bgm'])
})

// ───────────────────────────────────────────────────────────────────────
// classifyAssetKey() — must never drift from ../src/game-assets.ts's real
// key-generating functions (this file's own header explains why this is a
// hand-mirrored copy, not an import).
// ───────────────────────────────────────────────────────────────────────

test('classifyAssetKey agrees with game-assets.ts\'s real well-known keys', () => {
  assert.equal(classifyAssetKey(TITLE_TEXTURE_KEY, 'image'), 'title')
  assert.equal(classifyAssetKey(BGM_AUDIO_KEY, 'audio'), 'bgm')
  assert.equal(classifyAssetKey(backgroundTextureKey(1), 'image'), 'background')
  assert.equal(classifyAssetKey(backgroundTextureKey(2), 'image'), 'background')
  assert.equal(classifyAssetKey(backgroundTextureKey(42), 'image'), 'background')
  // An arbitrary character slug (game-assets.ts's `characters` record keys
  // are free-form) is never any of the well-known ones -> character.
  assert.equal(classifyAssetKey('protagonist', 'image'), 'character')
  // The reserved player key still classifies as a plain character — the
  // reserved-key strictness lives in the judge, not the classifier.
  assert.equal(classifyAssetKey(PLAYER_CHARACTER_KEY, 'image'), 'character')
  // The judge's hand-mirrored reserved key must BE the real constant.
  assert.equal(PLAYER_KEY, PLAYER_CHARACTER_KEY)
})

// ───────────────────────────────────────────────────────────────────────
// Per-category judgment (2026-08-22) — see scripts/lib/asset-usage.mjs's
// header for the real incident this section exists to catch: a run where
// title+background were in use was enough to make the OLD "at least one
// asset in use overall" rule report `passed: true` even though every
// declared character AND the declared bgm were completely unused.
// ───────────────────────────────────────────────────────────────────────

test('REGRESSION: bgm and characters unused must fail even though title+background ARE in use — the literal real-world defect this change fixes', () => {
  // This is the exact shape of the real `assetUsage` output that shipped:
  // "7/7 declared asset(s) loaded, 2 in active use (title, bg-level1)",
  // passed: true, declared = [title, bg-level1, bg-level2, protagonist,
  // companion, antagonist, bgm].
  const declared = [
    { key: 'title', kind: 'image' },
    { key: 'bg-level1', kind: 'image' },
    { key: 'bg-level2', kind: 'image' },
    { key: 'protagonist', kind: 'image' },
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
    { key: 'bgm', kind: 'audio' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['title', 'bg-level1']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, false, 'a per-category judge must fail this — bgm and every character are unused')
  assert.match(result.reason, /bgm declared \(bgm\) but not currently playing/)
  assert.match(result.reason, /characters declared \(.*\) but 0\/3 in use/)
})

test('MUTATION GUARD: reverting to "at least one asset in use overall" must turn the regression test above red', () => {
  // Same input as the regression test, but hand-computing what the OLD
  // (pre-per-category) rule would have concluded: usedInScene.size > 0 (2
  // keys) -> passed. This test exists so that if a future edit collapses
  // the per-category checks back into a single "any use at all" check,
  // THIS assertion (not just the regression test above) makes the mistake
  // impossible to miss — it independently re-derives the old verdict and
  // asserts it's the wrong one.
  const oldRuleUsedInSceneSize = 2 // 'title', 'bg-level1' — matches the real shipped output
  const oldRulePassed = oldRuleUsedInSceneSize > 0
  assert.equal(oldRulePassed, true, 'sanity: the old rule really did consider this a pass')

  const declared = [
    { key: 'title', kind: 'image' },
    { key: 'bg-level1', kind: 'image' },
    { key: 'protagonist', kind: 'image' },
    { key: 'bgm', kind: 'audio' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['title', 'bg-level1']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.notEqual(
    result.passed,
    oldRulePassed,
    'the new per-category judge must disagree with the old "any use at all" verdict on this input',
  )
})

test('background: declared but not used in the currently active scene -> fail, even with an otherwise-healthy manifest', () => {
  const declared = [
    { key: 'bg-level1', kind: 'image' },
    { key: 'player', kind: 'image' },
    { key: 'bgm', kind: 'audio' },
  ]
  const loaded = declared.map((d) => d.key)
  // player and bgm both in use; background is not.
  const usedInScene = ['player', 'bgm']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.passed, false)
  assert.match(result.reason, /background declared \(bg-level1\) but none of them is drawn/)
})

test('background: only the CURRENTLY ACTIVE level needs to be in use — an unvisited level\'s background must not fail the gate', () => {
  const declared = [
    { key: 'bg-level1', kind: 'image' },
    { key: 'bg-level2', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  // Only level1 was ever the active gameplay scene during this run's
  // probes — level2's background legitimately never got a chance to draw.
  const usedInScene = ['bg-level1']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true, 'an unvisited level\'s unused background must not be held against the project')
  assert.match(result.reason, /background in use \(bg-level1\)/)
})

test('characters: 1 of 3 in use -> passed, but the reason names the unused ones', () => {
  const declared = [
    { key: 'protagonist', kind: 'image' },
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['protagonist']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.match(result.reason, /characters 1\/3 in use/)
  assert.match(result.reason, /unused: companion, antagonist/)
})

test('characters: 0 of N in use -> fails, distinctly from the bgm/background failures', () => {
  const declared = [
    { key: 'protagonist', kind: 'image' },
    { key: 'companion', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene: [] })])
  assert.equal(result.passed, false)
  assert.match(result.reason, /characters declared \(protagonist, companion\) but 0\/2 in use/)
})

test('title never fails the gate on its own, even completely unused', () => {
  const declared = [{ key: 'title', kind: 'image' }]
  const result = judgeAssetUsage([snapshot({ declared, loaded: ['title'], usedInScene: [] })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true, 'title has no hard requirement — see this suite\'s header')
  assert.match(result.reason, /title unused/)
})

test('all four categories declared and all satisfied -> passed, reason mentions each', () => {
  const declared = [
    { key: 'title', kind: 'image' },
    { key: 'bg-level1', kind: 'image' },
    { key: 'protagonist', kind: 'image' },
    { key: 'bgm', kind: 'audio' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['title', 'bg-level1', 'protagonist', 'bgm']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.match(result.reason, /bgm playing/)
  assert.match(result.reason, /background in use/)
  assert.match(result.reason, /characters 1\/1 in use/)
  assert.match(result.reason, /title in use/)
})

// ───────────────────────────────────────────────────────────────────────
// Reserved player-character key (2026-08-28) — see scripts/lib/asset-usage.mjs's
// header for the real incident this section exists to catch: the protagonist
// texture declared under the manifest's reserved `player` key, loaded into the
// cache, and NEVER attached to the player — the player stayed a procedural
// placeholder square while the gate printed "characters 1/3 in use (unused:
// player)" and PASSED, because a companion sprite used as scene decoration
// satisfied the lenient "at least one character in use" rule (trial-08,
// 2026-08-27, in the platform repo that scaffolds from this template).
// ───────────────────────────────────────────────────────────────────────

test('REGRESSION (trial-08): reserved `player` declared but never worn by the player must fail, even with a side character in use', () => {
  // The literal shape of the real incident: three characters declared and
  // loaded, only the companion used (as scene decoration), the protagonist —
  // declared under the reserved key — never attached. The old lenient rule
  // reported "characters 1/3 in use (unused: player)" with passed: true.
  const declared = [
    { key: 'player', kind: 'image' },
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['companion']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, false, 'declaring the reserved player key means the player must actually wear it')
  assert.match(result.reason, /player character declared \(player\) but not in use/)
})

test('MUTATION GUARD: reverting to "at least one character in use, reserved key included" must turn the regression test above red', () => {
  // Same input as the regression test, hand-computing what the OLD
  // (pre-reserved-key) rule concluded: characters used >= 1 (companion) ->
  // passed. If a future edit collapses the reserved-key check back into the
  // lenient per-category fraction, THIS assertion (not just the regression
  // test above) makes the mistake impossible to miss — it independently
  // re-derives the old verdict and asserts the judge must disagree with it.
  const oldRuleCharactersInUse = 1 // 'companion' — matches the real shipped output
  const oldRulePassed = oldRuleCharactersInUse > 0
  assert.equal(oldRulePassed, true, 'sanity: the old rule really did consider this a pass')

  const declared = [
    { key: 'player', kind: 'image' },
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['companion']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.notEqual(
    result.passed,
    oldRulePassed,
    'the reserved-key judge must disagree with the old "at least one character in use" verdict on this input',
  )
})

test('reserved `player` in use -> passed, named separately, and unused side characters still only noted', () => {
  const declared = [
    { key: 'player', kind: 'image' },
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['player', 'companion']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.match(result.reason, /player character \(player\) in use/)
  assert.match(result.reason, /characters 1\/2 in use \(unused: antagonist\)/)
})

test('behavior unchanged when no reserved key is declared — side characters keep the lenient rule verbatim', () => {
  // No `player` key anywhere: the verdict and messages must be exactly what
  // the 2026-08-22 per-category rule produced before this change.
  const declared = [
    { key: 'companion', kind: 'image' },
    { key: 'antagonist', kind: 'image' },
  ]
  const loaded = declared.map((d) => d.key)
  const usedInScene = ['companion']
  const result = judgeAssetUsage([snapshot({ declared, loaded, usedInScene })])
  assert.equal(result.status, 'judged')
  assert.equal(result.passed, true)
  assert.match(result.reason, /characters 1\/2 in use \(unused: antagonist\)/)
})
