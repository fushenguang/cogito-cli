#!/usr/bin/env node
// verify.mjs — the three-tier judgement this template ships instead of
// prose ("take a screenshot and eyeball it"). See
// openspec/changes/game-template-verification/{proposal,design}.md in the
// AgentDock platform repo for the full rationale; short version:
//
//   BH-0  build   — the build command exits 0
//   BH-1  load    — headless Chromium loads the build with no uncaught
//                   exception and no failed resource request
//   BH-2  render  — the screenshot is provably non-empty (unique-colour +
//                   variance floor, not just "a PNG exists") and the game
//                   canvas has non-zero size
//   AU    asset usage — if `public/game-assets.json` declared anything,
//                   the assets it named actually reached the runtime
//                   (texture/audio cache) AND something in the game is
//                   currently drawing/playing them — see
//                   scripts/lib/asset-usage.mjs's header for the real
//                   incident (add.image hit-count 0 across every level,
//                   despite every other gate passing) that motivated this.
//   IA    assertions — machine-judgable acceptance items from
//                   assertions.json, judged against window.__gameHarness
//                   (see scripts/assert.mjs).
//
// Zero new dependencies (Gate ②): this spawns whatever Chromium already
// exists in the environment (scripts/lib/find-browser.mjs) and speaks CDP
// over Node's own built-in `WebSocket` (stable since Node 22).
//
// 🔴 Every gate below either passes, or prints what it expected/looked for
// and fails the run (`fail()` below — throws so cleanup still runs, see
// task 4.1/4.2's doc on `fail()` and `main()`'s `finally`). None of them may
// print "skipping" and exit 0 — a check that can be silently skipped is not
// a check.

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBrowser } from './lib/find-browser.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { launchBrowser } from './lib/browser-launch.mjs'
import { inspectPage } from './lib/inspect-page.mjs'
import { decodePng, judgeScreenshotNonEmpty } from './lib/png.mjs'
import { judgeEntitiesWithinBounds, ENTITY_BOUNDS_MARGIN_PX, BOUNDS_OBSERVATION_MS } from './lib/entity-bounds.mjs'
import { judgeAssetUsage } from './lib/asset-usage.mjs'
import { runAssertions, RemoteHarness } from './assert.mjs'
import { decideExitCode, decideVerdict } from './lib/exit-decision.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DIST_DIR = join(PROJECT_ROOT, 'dist-play')

/**
 * Machine-readable gate results, written to RESULT_FILE on the way out —
 * on failure as well as on success.
 *
 * 🔴 **Writing it on failure is the whole point.** The upstream product reads
 * this file off the VM to surface gate outcomes in its web UI (framework
 * 阶段二 row 6: "results flow back to Run events — the verdict must not stay
 * inside the VM"). If the file only appeared when everything passed, the web
 * side would only ever be able to show successes: a verification layer that
 * is invisible exactly when it has something to say. That is the same
 * self-deception this whole change exists to remove.
 *
 * `schemaVersion` is deliberate: the consumer is a *different repo* on its own
 * release cadence. It should be able to reject a shape it does not understand
 * rather than silently mis-parse a newer one.
 *
 * ia-assertion-runner adds a top-level `assertions` field (see
 * `writeResultFile` below) but 🔴 deliberately does NOT bump `schemaVersion` —
 * see the proposal's "一处需要显式批准的契约变更". Upstream's
 * `normalizeGateResults` drops unknown fields but rejects unknown versions
 * outright; bumping the version would turn every existing generated
 * project's BH results `unavailable` the moment they next ran `pnpm verify`,
 * for a field they don't even use yet.
 */
const RESULT_FILE = join(PROJECT_ROOT, '.verify-result.json')
const gateResults = []
let resultWritten = false

/**
 * What gets written into `assertions` when `pnpm verify` aborts (a BH gate
 * failed, the browser never launched, ...) before IA ever got a chance to
 * run. This is itself an `unavailable` outcome, not a fourth status — design
 * D4's three-state rule ("judged / absent / unavailable") has no room for
 * "never asked", and "never asked" and "asked but couldn't judge" read the
 * same to a consumer: neither one means IA passed.
 */
const ASSERTIONS_NOT_RUN = {
  status: 'unavailable',
  reason: 'assertion runner did not run — verify aborted before the BH gates completed',
  passedCount: 0,
  total: 0,
  results: [],
}

/**
 * What gets written into `assetUsage` when `pnpm verify` aborts before the
 * AU gate ever got a chance to run — same "aborted, not judged" reasoning
 * as `ASSERTIONS_NOT_RUN` above (design consistency, not a claim that no
 * manifest exists).
 */
const ASSET_USAGE_NOT_RUN = {
  status: 'unavailable',
  reason: 'asset-usage gate did not run — verify aborted before the BH gates completed',
}

function recordGate(id, label, passed, detail) {
  gateResults.push({ id, label, passed, detail: detail ?? null })
}

/**
 * 🔴 Catch-all so that **every** exit path leaves a result file behind.
 *
 * Writing it inside `fail()` alone was not enough, and that was caught by
 * actually running the failure path rather than by reading the code: the
 * "no Chromium found" branch lives in lib/find-browser.mjs and exits on its
 * own, so the very first real failure produced **no file at all** — the web
 * side would have seen silence and been unable to distinguish "gates passed"
 * from "verify never got off the ground".
 *
 * An exit hook covers today's exit sites and any a later contributor adds,
 * which a per-site fix would not. This also covers the new IA exit path
 * (design D8: IA failures now make `pnpm verify` exit non-zero too) because
 * `main()` always calls `writeResultFile()` itself before touching
 * `process.exitCode` — by the time this hook runs, `resultWritten` is
 * already `true` and it's a no-op. It only ever does real work for a crash
 * this file's own code didn't anticipate.
 */
process.on('exit', (code) => {
  if (!resultWritten) writeResultFile(code === 0)
})

function writeResultFile(passed, assertions = ASSERTIONS_NOT_RUN, assetUsage = ASSET_USAGE_NOT_RUN) {
  if (resultWritten) return
  resultWritten = true
  const payload = {
    schemaVersion: 1,
    ranAt: new Date().toISOString(),
    passed,
    gates: gateResults,
    // Empty `gates` + passed:false means the run aborted before any gate could
    // be judged (environment problem: no browser, Node too old, …) — which is
    // a different thing from "a gate failed", and the consumer must be able to
    // tell them apart.
    abortedBeforeAnyGate: !passed && gateResults.length === 0,
    // 🔴 `assertions` MUST NOT be read as "IA passed" unless
    // `assertions.status === 'judged'` AND every entry in `results` passed.
    //
    // `passed` above is the combined BH+AU+IA verdict (`decideVerdict()`),
    // not BH alone. It was BH-only in the first implementation, which meant
    // a run with a failing assertion wrote `passed: true` while exiting 1 —
    // and the web side renders 「验收结论」 straight off this field, so that
    // run displayed as a pass. One artifact must not carry two answers.
    assertions,
    // 🔴 asset-usage-gate design, added the same way `assertions` was
    // (ia-assertion-runner): a new top-level field, `schemaVersion`
    // deliberately NOT bumped — see that change's note on this same line
    // for why (a version bump would make every existing generated
    // project's results `unavailable` for a field they don't use yet).
    // Same "must not be read as passed unless status/passed both say so"
    // rule as `assertions` above.
    assetUsage,
  }
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2) + '\n')
  } catch (err) {
    // Never let a reporting failure change the gate verdict — but do say so,
    // because a missing result file is what the web side will notice.
    console.error(`[verify] warning: could not write ${RESULT_FILE}: ${err.message}`)
  }
}

/**
 * 🔴 task 4.1/4.2 (2026-08-19, "C: failure-path process cleanup", approved
 * and folded into this change by the builder): thrown here, not
 * `process.exit()`ed. `process.exit()` terminates the process immediately
 * and skips every `finally` still on the stack — which is exactly how a
 * failing `pnpm verify` run (the COMMON case inside a VM, not the
 * exception) used to leak the headless Chromium process `main()`'s own
 * `finally` exists to `proc.kill()`. A real orphan (GPU helper included)
 * was observed alive 11 minutes after a single failed run; 2026-08-12 has a
 * documented incident where six orphaned Chromium processes pushed a
 * 4-vCPU guest's load average to 19 and made the platform falsely report
 * "environment prep failed" while the environment itself was fine.
 * Throwing instead lets every `try/finally` between this call site and
 * `main()`'s own `finally` run normally as the stack unwinds — see that
 * `finally` and the `catch` on `main()`'s promise at the bottom of this
 * file, which recognizes this exact error type and does nothing further
 * (fail() already did all the reporting).
 */
class VerifyFailure extends Error {}

function fail(stage, expected, actual, extra) {
  console.error(`\n[verify] ${stage} — FAILED`)
  console.error(`  expected: ${expected}`)
  console.error(`  actual:   ${actual}`)
  if (extra) console.error(`  detail:   ${extra}`)
  recordGate(stage, stage, false, `expected: ${expected} | actual: ${actual}`)
  writeResultFile(false)
  process.exitCode = 1
  throw new VerifyFailure(`${stage} failed — see the [verify] output above and ${RESULT_FILE}`)
}

/**
 * Node-version self-check (task 1.2 / proposal's explicit contract note).
 * `engines.node` says >=22 because the zero-dep CDP transport needs the
 * built-in `WebSocket` global that only exists from Node 22 onward. This
 * MUST be a hard failure, not a silently-skipped BH-1 — a gate nobody can
 * see got skipped is not a gate.
 */
function checkNodeWebSocket() {
  if (typeof WebSocket !== 'function') {
    fail(
      'Node runtime check',
      'global `WebSocket` is a function (Node >=22)',
      `typeof WebSocket === ${JSON.stringify(typeof WebSocket)} on Node ${process.version}`,
      'This template’s zero-dependency CDP transport requires Node’s built-in WebSocket. Upgrade Node, or see design.md D2/D3 if you are deliberately porting this to an older runtime.',
    )
  }
}

function runBuild() {
  const viteBinName = process.platform === 'win32' ? 'vite.cmd' : 'vite'
  const viteBinPath = join(PROJECT_ROOT, 'node_modules', '.bin', viteBinName)
  if (!existsSync(viteBinPath)) {
    fail('BH-0 build', `${viteBinPath} exists (run \`pnpm install\` first)`, 'not found')
  }

  console.log('[verify] BH-0 build — running `vite build --mode play`...')
  const result = spawnSync(viteBinPath, ['build', '--mode', 'play'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  })

  if (result.error) {
    fail('BH-0 build', 'build command runs', `spawn error: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail('BH-0 build', 'exit code 0', `exit code ${result.status}`)
  }
  recordGate('BH-0', '构建', true, 'vite build --mode play exited 0')
  console.log('[verify] BH-0 build — passed')
}

async function main() {
  checkNodeWebSocket()
  runBuild()

  const browser = resolveBrowser()
  console.log(`[verify] Using browser: ${browser.path} (found via: ${browser.source})`)

  // 🔴 task 4.1/4.2: every resource acquired from here on (`server`, `proc`,
  // the CDP client inside `inspected`) is released by the ONE `finally`
  // below on every exit path — a thrown `VerifyFailure` from `fail()`, any
  // other unexpected exception, or a clean return. Declared as `let` here
  // (not `const` inside the try) so that `finally` can reach whichever of
  // them actually got allocated before something failed; each starts
  // `undefined` and the `finally` uses `?.` so partial allocation (e.g.
  // `server` created but `launchBrowser()` never succeeded) cleans up
  // exactly what exists, nothing more.
  let server
  let proc
  let inspected
  try {
    const staticServer = await startStaticServer(DIST_DIR)
    server = staticServer.server
    const staticUrl = staticServer.url
    console.log(`[verify] Serving ${DIST_DIR} at ${staticUrl}`)

    let launched
    try {
      launched = await launchBrowser(browser)
    } catch (err) {
      fail('Browser launch', 'Chromium starts and prints its DevTools listening address', err.message)
    }
    proc = launched.proc
    const wsUrl = launched.wsUrl
    console.log(`[verify] Chromium DevTools endpoint: ${wsUrl}`)

    inspected = await inspectPage(wsUrl, staticUrl)

    if (inspected.exceptions.length > 0 || inspected.failedRequests.length > 0) {
      fail(
        'BH-1 load',
        'no uncaught exceptions and no failed resource requests',
        `${inspected.exceptions.length} uncaught exception(s), ${inspected.failedRequests.length} failed request(s)`,
        JSON.stringify(
          { exceptions: inspected.exceptions, failedRequests: inspected.failedRequests },
          null,
          2,
        ),
      )
    }
    recordGate('BH-1', '加载', true, 'no uncaught exceptions, no failed resource requests')
    console.log('[verify] BH-1 load — passed (no uncaught exceptions, no failed resource requests)')

    if (inspected.canvasWidth <= 0 || inspected.canvasHeight <= 0) {
      fail(
        'BH-2 render (canvas size)',
        'canvas clientWidth/clientHeight > 0',
        `${inspected.canvasWidth}x${inspected.canvasHeight}`,
      )
    }

    const decoded = decodePng(inspected.screenshotBase64)
    const judged = judgeScreenshotNonEmpty(decoded)
    if (!judged.nonEmpty) {
      fail(
        'BH-2 render (screenshot non-empty)',
        'unique-colour count and pixel variance both clear their floor',
        'below floor',
        judged.reason,
      )
    }

    // 🔴 trigger-integrity-and-onscreen-gate task 2.2 (design D4), REVISED by
    // design D8 (2026-08-19, supersedes D7 — see design.md D8, and
    // lib/entity-bounds.mjs's own header, for the full history of why the
    // first two fix attempts here were both wrong). Short version: the
    // second entity-bounds sample must establish its OWN observation
    // window — `applyState()` onto the gameplay-role state (same discipline
    // every IA judge already follows, design D6's "每条断言前强制
    // applyState"), wait `BOUNDS_OBSERVATION_MS`, then sample — instead of
    // reusing anything left over by IA. Both samples now run BEFORE IA, so
    // BH-2 is fully decided before IA ever starts (IA still does its own
    // per-item `applyState()` afterward, unaffected by this).
    const harness = new RemoteHarness(inspected.client, inspected.sessionId)

    async function sampleEntityBounds(which) {
      let snapshot
      try {
        snapshot = await harness.getSnapshot()
      } catch (err) {
        fail(
          `BH-2 render (entity bounds, ${which} sample)`,
          'window.__gameHarness.getSnapshot() succeeds',
          `threw: ${err.message}`,
        )
      }
      const check = judgeEntitiesWithinBounds(snapshot.entities, snapshot.worldBounds)
      if (!check.ok) {
        // 🔴 Every fact judgment 3.2a's re-check asked to be visible (which
        // sample, bounds source, out-of-bounds coordinates) goes into
        // `actual` — not `extra` — because `fail()`'s `extra` param is
        // console-only; only `expected`/`actual` are persisted into
        // `.verify-result.json` via `recordGate()`.
        const detail = JSON.stringify({ sample: which, worldBounds: snapshot.worldBounds, outOfBounds: check.outOfBounds })
        fail(
          `BH-2 render (entity bounds, ${which} sample)`,
          `every named entity stays within the world bounds (source: ${snapshot.worldBounds.source}, margin ${ENTITY_BOUNDS_MARGIN_PX}px)`,
          `${which} sample: ${check.outOfBounds.length} named entit${check.outOfBounds.length === 1 ? 'y' : 'ies'} out of bounds — ${detail}`,
        )
      }
      return snapshot
    }

    // Sample one — right after the page-load settle (this gate's original
    // timing; near-zero cost). Fails fast here if already out of bounds —
    // no need to spend the second sample's observation window proving what
    // this one already proved.
    const firstBoundsSnapshot = await sampleEntityBounds('first')

    const bh2CanvasDetail =
      `canvas ${inspected.canvasWidth}x${inspected.canvasHeight}, ` +
      `${judged.uniqueColors} unique colours, variance ${judged.variance.toFixed(2)}`

    // Sample two — design D8's own observation window. `applyState()` onto
    // whichever state has role `'gameplay'`, then wait `BOUNDS_OBSERVATION_MS`
    // before sampling, so a real-gravity drift has an actual window to
    // become visible in, independent of anything IA does later.
    //
    // 🔴 D3-shaped rule, same one `checkTriggerIntegrityAvailability()`
    // (scripts/assert.mjs) already follows for A: a project with no
    // gameplay-role state, or whose `applyState()` rejects it, does NOT
    // fail this gate — but that MUST be visible in `.verify-result.json`,
    // never a silent single-sample gate quietly pretending to be a
    // two-sample one. `recordGate()`'s `detail` argument IS persisted
    // (unlike `fail()`'s `extra`), so the note below reaches the file, not
    // just the console.
    const statesForBounds = await harness.listStates()
    const gameplayForBounds = statesForBounds.find((s) => s.role === 'gameplay')
    let secondBoundsSnapshot = null
    let secondSampleNote = null
    if (!gameplayForBounds) {
      secondSampleNote = 'no state with role "gameplay" — second entity-bounds observation window (design D8) did not run'
    } else {
      const appliedForBounds = await harness.applyState(gameplayForBounds.id)
      if (!appliedForBounds) {
        secondSampleNote = `applyState("${gameplayForBounds.id}") returned false — second entity-bounds observation window (design D8) did not run`
      } else {
        await harness.wait(BOUNDS_OBSERVATION_MS)
        secondBoundsSnapshot = await sampleEntityBounds('second')
      }
    }

    const bh2Detail = secondBoundsSnapshot
      ? `${bh2CanvasDetail}, entities within bounds across 2 samples ` +
        `(first source: ${firstBoundsSnapshot.worldBounds.source}, second source: ${secondBoundsSnapshot.worldBounds.source}, ` +
        `second sample after applyState("${gameplayForBounds.id}") + ${BOUNDS_OBSERVATION_MS}ms observation window)`
      : `${bh2CanvasDetail}, entities within bounds — first sample only (source: ${firstBoundsSnapshot.worldBounds.source}); ` +
        `second sample (design D8 gameplay observation window) DID NOT RUN: ${secondSampleNote}`
    recordGate('BH-2', '渲染', true, bh2Detail)
    console.log(`[verify] BH-2 render — passed (${bh2Detail})`)

    // ---- AU (asset-usage-gate) ----
    // 🔴 Piggybacks on the two entity-bounds snapshots already taken above —
    // zero extra CDP round trips. `firstBoundsSnapshot` is taken right after
    // page-load settle (whatever state boots first, e.g. Start — this is
    // where a title-screen asset would show up as used); `secondBoundsSnapshot`
    // (when it ran — see `secondSampleNote` above) is taken after
    // `applyState()` onto the gameplay-role state, which is where
    // backgrounds/characters are expected to show up. `judgeAssetUsage()`
    // unions `usedInScene` across whichever of the two actually ran — see
    // that function's own doc for why a single snapshot can't see everything
    // a project draws across its state machine.
    console.log('[verify] AU asset usage — checking declared assets made it into the runtime and are actually used...')
    const assetSnapshotsForUsage = [firstBoundsSnapshot.assets]
    if (secondBoundsSnapshot) assetSnapshotsForUsage.push(secondBoundsSnapshot.assets)
    const assetUsageResult = judgeAssetUsage(assetSnapshotsForUsage)
    logAssetUsageResult(assetUsageResult)

    // 🔴 Same reasoning as IA's `absent` below: nobody declared any assets,
    // so an AU row would be inventing a gate that does not apply to this
    // project. `unavailable` and a `judged`-with-failure DO get a row —
    // both are real "this did not pass" outcomes.
    const auPassed = assetUsageResult.status === 'absent' || (assetUsageResult.status === 'judged' && assetUsageResult.passed)
    if (assetUsageResult.status !== 'absent') {
      recordGate(
        'AU',
        '素材使用',
        auPassed,
        assetUsageResult.status === 'unavailable' ? `未判定：${assetUsageResult.reason}` : assetUsageResult.reason,
      )
    }

    // ---- IA (ia-assertion-runner, design D7) ----
    // 🔴 Same CDP session (`inspected.client`/`inspected.sessionId`), no
    // second page load. BH-1's evidence is handed straight to `loads_clean`'s
    // judge instead of being re-collected (task 3.6).
    console.log('[verify] IA assertions — checking for assertions.json...')
    const loadEvidence = { exceptions: inspected.exceptions, failedRequests: inspected.failedRequests }
    const assertionsResult = await runAssertions({ harness, loadEvidence, projectRoot: PROJECT_ROOT })
    logAssertionsResult(assertionsResult)

    // 🔴 IA becomes a row in `gates[]` (design D4, revised 2026-08-11), not
    // just a side field. The upstream web timeline already renders every
    // `gates[]` entry and derives 「验收结论」 from `passed` — recording IA
    // here means the verdict shows up on the web with **zero** changes on
    // that side, and it keeps the artifact self-consistent: a `passed:false`
    // run always has a red row explaining which gate failed.
    //
    // `absent` records nothing: nobody asked for IA, so an IA row in the
    // gate list would be inventing a gate that does not apply to this
    // project. `unavailable` DOES record a red row — someone asked and we
    // could not judge it, which is never a pass.
    // 🔴 `bhPassed` here is really "everything gated before IA passed" — BH-0
    // through BH-2 (any failure among those already threw via `fail()` and
    // never reached this line, so it's structurally `true` for them by the
    // time we get here) AND the AU gate above. `decideVerdict()`'s own
    // contract only needs one boolean for "did the non-IA half of the run
    // pass", so folding AU into it is the same shape IA itself already
    // established, not a new concept.
    const verdict = decideVerdict({ bhPassed: auPassed, assertions: assertionsResult })
    if (assertionsResult.status !== 'absent') {
      recordGate(
        'IA',
        '验收断言',
        verdict.iaVerdict === 'pass',
        assertionsResult.status === 'unavailable'
          ? `未判定：${assertionsResult.reason}`
          : `${assertionsResult.passedCount}/${assertionsResult.total} 通过`,
      )
    }

    writeResultFile(verdict.passed, assertionsResult, assetUsageResult)
    console.log(`\n[verify] Wrote ${RESULT_FILE}`)

    // `process.exitCode` (not `process.exit()`) so the `finally` block below
    // still runs its cleanup before Node actually exits.
    const exitCode = decideExitCode({ bhPassed: auPassed, assertions: assertionsResult })
    if (exitCode !== 0) {
      // 🔴 Before AU existed, reaching `exitCode !== 0` here was only
      // possible via IA (bhPassed was a hardcoded `true`) — so the `else`
      // branch below could assume IA was always the cause. That's no longer
      // true: AU can now fail this run on its own while IA is `absent` or
      // fully `judged`-passing. Each block below is therefore gated on its
      // OWN status actually being a failure, not on "exitCode is non-zero"
      // — printing "IA FAILED (0/0)" for a run IA had nothing to do with
      // would misattribute the failure.
      if (!auPassed) {
        console.error(
          `\n[verify] AU asset usage — ${assetUsageResult.status === 'unavailable' ? 'UNAVAILABLE' : 'FAILED'} (${assetUsageResult.reason})`,
        )
      }
      if (assertionsResult.status === 'unavailable') {
        console.error(
          `\n[verify] IA assertions — UNAVAILABLE (${assertionsResult.reason}) — a gate that could not run is not a gate that passed`,
        )
      } else if (assertionsResult.status === 'judged' && assertionsResult.passedCount < assertionsResult.total) {
        const failedCount = assertionsResult.total - assertionsResult.passedCount
        console.error(
          `\n[verify] IA assertions — FAILED (${failedCount}/${assertionsResult.total} failed) — see .verify-result.json "assertions.results"`,
        )
      }
      process.exitCode = exitCode
    }
  } finally {
    // 🔴 task 4.1/4.2: the ONE place that releases every resource this run
    // acquired, reached on every exit path now that `fail()` throws instead
    // of exiting directly — a clean finish, a `VerifyFailure`, or any other
    // unexpected exception all unwind through here. `?.`/optional-call
    // guards handle partial allocation (e.g. the browser never launched).
    inspected?.client?.close()
    proc?.kill()
    server?.close()
  }
}

function logAssetUsageResult(result) {
  if (result.status === 'absent') {
    console.log(`[verify] AU asset usage — absent (${result.reason})`)
    return
  }
  if (result.status === 'unavailable') {
    console.log(`[verify] AU asset usage — unavailable (${result.reason})`)
    return
  }
  console.log(`[verify] AU asset usage — judged: ${result.passed ? 'PASS' : 'FAIL'} — ${result.reason}`)
}

function logAssertionsResult(result) {
  if (result.status === 'absent') {
    console.log(`[verify] IA assertions — absent (${result.reason})`)
    return
  }
  if (result.status === 'unavailable') {
    console.log(`[verify] IA assertions — unavailable (${result.reason})`)
    return
  }
  console.log(`[verify] IA assertions — judged: ${result.passedCount}/${result.total} passed`)
  // trigger-integrity-and-onscreen-gate task 1.2 / design D3: "not checked"
  // must be visible, never silent — see assert.mjs's checkTriggerIntegrityAvailability().
  if (result.triggerIntegrityCheck && !result.triggerIntegrityCheck.ran) {
    console.log(`  NOTE  trigger-integrity check (A) did not run: ${result.triggerIntegrityCheck.reason}`)
  }
  for (const r of result.results) {
    if (r.passed) {
      console.log(`  PASS  ${r.itemId} (${r.templateId})`)
    } else {
      console.log(`  FAIL  ${r.itemId} (${r.templateId})`)
      console.log(`        expected: ${r.failure.expected}`)
      console.log(`        actual:   ${r.failure.actual}`)
      if (r.failure.hint) console.log(`        hint:     ${r.failure.hint}`)
    }
  }
}

main().catch((err) => {
  if (err instanceof VerifyFailure) {
    // fail() already printed the failure, recorded the gate, wrote the
    // result file, and set process.exitCode = 1 — by the time we're here,
    // main()'s own `finally` (task 4.1/4.2) has ALSO already run, because
    // `finally` always completes before an async function's rejection
    // propagates out of it. The throw's only job was to force that unwind
    // instead of skipping it via `process.exit()`. Nothing left to do here
    // — printing a second "[verify] Unexpected error" would misrepresent an
    // already-reported gate failure as a crash.
    return
  }
  console.error('[verify] Unexpected error:', err)
  process.exitCode = 1
})
