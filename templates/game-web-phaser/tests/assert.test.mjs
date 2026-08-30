// Tests for scripts/assert.mjs — tasks 3.1-3.7, design D4-D6.
//
// 🔴 Every judge function gets a passing case AND a "should fail" case (task
// 3.7 / tasks.md's rule 3: "只测正例的话 return true 也全绿"). Every
// precondition-unmet case is asserted against the fixed
// "前提不满足（不是产物缺陷）" hint prefix (task 3.4), not just `passed: false`,
// so a defect and an unmet precondition can never collapse into each other
// without a test noticing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readAssertionsFile,
  runAssertions,
  judgeOne,
  KNOWN_TEMPLATE_IDS,
  checkTriggerIntegrityAvailability,
} from '../scripts/assert.mjs'
import { MockHarness, createReferenceLikeHarness } from './helpers/mock-harness.mjs'

const PRECONDITION_PREFIX = '前提不满足（不是产物缺陷）'

function tmpProjectDir() {
  return mkdtempSync(join(tmpdir(), 'assert-test-'))
}

function writeAssertionsJson(dir, body) {
  writeFileSync(join(dir, 'assertions.json'), JSON.stringify(body))
}

// ───────────────────────────────────────────────────────────────────────
// Template registry sync (this file's describe() mirror vs. upstream's set)
// ───────────────────────────────────────────────────────────────────────

test('KNOWN_TEMPLATE_IDS is exactly upstream\'s 8-id closed set', () => {
  // Pinned from cogito-lib's ASSERTION_TEMPLATE_IDS
  // (apps/web/src/core/types/workspace.ts) — if this test breaks, either
  // upstream added/removed a template id, or this mirror drifted. Either way
  // it needs a human to reconcile scripts/assert.mjs's TEMPLATE_DESCRIBERS,
  // not a silent pass. `data_from_files` joined with data-layer-gate /
  // game-data-spine (2026-08-30): upstream adds the template id AND its
  // describe() wording, this mirror copies both verbatim — the wording is
  // pinned by the judge tests below, not just the id.
  const expected = [
    'restart',
    'controllable',
    'score_feedback',
    'game_over_trigger',
    'hud_text_present',
    'value_persists',
    'loads_clean',
    'data_from_files',
  ].sort()
  assert.deepEqual([...KNOWN_TEMPLATE_IDS].sort(), expected)
})

// ───────────────────────────────────────────────────────────────────────
// readAssertionsFile — task 3.1: absent vs. unavailable, never a failure
// ───────────────────────────────────────────────────────────────────────

test('readAssertionsFile: no file -> absent', () => {
  const dir = tmpProjectDir()
  try {
    assert.deepEqual(readAssertionsFile(dir), { status: 'absent' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAssertionsFile: invalid JSON -> unavailable, not a crash', () => {
  const dir = tmpProjectDir()
  try {
    writeFileSync(join(dir, 'assertions.json'), '{ not valid json')
    const result = readAssertionsFile(dir)
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAssertionsFile: unrecognized schemaVersion -> unavailable', () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, { schemaVersion: 2, assertions: [] })
    const result = readAssertionsFile(dir)
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /schemaVersion/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAssertionsFile: assertions not an array -> unavailable', () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, { schemaVersion: 1, assertions: { oops: true } })
    assert.equal(readAssertionsFile(dir).status, 'unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAssertionsFile: unrecognized templateId -> unavailable', () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, {
      schemaVersion: 1,
      assertions: [{ itemId: 'a', templateId: 'not_a_real_template', params: {} }],
    })
    const result = readAssertionsFile(dir)
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /not_a_real_template/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAssertionsFile: well-formed file -> ok, with assertions passed through', () => {
  const dir = tmpProjectDir()
  try {
    const body = { schemaVersion: 1, assertions: [{ itemId: 'a', templateId: 'loads_clean', params: {} }] }
    writeAssertionsJson(dir, body)
    const result = readAssertionsFile(dir)
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.assertions, body.assertions)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────────────────
// loads_clean
// ───────────────────────────────────────────────────────────────────────

test('loads_clean: passes when BH-1 evidence is clean', async () => {
  const item = { itemId: 'a', templateId: 'loads_clean', params: {} }
  const result = await judgeOne(new MockHarness(), { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, true)
  assert.equal(result.failure, null)
})

test('loads_clean: fails when BH-1 evidence has an exception (negative case)', async () => {
  const item = { itemId: 'a', templateId: 'loads_clean', params: {} }
  const result = await judgeOne(
    new MockHarness(),
    { exceptions: ['TypeError: boom'], failedRequests: [] },
    item,
  )
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint?.includes(PRECONDITION_PREFIX), 'a real BH-1 failure is a defect, not a precondition gap')
})

// ───────────────────────────────────────────────────────────────────────
// controllable
// ───────────────────────────────────────────────────────────────────────

test('controllable: passes when the named entity moves after press()', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    entities: [{ name: 'player', x: 100, y: 100 }],
    onPress: (key, self) => {
      if (key === 'ArrowRight') self.entities = [{ name: 'player', x: 110, y: 100 }]
    },
  })
  const item = { itemId: 'a', templateId: 'controllable', params: { key: 'ArrowRight' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('controllable: fails when nothing moves (negative case — a `return true` stub would miss this)', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    entities: [{ name: 'player', x: 100, y: 100 }],
    // onPress deliberately does nothing — simulates a broken movement binding
  })
  const item = { itemId: 'a', templateId: 'controllable', params: { key: 'ArrowRight' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
})

test('controllable: precondition-not-met when no gameplay-role state exists', async () => {
  const harness = new MockHarness({ states: [{ id: 'Boot', role: 'other' }] })
  const item = { itemId: 'a', templateId: 'controllable', params: { key: 'ArrowRight' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

test('controllable: precondition-not-met when the key is not recognized by press()', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    entities: [{ name: 'player', x: 0, y: 0 }],
  })
  const item = { itemId: 'a', templateId: 'controllable', params: { key: 'NotAKey' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// ───────────────────────────────────────────────────────────────────────
// hud_text_present
// ───────────────────────────────────────────────────────────────────────

test('hud_text_present: passes on a substring match', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], hudTexts: ['Score: 0'] })
  const item = { itemId: 'a', templateId: 'hud_text_present', params: { text: 'Score', state: 'Game' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('hud_text_present: fails when no HUD text contains the substring (negative case)', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], hudTexts: ['Lives: 3'] })
  const item = { itemId: 'a', templateId: 'hud_text_present', params: { text: 'Score', state: 'Game' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
})

test('hud_text_present: precondition-not-met when the state param resolves to nothing', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }] })
  const item = { itemId: 'a', templateId: 'hud_text_present', params: { text: 'Score', state: 'Nope' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// ───────────────────────────────────────────────────────────────────────
// value_persists
// ───────────────────────────────────────────────────────────────────────

test('value_persists: passes when the value is unchanged across the transition', async () => {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    values: { highScore: 5 },
  })
  const item = {
    itemId: 'a', templateId: 'value_persists',
    params: { value: 'highScore', from: 'Game', to: 'GameOver' },
  }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('value_persists: fails when the value changes across the transition (negative case)', async () => {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    values: { highScore: 5 },
    onApplyState: (id, self) => {
      // Simulate a bug: the value resets when entering GameOver.
      if (id === 'GameOver') self.values = { highScore: 0 }
    },
  })
  const item = {
    itemId: 'a', templateId: 'value_persists',
    params: { value: 'highScore', from: 'Game', to: 'GameOver' },
  }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
})

test('value_persists: precondition-not-met when values[] is missing the key — this is the reference-implementation-today case', async () => {
  // The wave-1/2 reference implementation's readValues() returns {} — see
  // the ia-assertion-runner proposal's explicitly-flagged open point. This
  // is exactly the shape that produces, and it MUST read as "can't judge",
  // never as a silent pass.
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    values: {}, // no keys at all
  })
  const item = {
    itemId: 'a', templateId: 'value_persists',
    params: { value: 'lives', from: 'Game', to: 'GameOver' },
  }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

test('value_persists: precondition-not-met when "from"/"to" do not resolve to any state', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], values: { x: 1 } })
  const item = {
    itemId: 'a', templateId: 'value_persists',
    params: { value: 'x', from: 'Nope', to: 'Game' },
  }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// ───────────────────────────────────────────────────────────────────────
// score_feedback — 🔴 must judge hudTexts, never `score` (design D5)
// ───────────────────────────────────────────────────────────────────────

test('score_feedback: passes when hudTexts change after firing the trigger', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    hudTexts: ['Score: 0'],
    onFire: (trigger, self) => {
      if (trigger === 'score') {
        self.score += 1
        self.hudTexts = [`Score: ${self.score}`]
      }
    },
  })
  const item = { itemId: 'a', templateId: 'score_feedback', params: { condition: 'score' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('score_feedback: FAILS when `score` changes internally but no HUD text changes — the exact bug this template exists to catch (negative case, design D4\'s own example)', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    hudTexts: ['Score: 0'],
    onFire: (trigger, self) => {
      if (trigger === 'score') self.score += 1 // bumps the internal field, forgets the Text object
    },
  })
  const item = { itemId: 'a', templateId: 'score_feedback', params: { condition: 'score' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
  assert.match(result.failure.actual, /hudTexts 前后一致/)
})

test('score_feedback: precondition-not-met when the trigger is not registered', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], triggers: [] })
  const item = { itemId: 'a', templateId: 'score_feedback', params: { condition: 'ghost' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// ───────────────────────────────────────────────────────────────────────
// trigger-integrity-and-onscreen-gate task 1.3: fire() throwing (harness.ts's
// "handler moved the player" check) must be judged as a trigger-integrity
// violation, NEVER as an unmet precondition — the trigger IS registered and
// applyState() DID succeed; it's the product that's provably breaking the
// contract. This is what design D5/spec.md's "该断言判为 unavailable" scenario
// looks like once the JS shapes exist: a `failResult` with a hint prefix
// distinct from `PRECONDITION_PREFIX`.
// ───────────────────────────────────────────────────────────────────────

test('score_feedback: fire() throwing (trigger moved the player) is a trigger-integrity violation, not a precondition gap', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    hudTexts: ['Score: 0'],
    onFire: (trigger) => {
      if (trigger === 'score') {
        throw new Error(
          'harness.fire: trigger "score"\'s handler moved the "player" entity from (200, 400) to (500, 100)',
        )
      }
    },
  })
  const item = { itemId: 'a', templateId: 'score_feedback', params: { condition: 'score' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX), 'must not read as an unmet precondition')
  assert.match(result.failure.hint, /触发器违规/)
  assert.match(result.failure.actual, /moved the "player" entity/)
})

// ───────────────────────────────────────────────────────────────────────
// game_over_trigger
// ───────────────────────────────────────────────────────────────────────

test('game_over_trigger: passes when firing the trigger lands on a gameover-role state', async () => {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    triggers: ['gameover'],
    onFire: (trigger, self) => {
      if (trigger === 'gameover') self.stateId = 'GameOver'
    },
  })
  const item = { itemId: 'a', templateId: 'game_over_trigger', params: { condition: 'gameover' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('game_over_trigger: fails when the trigger fires but the state stays gameplay (negative case)', async () => {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    triggers: ['gameover'],
    // onFire deliberately a no-op — simulates a collision handler that never transitions
  })
  const item = { itemId: 'a', templateId: 'game_over_trigger', params: { condition: 'gameover' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
})

test('game_over_trigger: precondition-not-met when the trigger is not registered', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], triggers: [] })
  const item = { itemId: 'a', templateId: 'game_over_trigger', params: { condition: 'ghost' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

test('game_over_trigger: fire() throwing (trigger moved the player) is a trigger-integrity violation, not a precondition gap', async () => {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    triggers: ['gameover'],
    onFire: (trigger) => {
      if (trigger === 'gameover') {
        throw new Error(
          'harness.fire: trigger "gameover"\'s handler moved the "player" entity from (200, 400) to (200, 900)',
        )
      }
    },
  })
  const item = { itemId: 'a', templateId: 'game_over_trigger', params: { condition: 'gameover' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX), 'must not read as an unmet precondition')
  assert.match(result.failure.hint, /触发器违规/)
  assert.match(result.failure.actual, /moved the "player" entity/)
})

// ───────────────────────────────────────────────────────────────────────
// restart
// ───────────────────────────────────────────────────────────────────────

test('restart: passes when the restart key returns to gameplay with score reset to 0', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    score: 3,
    onFire: (trigger, self) => {
      if (trigger === 'score') self.score += 1
    },
    onPress: (key, self) => {
      if (key === 'KeyR') self.score = 0
    },
  })
  const item = { itemId: 'a', templateId: 'restart', params: { trigger: 'KeyR' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, true)
})

test('restart: fails when score does not reset to 0 (negative case)', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    score: 0,
    onFire: (trigger, self) => {
      if (trigger === 'score') self.score += 1
    },
    // onPress deliberately does not reset score on KeyR — simulates a restart that forgets to zero it
  })
  const item = { itemId: 'a', templateId: 'restart', params: { trigger: 'KeyR' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.includes(PRECONDITION_PREFIX))
})

test('restart: `score: null` (a scoreless game) MUST NOT be treated as "reset to zero" (spec.md\'s named negative case)', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: [],
    score: null,
  })
  const item = { itemId: 'a', templateId: 'restart', params: { trigger: 'KeyR' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false, 'null must never satisfy the `score === 0` check')
})

test('restart: precondition-not-met when the restart key is not recognized by press()', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], triggers: [] })
  const item = { itemId: 'a', templateId: 'restart', params: { trigger: 'NotAKey' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// 🔴 real gap found and fixed during this change's own real-machine
// verification (judgment 3.1): `judgeRestart()` also calls `harness.fire('score')`
// as best-effort setup, unguarded, BEFORE `judgeScoreFeedback`/`judgeGameOverTrigger`'s
// own guarded calls ever run — assertions.json's default order puts `restart`
// before `score_feedback`, so an unguarded throw here reached runAssertions()'s
// crash handler first and turned the ENTIRE run `unavailable`, hiding every
// other item's real verdict. Must be caught and reported on the `restart`
// item itself, exactly like the other two call sites.
test('restart: fire(\'score\') throwing (trigger moved the player) during best-effort score setup is a trigger-integrity violation, not swallowed as "convention doesn\'t apply"', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    triggers: ['score'],
    onFire: (trigger) => {
      if (trigger === 'score') {
        throw new Error(
          'harness.fire: trigger "score"\'s handler moved the "player" entity from (480, 460) to (680, 460)',
        )
      }
    },
  })
  const item = { itemId: 'a', templateId: 'restart', params: { trigger: 'KeyR' } }
  const result = await judgeOne(harness, {}, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX), 'must not read as an unmet precondition')
  assert.match(result.failure.hint, /触发器违规/)
})

test('runAssertions: one item\'s fire() violation fails ONLY that item — it must not crash the whole run to `unavailable` and hide every other item\'s verdict', async () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, {
      schemaVersion: 1,
      assertions: [
        { itemId: 'restart', templateId: 'restart', params: { trigger: 'KeyR' } },
        { itemId: 'hud', templateId: 'hud_text_present', params: { text: 'Score', state: 'Game' } },
      ],
    })
    const harness = new MockHarness({
      states: [{ id: 'Game', role: 'gameplay' }],
      triggers: ['score'],
      hudTexts: ['Score: 0'],
      keyTable: new Set(['KeyR']),
      onFire: (trigger) => {
        if (trigger === 'score') {
          throw new Error('harness.fire: trigger "score" moved the "player" entity')
        }
      },
    })
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'judged', 'a fire() violation on one item must stay a per-item failure, not a run-wide crash')
    assert.equal(result.total, 2)
    assert.equal(result.results.find((r) => r.itemId === 'restart').passed, false)
    assert.match(result.results.find((r) => r.itemId === 'restart').failure.hint, /触发器违规/)
    // The unrelated hud_text_present item still gets judged normally.
    assert.equal(result.results.find((r) => r.itemId === 'hud').passed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────────────────
// data_from_files — game-data-spine design D3: every gap is a FAILURE,
// never a precondition (the whole point of the template)
// ───────────────────────────────────────────────────────────────────────

// The describe() mirror is pinned character-for-character (design D6's
// manual-mirror discipline made testable): every failure result carries
// `failure.expected`, and this is the id's one zero-param entry.
test('data_from_files: expected wording is the verbatim upstream sentence (checked via a failing case, which always carries failure.expected)', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], data: null })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.failure.expected, '玩法内容（关卡/规则/词表）定义在独立数据文件中，且运行时实际从数据文件加载（场景代码不承载内容定义）')
})

test('data_from_files: passes when all three layers are non-empty', async () => {
  const harness = createReferenceLikeHarness()
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.deepEqual(result, { itemId: 'a', templateId: 'data_from_files', passed: true, failure: null })
})

test('data_from_files: data=null (never declared a data layer — the V2 pure-code shape) FAILS, and the hint must NOT read as an unmet precondition', async () => {
  const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], data: null })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX), 'manifest-absent is a defect, never a precondition (spec)')
  assert.match(result.failure.hint, /先按数据层约定立数据/)
  assert.match(result.failure.actual, /声明 0 条/)
})

test('data_from_files: declared-but-never-loaded (executor stripped the init call) FAILS with the load-fix hint', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    data: {
      declared: [{ id: 'levels:level-1', section: 'levels' }],
      loaded: [],
      usedInScene: [],
    },
  })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX))
  assert.match(result.failure.hint, /没有加载/)
  assert.match(result.failure.actual, /声明 1 条 \/ 加载 0 条 \/ 场景消费 0 条/)
})

test('data_from_files: loaded-but-never-consumed (the empty-shell decoy) FAILS, actual distinguishes the three layers', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    data: {
      declared: [{ id: 'levels:level-1', section: 'levels' }, { id: 'rules', section: 'rules' }],
      loaded: [{ id: 'levels:level-1', section: 'levels' }, { id: 'rules', section: 'rules' }],
      usedInScene: [],
    },
  })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX))
  assert.match(result.failure.hint, /没有消费|消费/)
  assert.match(result.failure.actual, /声明 2 条 \/ 加载 2 条 \/ 场景消费 0 条/)
})

test('data_from_files: no gameplay state at all FAILS as a product defect, not a precondition', async () => {
  const harness = new MockHarness({ states: [{ id: 'GameOver', role: 'gameover' }] })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX), 'data_from_files may never produce 前提不满足 (spec delta)')
})

test('data_from_files: applyState rejecting the gameplay state FAILS as a product defect, not a precondition', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    data: { declared: [{ id: 'levels:level-1', section: 'levels' }], loaded: [], usedInScene: [] },
    onApplyState: () => false,
  })
  const item = { itemId: 'a', templateId: 'data_from_files', params: {} }
  const result = await judgeOne(harness, { exceptions: [], failedRequests: [] }, item)
  assert.equal(result.passed, false)
  assert.ok(!result.failure.hint.startsWith(PRECONDITION_PREFIX))
})

// ───────────────────────────────────────────────────────────────────────
// design D6 — order independence, via runAssertions() end to end
// ───────────────────────────────────────────────────────────────────────

test('design D6: shuffling assertions.json\'s order does not change any item\'s verdict', async () => {
  const items = [
    { itemId: 'loads', templateId: 'loads_clean', params: {} },
    { itemId: 'move', templateId: 'controllable', params: { key: 'ArrowRight' } },
    { itemId: 'restart', templateId: 'restart', params: { trigger: 'KeyR' } },
    { itemId: 'hud', templateId: 'hud_text_present', params: { text: 'Score', state: 'Game' } },
    { itemId: 'persist', templateId: 'value_persists', params: { value: 'highScore', from: 'Game', to: 'GameOver' } },
    { itemId: 'score', templateId: 'score_feedback', params: { condition: 'score' } },
    { itemId: 'over', templateId: 'game_over_trigger', params: { condition: 'gameover' } },
    { itemId: 'data', templateId: 'data_from_files', params: {} },
  ]
  const reversedItems = [...items].reverse()
  const loadEvidence = { exceptions: [], failedRequests: [] }

  const dirA = tmpProjectDir()
  const dirB = tmpProjectDir()
  try {
    writeAssertionsJson(dirA, { schemaVersion: 1, assertions: items })
    writeAssertionsJson(dirB, { schemaVersion: 1, assertions: reversedItems })

    const harnessA = createReferenceLikeHarness()
    const harnessB = createReferenceLikeHarness()

    const resultA = await runAssertions({ harness: harnessA, loadEvidence, projectRoot: dirA })
    const resultB = await runAssertions({ harness: harnessB, loadEvidence, projectRoot: dirB })

    assert.equal(resultA.status, 'judged')
    assert.equal(resultB.status, 'judged')

    // Compare by itemId, not by array position, since the input order itself
    // differs — the claim under test is "same item -> same verdict",  not
    // "same array shape".
    const byId = (results) => Object.fromEntries(results.map((r) => [r.itemId, r]))
    assert.deepEqual(byId(resultA.results), byId(resultB.results))
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────────────────
// runAssertions() top-level status gating — absent / unavailable / judged
// ───────────────────────────────────────────────────────────────────────

test('runAssertions: no assertions.json -> absent, without even probing the harness', async () => {
  const dir = tmpProjectDir()
  try {
    const harness = new MockHarness({ exists: false }) // if this got called, the test below would catch it
    const result = await runAssertions({ harness, loadEvidence: {}, projectRoot: dir })
    assert.equal(result.status, 'absent')
    assert.equal(result.total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAssertions: harness missing -> unavailable, not a pass, not a failure list', async () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, { schemaVersion: 1, assertions: [{ itemId: 'a', templateId: 'loads_clean', params: {} }] })
    const harness = new MockHarness({ exists: false })
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /window\.__gameHarness/)
    assert.deepEqual(result.results, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAssertions: harness version mismatch -> unavailable', async () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, { schemaVersion: 1, assertions: [{ itemId: 'a', templateId: 'loads_clean', params: {} }] })
    const harness = new MockHarness({ version: 2 })
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /version/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAssertions: a well-formed file with a live harness judges every item and counts pass/fail correctly', async () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, {
      schemaVersion: 1,
      assertions: [
        { itemId: 'ok', templateId: 'loads_clean', params: {} },
        { itemId: 'bad', templateId: 'hud_text_present', params: { text: 'Nope', state: 'Game' } },
      ],
    })
    const harness = new MockHarness({ states: [{ id: 'Game', role: 'gameplay' }], hudTexts: ['Score: 0'] })
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'judged')
    assert.equal(result.total, 2)
    assert.equal(result.passedCount, 1)
    assert.equal(result.results.find((r) => r.itemId === 'ok').passed, true)
    assert.equal(result.results.find((r) => r.itemId === 'bad').passed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────────────────
// checkTriggerIntegrityAvailability — trigger-integrity-and-onscreen-gate
// task 1.2 / design D3: "no player entity" MUST NOT turn the run red, but
// MUST be visible (never a silent skip). These tests exercise the probe on
// its own, plus one showing it flows through runAssertions() into the
// `triggerIntegrityCheck` field regardless of which templates the project's
// assertions.json lists.
// ───────────────────────────────────────────────────────────────────────

test('checkTriggerIntegrityAvailability: ran=true when a "player" entity exists in the gameplay state', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    entities: [{ name: 'player', x: 200, y: 400 }],
  })
  const result = await checkTriggerIntegrityAvailability(harness)
  assert.deepEqual(result, { ran: true, reason: null })
})

test('checkTriggerIntegrityAvailability: ran=false (not red) when no entity is named "player" (D3\'s negative case)', async () => {
  const harness = new MockHarness({
    states: [{ id: 'Game', role: 'gameplay' }],
    entities: [{ name: 'goal', x: 200, y: 400 }], // some other named entity, just not "player"
  })
  const result = await checkTriggerIntegrityAvailability(harness)
  assert.equal(result.ran, false)
  assert.match(result.reason, /no entity named "player"/)
})

test('checkTriggerIntegrityAvailability: ran=false when there is no gameplay-role state at all', async () => {
  const harness = new MockHarness({ states: [] })
  const result = await checkTriggerIntegrityAvailability(harness)
  assert.equal(result.ran, false)
  assert.match(result.reason, /no state with role "gameplay"/)
})

test('runAssertions: judged result carries triggerIntegrityCheck, visible even when nothing in assertions.json uses fire()', async () => {
  const dir = tmpProjectDir()
  try {
    // Only a hud_text_present item — nothing here ever calls harness.fire() —
    // yet the "no player" fact must still surface (D3: a project-level fact,
    // not a per-assertion one).
    writeAssertionsJson(dir, {
      schemaVersion: 1,
      assertions: [{ itemId: 'hud', templateId: 'hud_text_present', params: { text: 'Score', state: 'Game' } }],
    })
    const harness = new MockHarness({
      states: [{ id: 'Game', role: 'gameplay' }],
      hudTexts: ['Score: 0'],
      entities: [], // no "player" entity in this project
    })
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'judged')
    assert.equal(result.triggerIntegrityCheck.ran, false)
    assert.match(result.triggerIntegrityCheck.reason, /no entity named "player"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAssertions: triggerIntegrityCheck.ran is true for the reference-like harness (has a "player" entity)', async () => {
  const dir = tmpProjectDir()
  try {
    writeAssertionsJson(dir, { schemaVersion: 1, assertions: [{ itemId: 'loads', templateId: 'loads_clean', params: {} }] })
    const harness = createReferenceLikeHarness()
    const result = await runAssertions({ harness, loadEvidence: { exceptions: [], failedRequests: [] }, projectRoot: dir })
    assert.equal(result.status, 'judged')
    assert.deepEqual(result.triggerIntegrityCheck, { ran: true, reason: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
