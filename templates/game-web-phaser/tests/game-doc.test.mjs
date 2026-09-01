// Contract tests for game-doc.json's validation/normalization (see
// src/game-doc.ts). Pure, bare-Node — the module has no imports at all,
// same leaf-module discipline as src/dimensions.ts.
//
// The `normalizeGameDoc(undefined) -> null` case below is the actual,
// literal proof for AGENTS.md's judged requirement #5 ("game-doc.json 不存在
// 时入口不显示"): `undefined` is exactly what `this.cache.json.get('gameDoc')`
// returns in src/scenes/UiScene.ts's mountDocEntry() when Phaser's loader
// never added the key — which is exactly what happens when
// public/game-doc.json is missing (see PreloadScene.ts's preload() doc:
// a 404 there is a per-file loaderror, not a thrown exception, and the
// failed key is simply absent from the cache). mountDocEntry() gates the
// entire button on `normalizeGameDoc(raw)` being non-null, so this single
// pure-function fact is the whole "file missing -> no entry" behaviour,
// checkable without a browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeGameDoc, resolveLevelDoc, resolveScreens, resolveTheme, DEFAULT_SCREENS } from '../src/game-doc.ts'

const VALID_DOC = {
  title: '测试游戏',
  background: '这是背景故事。',
  controls: ['方向键：移动', '空格键：开火'],
  overallGoal: '尽量拿高分。',
  levels: {
    Game: { name: '第一关', goal: '收集星尘碎片。' },
  },
  notDoing: ['没有第二关'],
}

test('a fully valid game-doc.json normalizes to a non-null GameDoc with the same content', () => {
  const doc = normalizeGameDoc(VALID_DOC)
  assert.notEqual(doc, null)
  assert.equal(doc.title, VALID_DOC.title)
  assert.deepEqual(doc.controls, VALID_DOC.controls)
  assert.deepEqual(doc.notDoing, VALID_DOC.notDoing)
  assert.deepEqual(doc.levels.Game, VALID_DOC.levels.Game)
})

test('undefined (the "file was never loaded" shape from Phaser\'s cache.json.get()) normalizes to null — gates the doc-entry button off', () => {
  assert.equal(normalizeGameDoc(undefined), null)
})

test('null, a bare string, and an array all normalize to null (not an object shape at all)', () => {
  assert.equal(normalizeGameDoc(null), null)
  assert.equal(normalizeGameDoc('not an object'), null)
  assert.equal(normalizeGameDoc([1, 2, 3]), null)
})

test('missing required fields each independently invalidate the whole doc', () => {
  const requiredKeys = ['title', 'background', 'controls', 'overallGoal', 'levels', 'notDoing']
  for (const key of requiredKeys) {
    const broken = { ...VALID_DOC }
    delete broken[key]
    assert.equal(
      normalizeGameDoc(broken),
      null,
      `expected normalizeGameDoc() to reject a doc missing "${key}", but it accepted it`,
    )
  }
})

test('empty-string title/background/overallGoal are rejected (whitespace-only is not real content)', () => {
  assert.equal(normalizeGameDoc({ ...VALID_DOC, title: '' }), null)
  assert.equal(normalizeGameDoc({ ...VALID_DOC, title: '   ' }), null)
  assert.equal(normalizeGameDoc({ ...VALID_DOC, background: '' }), null)
  assert.equal(normalizeGameDoc({ ...VALID_DOC, overallGoal: '' }), null)
})

test('empty controls/notDoing arrays are rejected — a copy-paste placeholder must not silently pass', () => {
  assert.equal(normalizeGameDoc({ ...VALID_DOC, controls: [] }), null)
  assert.equal(normalizeGameDoc({ ...VALID_DOC, notDoing: [] }), null)
})

test('a non-string entry inside controls/notDoing invalidates the doc', () => {
  assert.equal(normalizeGameDoc({ ...VALID_DOC, controls: ['ok', 42] }), null)
  assert.equal(normalizeGameDoc({ ...VALID_DOC, notDoing: [null] }), null)
})

test('a level entry missing "name" or "goal" invalidates the whole doc', () => {
  assert.equal(
    normalizeGameDoc({ ...VALID_DOC, levels: { Game: { name: '第一关' } } }),
    null,
  )
  assert.equal(
    normalizeGameDoc({ ...VALID_DOC, levels: { Game: { goal: '收集星尘碎片。' } } }),
    null,
  )
})

test('levels may be an empty object — a doc with no per-level content yet is still otherwise valid', () => {
  const doc = normalizeGameDoc({ ...VALID_DOC, levels: {} })
  assert.notEqual(doc, null)
  assert.deepEqual(doc.levels, {})
})

test('resolveLevelDoc() returns the matching level entry when present', () => {
  const doc = normalizeGameDoc(VALID_DOC)
  const level = resolveLevelDoc(doc, 'Game')
  assert.deepEqual(level, VALID_DOC.levels.Game)
})

test('resolveLevelDoc() falls back to a generic entry for an unknown scene key instead of throwing/undefined', () => {
  const doc = normalizeGameDoc(VALID_DOC)
  const level = resolveLevelDoc(doc, 'SomeOtherLevel')
  assert.equal(level.name, 'SomeOtherLevel')
  assert.equal(typeof level.goal, 'string')
  assert.ok(level.goal.length > 0)
})

// ───────────────────────────────────────────────────────────────────────
// Fixed-screen copy + theme (issue #11): the Start/GameOver pages must be
// renderable COMPLETE even with no doc at all — that is the whole "the
// auxiliary pages didn't exist yet" fix. resolveScreens/resolveTheme are the
// machinery; these tests pin its fallback semantics.
// ───────────────────────────────────────────────────────────────────────

test('resolveScreens(null) still yields every default string — the pages render with no game-doc.json at all', () => {
  const screens = resolveScreens(null)
  // Every field filled, none empty — except startTitle which falls through to
  // the generic '开始' fallback when there is no title to inherit.
  for (const [key, value] of Object.entries(screens)) {
    assert.equal(typeof value, 'string', `${key} must be a string`)
    assert.ok(value.length > 0, `${key} must be non-empty`)
  }
})

test('resolveScreens: startTitle falls back to the doc title, then to the generic fallback', () => {
  const doc = normalizeGameDoc(VALID_DOC)
  assert.equal(resolveScreens(doc).startTitle, VALID_DOC.title, 'doc title wins')
  const screensOverride = normalizeGameDoc({
    ...VALID_DOC,
    screens: { startTitle: '自定义标题' },
  })
  assert.equal(resolveScreens(screensOverride).startTitle, '自定义标题', 'an explicit override wins over the doc title')
})

test('resolveScreens merges per-field overrides onto the defaults, leaving the rest untouched', () => {
  const doc = normalizeGameDoc({
    ...VALID_DOC,
    screens: { winTitle: '通关！', retryButton: '再来' },
  })
  const screens = resolveScreens(doc)
  assert.equal(screens.winTitle, '通关！')
  assert.equal(screens.retryButton, '再来')
  assert.equal(screens.startButton, DEFAULT_SCREENS.startButton, 'un-overridden fields keep defaults')
  assert.equal(screens.loseTitle, DEFAULT_SCREENS.loseTitle)
})

test('a screens section with an invalid field type degrades to defaults for the WHOLE section, not a half-page', () => {
  const doc = normalizeGameDoc({ ...VALID_DOC, screens: { winTitle: 42 } })
  // readScreens rejects the whole section ({}), so resolveScreens falls back
  // to pure defaults — a broken override can never produce a page with some
  // strings from the doc and some from nowhere.
  const screens = resolveScreens(doc)
  assert.equal(screens.winTitle, DEFAULT_SCREENS.winTitle)
})

test('an invalid theme colour degrades the whole theme to defaults', () => {
  const doc = normalizeGameDoc({
    ...VALID_DOC,
    theme: { heading: 'not-a-hex', accent: '#4f8cff' },
  })
  const theme = resolveTheme(doc)
  assert.equal(theme.heading, resolveTheme(null).heading, 'bad hex loses the whole section')
  assert.equal(theme.accent, resolveTheme(null).accent, 'even the valid field falls back with its section')
})

test('a valid single-colour theme override merges per-colour', () => {
  const doc = normalizeGameDoc({ ...VALID_DOC, theme: { accent: '#ff8800' } })
  const theme = resolveTheme(doc)
  assert.equal(theme.accent, '#ff8800')
  assert.equal(theme.backdrop, resolveTheme(null).backdrop)
  assert.equal(theme.heading, resolveTheme(null).heading)
})
