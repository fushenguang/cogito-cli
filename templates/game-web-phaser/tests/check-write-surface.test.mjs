// Tests for the write-surface gate's pure judgement (scripts/check-write-surface.mjs).
// The git-walking half is a thin shell over judgeWriteSurface(); the boundary
// itself — what an AI executor may and may not touch — is the part that must
// never rot silently, so it is pinned here exactly as AGENTS.md rule 10
// states it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeWriteSurface, parsePorcelainLine, WRITABLE_EXISTING, WRITABLE_NEW_PREFIXES } from '../scripts/check-write-surface.mjs'

test('the three data manifests, assertions.json and README are editable content slots', () => {
  for (const path of WRITABLE_EXISTING) {
    assert.deepEqual(judgeWriteSurface(path, { existedAtRoot: true }), { ok: true }, `${path} must be editable`)
  }
})

test('editing any template-owned source file is a violation, with a reason that points back at the data slots', () => {
  for (const path of [
    'src/scenes/GameScene.ts',
    'src/scenes/StartScene.ts',
    'src/screen-dom.ts',
    'src/debug/harness.ts',
    'scripts/selfcheck.mjs',
    'scripts/verify.mjs',
    'tests/game-data.test.mjs',
    'AGENTS.md',
    'package.json',
    'index.html',
  ]) {
    const judged = judgeWriteSurface(path, { existedAtRoot: true })
    assert.equal(judged.ok, false, `${path} must not be editable`)
    assert.match(judged.reason, /game-data\.json|AGENTS\.md rule 10/)
  }
})

test('new files are allowed exactly under the declared prefixes', () => {
  for (const path of [
    'public/assets/char/hero.png',
    'public/levels-extra.json',
    'src/extensions/PortalScene.ts',
    'docs/design-notes.md',
    'assets/sfx/jump.wav',
  ]) {
    assert.deepEqual(judgeWriteSurface(path, { existedAtRoot: false }), { ok: true }, `${path} must be creatable`)
  }
  assert.ok(WRITABLE_NEW_PREFIXES.includes('public/'))
  assert.ok(WRITABLE_NEW_PREFIXES.includes('src/extensions/'))
})

test('a new file outside every prefix is a violation (that is the whole gate)', () => {
  const judged = judgeWriteSurface('src/scenes/HackScene.ts', { existedAtRoot: false })
  assert.equal(judged.ok, false)
  assert.match(judged.reason, /outside the write surface/)
})

test('parsePorcelainLine: the leading status char is data, never trimmed (2026-09-01 "rc/config.ts" catch)', () => {
  // ` M` = unstaged edit — the leading space is the X status field. Feeding a
  // pre-trimmed line here is exactly the bug; the parser must assume nothing.
  assert.equal(parsePorcelainLine(' M src/config.ts'), 'src/config.ts')
  assert.equal(parsePorcelainLine('?? public/new-level.json'), 'public/new-level.json')
  assert.equal(parsePorcelainLine('M  public/game-data.json'), 'public/game-data.json')
  assert.equal(parsePorcelainLine('R  src/old.ts -> src/extensions/new.ts'), 'src/extensions/new.ts')
  assert.equal(parsePorcelainLine(''), null)
  assert.equal(parsePorcelainLine('?? '), null)
})

test('generated/transient outputs never count — judging build output as a violation would be noise', () => {
  for (const path of ['.selfcheck/01-start.png', 'dist-play/index.html', '.verify-result.json', 'node_modules/phaser/package.json']) {
    assert.deepEqual(judgeWriteSurface(path, { existedAtRoot: false }), { ok: true })
    assert.deepEqual(judgeWriteSurface(path, { existedAtRoot: true }), { ok: true })
  }
})
