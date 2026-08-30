// Tests for scripts/lib/skill-injection.mjs — the pure logic behind the
// postinstall step that copies node_modules/phaser/skills/* into
// ${HOME}/.config/shelley/ (design.md D1-D4 in
// openspec/changes/phaser-skill-injection).
//
// Zero real filesystem access on purpose (tasks.md 2.1): every function
// under test takes its filesystem facts as plain data (an env object, a
// boolean "does this dir exist", fs.Dirent-shaped entries) rather than
// calling fs itself. The actual disk I/O lives in
// scripts/install-phaser-skills.mjs, which this suite never imports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  resolveHome,
  resolveShelleyDir,
  shouldInject,
  listSkillDirNames,
  planCopy,
} from '../scripts/lib/skill-injection.mjs'

// --- resolveHome --------------------------------------------------------

test('resolveHome reads $HOME from the given env object', () => {
  assert.equal(resolveHome({ HOME: '/home/shelley' }), '/home/shelley')
})

test('resolveHome returns undefined when $HOME is unset, empty, or not a string', () => {
  assert.equal(resolveHome({}), undefined)
  assert.equal(resolveHome({ HOME: '' }), undefined)
  assert.equal(resolveHome({ HOME: undefined }), undefined)
  assert.equal(resolveHome(undefined), undefined)
})

// --- resolveShelleyDir ---------------------------------------------------

test('resolveShelleyDir joins $HOME with .config/shelley', () => {
  assert.equal(resolveShelleyDir('/home/shelley'), path.join('/home/shelley', '.config', 'shelley'))
})

test('resolveShelleyDir never falls back to a hardcoded /root or bare /.config path', () => {
  // 🔴 The regression this guards against: guest VMs run with HOME=/, and a
  // hardcoded /root/.config/shelley silently fails there (file lands, but
  // `shelley skill ls` never lists it — see design.md D2). The only correct
  // behavior for a falsy home is "cannot proceed", never a guessed path.
  assert.equal(resolveShelleyDir(undefined), undefined)
  assert.equal(resolveShelleyDir(''), undefined)

  // And when $HOME genuinely is "/" (the guest's real value), the result
  // must still be derived from it — path.join("/", ".config", "shelley") —
  // not short-circuited into something else.
  assert.equal(resolveShelleyDir('/'), path.join('/', '.config', 'shelley'))
})

// --- shouldInject (the guard) --------------------------------------------

test('shouldInject is true only when $HOME is set AND ${HOME}/.config/shelley exists', () => {
  assert.equal(shouldInject({ home: '/home/shelley', shelleyDirExists: true }), true)
})

test('shouldInject is false when ${HOME}/.config/shelley does not exist — the developer-machine no-op case', () => {
  // This is judge 3 / task 3.2 in one predicate: a developer's own machine
  // has $HOME set but no ~/.config/shelley, and must not be written to.
  assert.equal(shouldInject({ home: '/Users/dev', shelleyDirExists: false }), false)
})

test('shouldInject is false when $HOME itself is unset, even if shelleyDirExists is somehow true', () => {
  assert.equal(shouldInject({ home: undefined, shelleyDirExists: true }), false)
})

test('shouldInject is false when both are absent', () => {
  assert.equal(shouldInject({ home: undefined, shelleyDirExists: false }), false)
})

// --- listSkillDirNames ----------------------------------------------------

function direntLike(name, isDir) {
  return { name, isDirectory: () => isDir }
}

test('listSkillDirNames returns only directory names, sorted', () => {
  const entries = [
    direntLike('scenes', true),
    direntLike('README.md', false),
    direntLike('physics-arcade', true),
    direntLike('.DS_Store', false),
    direntLike('animations', true),
  ]
  assert.deepEqual(listSkillDirNames(entries), ['animations', 'physics-arcade', 'scenes'])
})

test('listSkillDirNames returns an empty list for an empty or all-file listing', () => {
  assert.deepEqual(listSkillDirNames([]), [])
  assert.deepEqual(listSkillDirNames([direntLike('README.md', false)]), [])
})

// --- planCopy --------------------------------------------------------------

test('planCopy builds src under phaserSkillsDir and dest under shelleyDir, same skill name', () => {
  const plan = planCopy({
    phaserSkillsDir: '/proj/node_modules/phaser/skills',
    shelleyDir: '/home/shelley/.config/shelley',
    name: 'physics-arcade',
  })
  assert.deepEqual(plan, {
    src: path.join('/proj/node_modules/phaser/skills', 'physics-arcade'),
    dest: path.join('/home/shelley/.config/shelley', 'physics-arcade'),
  })
})
