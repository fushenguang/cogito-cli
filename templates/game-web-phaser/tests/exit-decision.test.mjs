// Tests for scripts/lib/exit-decision.mjs — design D8 (revised 2026-08-11).
//
// 🔴 Three directions of the same risk, each with its own test:
//   1. judged-with-failure must NOT silently pass (task 4.3)
//   2. `absent` must NOT turn every existing generated project red — those
//      projects never opted into assertions.json
//   3. `unavailable` must NOT be treated as a pass — someone DID ask for IA
//      and the gate could not run, which is the silent-skip this template's
//      first rule forbids
//
// 🔴 And the one that caused the revision: `passed` (written into
// .verify-result.json, rendered by the web as 「验收结论」) and the exit code
// must never disagree. They now come from one function, and the last test
// here is what keeps them that way.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideExitCode, decideVerdict } from '../scripts/lib/exit-decision.mjs'

test('BH failure exits non-zero regardless of IA status', () => {
  assert.equal(decideExitCode({ bhPassed: false, assertions: { status: 'absent', results: [] } }), 1)
  assert.equal(decideExitCode({ bhPassed: false, assertions: { status: 'judged', results: [] } }), 1)
})

test('BH passed + IA judged with a failure exits non-zero (design D8)', () => {
  const assertions = { status: 'judged', results: [{ passed: true }, { passed: false }] }
  assert.equal(decideExitCode({ bhPassed: true, assertions }), 1)
  assert.deepEqual(decideVerdict({ bhPassed: true, assertions }), { passed: false, iaVerdict: 'fail' })
})

test('BH passed + IA judged all-pass exits zero', () => {
  const assertions = { status: 'judged', results: [{ passed: true }, { passed: true }] }
  assert.equal(decideExitCode({ bhPassed: true, assertions }), 0)
  assert.deepEqual(decideVerdict({ bhPassed: true, assertions }), { passed: true, iaVerdict: 'pass' })
})

test('BH passed + IA absent exits zero — a project with no assertions.json is not IA-red (task 4.3)', () => {
  const assertions = { status: 'absent', results: [] }
  assert.equal(decideExitCode({ bhPassed: true, assertions }), 0)
  assert.deepEqual(decideVerdict({ bhPassed: true, assertions }), {
    passed: true,
    iaVerdict: 'not-applicable',
  })
})

test('BH passed + IA unavailable is NOT a pass — a gate that could not run did not pass', () => {
  // 🔴 The original D8 said this exits 0. That was wrong, and this test is
  // the guard against it coming back: `unavailable` means assertions.json
  // existed and we could not judge it (no harness in the artifact, an
  // unrecognised schemaVersion, the runner threw). Exiting 0 there is exactly
  // "a gate that can be silently skipped", which this template forbids.
  // `absent` — nobody asked — remains the only benign case, one test above.
  const assertions = { status: 'unavailable', results: [] }
  assert.equal(decideExitCode({ bhPassed: true, assertions }), 1)
  assert.deepEqual(decideVerdict({ bhPassed: true, assertions }), { passed: false, iaVerdict: 'fail' })
})

test('the exit code and the written `passed` field can never disagree', () => {
  // The defect this file exists to prevent: `passed: true` written into
  // .verify-result.json while the process exits 1. The web reads `passed`
  // and shows 「验收结论：通过」 — so that combination displays a failed run
  // as a successful one. Both values now derive from decideVerdict(); this
  // sweeps every combination to keep it that way.
  const statuses = ['judged', 'absent', 'unavailable']
  const resultSets = [[], [{ passed: true }], [{ passed: false }], [{ passed: true }, { passed: false }]]
  for (const bhPassed of [true, false]) {
    for (const status of statuses) {
      for (const results of resultSets) {
        const input = { bhPassed, assertions: { status, results } }
        assert.equal(
          decideExitCode(input),
          decideVerdict(input).passed ? 0 : 1,
          `disagreement for bhPassed=${bhPassed} status=${status} results=${JSON.stringify(results)}`,
        )
      }
    }
  }
})
