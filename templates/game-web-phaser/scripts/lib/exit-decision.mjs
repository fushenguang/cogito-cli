// pnpm verify's exit-code rule (design D8) — pulled out into its own pure,
// zero-I/O function so it can be unit-tested without spinning up a real
// browser (tests/exit-decision.test.mjs). verify.mjs never gets imported by
// a test file — it's a script with a top-level `main().catch(...)` that
// would just run itself on import — so the decision logic has to live
// somewhere importable on its own if D8's "两条各要有测试" requirement is to
// mean an actual automated test and not just the real-machine run in task 5.3.
//
// 🔴 The rule this encodes (D8, revised 2026-08-11): IA failures make
// `pnpm verify` exit non-zero, same as a BH failure. So does `unavailable`
// — see below. Only `absent` is benign, because today every existing
// generated project has no assertions.json and must not turn red for a
// capability it has never opted into.
//
// 🔴 **Why `unavailable` is red, and the original design was wrong.**
//
// D8 first said `absent` and `unavailable` both leave the exit code alone.
// That lumped together two things that mean opposite things:
//
//   absent      — nobody asked for IA. Nothing was skipped.
//   unavailable — someone DID ask (assertions.json exists), and we could not
//                 judge it: no harness in the artifact, a schemaVersion we
//                 don't understand, the runner threw. **The gate did not run.**
//
// The upstream doctrine this template serves is explicit that the second one
// is never a pass ("文件缺失 / 不可解析 / schemaVersion 不认识，一律记成
// unavailable 并写明原因，绝不当成「闸门通过」"), and this template's own
// first rule is that a gate which can be silently skipped is not a gate.
// Exiting 0 on `unavailable` is exactly that silent skip.

/**
 * The single verdict both the exit code and `.verify-result.json`'s `passed`
 * field are derived from.
 *
 * 🔴 **They must come from one function.** Before this existed, `passed` was
 * BH-only while the exit code was BH+IA, so a run with a failing assertion
 * wrote `passed: true` and exited 1 — two contradictory answers to "did this
 * pass" inside one artifact. The web side reads `passed` and renders
 * 「验收结论：通过」from it, so that run displayed as a pass. A verification
 * layer that reports success when verification failed is the exact
 * self-deception this whole change exists to remove.
 *
 * @param {{
 *   bhPassed: boolean,
 *   assertions: { status: 'judged' | 'absent' | 'unavailable', results: readonly { passed: boolean }[] },
 * }} input
 * @returns {{ passed: boolean, iaVerdict: 'pass' | 'fail' | 'not-applicable' }}
 */
export function decideVerdict({ bhPassed, assertions }) {
  if (assertions.status === 'absent') {
    return { passed: bhPassed, iaVerdict: 'not-applicable' }
  }
  if (assertions.status === 'unavailable') {
    return { passed: false, iaVerdict: 'fail' }
  }
  const hasFailure = assertions.results.some((r) => !r.passed)
  return { passed: bhPassed && !hasFailure, iaVerdict: hasFailure ? 'fail' : 'pass' }
}

/**
 * @param {{
 *   bhPassed: boolean,
 *   assertions: { status: 'judged' | 'absent' | 'unavailable', results: readonly { passed: boolean }[] },
 * }} input
 * @returns {0 | 1}
 */
export function decideExitCode({ bhPassed, assertions }) {
  return decideVerdict({ bhPassed, assertions }).passed ? 0 : 1
}
