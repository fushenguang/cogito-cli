#!/usr/bin/env node
// selfcheck.mjs — the postbuild FULL-CHAIN playtest gate (issue #B4, 2026-09-01).
//
// 🔴 THE GATE'S REASON FOR EXISTING — the 小小财迷 M1 verdict
// (cogito-lib apps/docs/content/docs/eval-reports/caimi-m1-task2-eval.mdx):
// 16 modules were individually green while the game a real player opened was
// 「垃圾游戏」, because every assertion judged the INSTRUMENT path
// (`applyState()`, scene-list scans, registry reads) and none of them drove
// the PLAYER path. This script is the structural inversion: it plays the
// shipped artifact the way a player does and fails the build when the chain
// breaks. It runs as part of `build:play` (package.json), so "the factory
// floor is playable" is re-proven in the real delivery environment on every
// build — not once, not on the dev machine only.
//
// The chain, one real input at a time:
//
//   SC-1  the page loads with zero runtime exceptions (same-session BH-1)
//   SC-2  boot lands on the Start state with a real, mounted start button
//   SC-3  the Start title is PIXEL-VISIBLE (screenshot ink analysis, not DOM
//         presence — a node with `display:none` passes a DOM query)
//   SC-4  a real CDP mouse click on [data-cogito="start"] → Game state
//   SC-5  the world actually has the tutorial's named entities (player, goal)
//   SC-6  holding ArrowRight + periodic jumps (real CDP key events, the
//         bouncing-walker strategy — see planJumpTaps) reaches the goal:
//         GameOver state with data-cogito-result="cleared"
//   SC-7  the GameOver title is pixel-visible
//   SC-8  clicking 回标题页 returns to the Start state (重开回 Start)
//
// Every step prints PASS/FAIL with its evidence and drops screenshots into
// .selfcheck/ for a human to eyeball afterwards. Any FAIL → exit 1 → the
// `build:play` composite script fails → the build is red.
//
// 🔴 Player path, not instrument path: `window.__gameHarness` is used ONLY
// as a read-only observation channel (getSnapshot/stateId). NOTHING is
// driven through it — no applyState(), no press(), no fire(). All input is
// CDP `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`, the same trusted
// input pipeline a real keyboard/mouse feeds. This is the exact boundary the
// M1 eval report drew, encoded as a gate.
//
// The walk strategy's contract with the template (recorded in AGENTS.md as
// the 首关机通 invariant): `levels[0]` must be completable by holding right
// with periodic jumps. The factory's tutorial level satisfies it by
// construction (ground path unobstructed, hazards only on floating
// platforms). A project that designs level 1 around traversal this walker
// can't do is changing that invariant deliberately, not discovering a bug.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBrowser } from './lib/find-browser.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { launchBrowser } from './lib/browser-launch.mjs'
import { inspectPage } from './lib/inspect-page.mjs'
import { decodePng } from './lib/png.mjs'
import { regionInkStats } from './lib/ink.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DIST_DIR = join(PROJECT_ROOT, 'dist-play')
const ARTIFACT_DIR = join(PROJECT_ROOT, '.selfcheck')

const SETTLE_MS = 800
const WALK_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 250
const JUMP_INTERVAL_MS = 800
const JUMP_HOLD_MS = 200
const MIN_TITLE_INK = 0.05
const MAX_CONTROL_INK = 0.02

// ───────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested in tests/selfcheck.test.mjs)
// ───────────────────────────────────────────────────────────────────────

/**
 * The bouncing-walker jump schedule: a keyDown at every `intervalMs` from
 * the first `intervalMs` (walk a beat before the first hop), each held for
 * `holdMs`, until `horizonMs`. Pure so the timing contract can be tested
 * without a browser.
 *
 * @param {number} horizonMs total planning horizon
 * @param {number} intervalMs between jump starts
 * @param {number} holdMs how long each jump key is held
 * @returns {{ atMs: number, holdMs: number }[]}
 */
export function planJumpTaps(horizonMs, intervalMs, holdMs) {
  const taps = []
  for (let at = intervalMs; at + holdMs <= horizonMs; at += intervalMs) {
    taps.push({ atMs: at, holdMs })
  }
  return taps
}

/**
 * Scales a CSS-pixel rect to screenshot pixels (devicePixelRatio ≠ 1 makes
 * Page.captureScreenshot pixels ≠ CSS pixels).
 *
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} dpr
 */
export function scaleRect(rect, dpr) {
  return { x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr }
}

/** Center of a rect (where a mouse click lands). */
export function rectCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

// ───────────────────────────────────────────────────────────────────────
// The gate
// ───────────────────────────────────────────────────────────────────────

/** Collects per-step outcomes; later steps can be SKIPPED after a FAIL. */
function makeStepRunner() {
  const results = []
  let chainBroken = false
  return {
    results,
    /**
     * @param {string} id e.g. 'SC-3'
     * @param {string} name short human description
     * @param {() => Promise<string>} body resolves with PASS evidence;
     *   throws to FAIL (message = evidence)
     */
    async step(id, name, body) {
      if (chainBroken) {
        results.push({ id, name, status: 'SKIPPED', evidence: 'an earlier step failed' })
        console.log(`[selfcheck] ${id} ${name} — SKIPPED (earlier failure)`)
        return
      }
      try {
        const evidence = await body()
        results.push({ id, name, status: 'PASS', evidence })
        console.log(`[selfcheck] ${id} ${name} — PASS (${evidence})`)
      } catch (err) {
        results.push({ id, name, status: 'FAIL', evidence: err.message })
        console.error(`[selfcheck] ${id} ${name} — FAIL: ${err.message}`)
        chainBroken = true
      }
    },
  }
}

/** @param {{ send: (method: string, params: unknown, sessionId: string) => Promise<any> }} client */
function makeEvalIn(client, sessionId) {
  return async (expression) => {
    const res = await client.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (res.exceptionDetails) {
      throw new Error(`page threw while evaluating: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`)
    }
    return res.result.value
  }
}

async function main() {
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    console.error('[selfcheck] dist-play/index.html not found — run the full `pnpm build:play` (build + selfcheck), not `node scripts/selfcheck.mjs` alone.')
    process.exitCode = 1
    return
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true })

  const browser = resolveBrowser()
  const { server, url } = await startStaticServer(DIST_DIR)
  const launched = await launchBrowser(browser)
  const runner = makeStepRunner()
  let client = null

  try {
    const inspected = await inspectPage(launched.wsUrl, url)
    client = inspected.client
    const { sessionId } = inspected
    const evalIn = makeEvalIn(client, sessionId)

    /** @param {string} name */
    const shot = async (name) => {
      const captured = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      const bytes = Buffer.from(captured.data, 'base64')
      const path = join(ARTIFACT_DIR, name)
      writeFileSync(path, bytes)
      return { path, base64: captured.data, bytes }
    }

    /**
     * Poll `probe` until it returns a truthy value or the timeout hits.
     * `onTick` runs every poll (where the walker's jump keys get sent).
     * 🔴 `probe` must return null/undefined while the condition is NOT met —
     * a probe like `readState` (which always returns a non-empty string)
     * resolves on the very first poll with whatever the current value is,
     * turning the wait into a zero-timeout snapshot. That exact bug shipped
     * the first version of SC-8: it "waited" 0ms, read GameOver, and failed.
     * @param {string} what human description of the awaited condition
     * @param {() => Promise<unknown>} probe
     * @param {{ timeoutMs?: number, onTick?: () => Promise<void> }} [opts]
     */
    const pollUntil = async (what, probe, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 5000
      const deadline = Date.now() + timeoutMs
      let lastRead = '(no reading yet)'
      while (Date.now() < deadline) {
        if (opts.onTick) await opts.onTick()
        const value = await probe()
        if (value) return value
        lastRead = JSON.stringify(value)
        await evalIn(`new Promise((r) => setTimeout(r, ${POLL_INTERVAL_MS}))`)
      }
      throw new Error(`${what} — not reached within ${timeoutMs}ms (last reading: ${lastRead})`)
    }

    const readState = () => evalIn('window.__gameHarness ? window.__gameHarness.getSnapshot().stateId : "(no harness)"')
    /** pollUntil-compatible: resolves the stateId only once it equals `expected`. */
    const waitForState = (expected) => async () => ((await readState()) === expected ? expected : null)
    const readResult = () =>
      evalIn(
        '(document.querySelector("#cogito-screens [data-cogito-result]") || {getAttribute: () => null}).getAttribute("data-cogito-result")',
      )

    const snapshotValue = async () =>
      JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.getSnapshot())'))

    // In-page rect reader for the copy-role / button-role anchors.
    const readRect = (selector) =>
      evalIn(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
          'if (!el) return null; const r = el.getBoundingClientRect();' +
          'return { x: r.left, y: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 } })()',
      )

    const clickCenter = async (selector) => {
      const rect = await readRect(selector)
      if (rect === null) throw new Error(`no element matches ${selector} — cannot click`)
      if (rect.width <= 0 || rect.height <= 0) throw new Error(`${selector} has an empty rect — it exists but is not visible`)
      const c = rectCenter(rect)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send(
          'Input.dispatchMouseEvent',
          { type, x: c.x, y: c.y, button: 'left', clickCount: 1 },
          sessionId,
        )
      }
    }

    const keyEvent = (type, { key, code, vk }) =>
      client.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId)

    const holdArrowRight = () => keyEvent('keyDown', { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
    const releaseArrowRight = () => keyEvent('keyUp', { key: 'ArrowRight', code: 'ArrowRight', vk: 39 })
    const tapJump = async (holdMs = JUMP_HOLD_MS) => {
      await keyEvent('keyDown', { key: 'ArrowUp', code: 'ArrowUp', vk: 38 })
      await new Promise((r) => setTimeout(r, holdMs))
      await keyEvent('keyUp', { key: 'ArrowUp', code: 'ArrowUp', vk: 38 })
    }

    /**
     * SC-3/SC-7 shared pixel assertion: the copy node's rect must contain
     * visible ink AND the page's top-left corner (pure backdrop) must not —
     * the positive/negative control pair from scripts/lib/ink.mjs's doc.
     * @param {string} selector
     * @param {string} shotName
     * @param {number} minInk
     */
    const assertCopyPixels = async (selector, shotName, minInk) => {
      const rect = await readRect(selector)
      if (rect === null) throw new Error(`no element matches ${selector}`)
      if (rect.width < 4 || rect.height < 4) throw new Error(`${selector} rect is ${rect.width}x${rect.height} — too small to assert pixels on`)
      const { base64 } = await shot(shotName)
      const decoded = decodePng(base64)
      const titleStats = regionInkStats(decoded, scaleRect(rect, rect.dpr))
      const controlStats = regionInkStats(decoded, scaleRect({ x: 8, y: 8, width: 40, height: 40 }, rect.dpr))
      if (controlStats.inkRatio > MAX_CONTROL_INK) {
        throw new Error(
          `negative control reads inkRatio=${controlStats.inkRatio.toFixed(4)} (> ${MAX_CONTROL_INK}) — the measurement itself is polluted, do not trust this run; screenshot: ${shotName}`,
        )
      }
      if (titleStats.inkRatio < minInk) {
        throw new Error(
          `inkRatio=${titleStats.inkRatio.toFixed(4)} < ${minInk} over the node's ${Math.round(rect.width)}x${Math.round(rect.height)} rect ` +
            `(modal rgb ${titleStats.modalColor.join(',')}, sampled ${titleStats.sampled}px) — the node exists but draws no visible text; screenshot: ${shotName}`,
        )
      }
      return `ink ${titleStats.inkRatio.toFixed(3)} / control ${controlStats.inkRatio.toFixed(3)}; screenshot: ${shotName}`
    }

    await runner.step('SC-1', 'page loads without exceptions', async () => {
      if (inspected.exceptions.length > 0) {
        throw new Error(`runtime exceptions:\n  ${inspected.exceptions.join('\n  ')}`)
      }
      return '0 exceptions'
    })

    await runner.step('SC-2', 'boot lands on Start with a real start button', async () => {
      const stateId = await pollUntil('Start state after boot', waitForState('Start'), { timeoutMs: 10_000 })
      if (stateId !== 'Start') throw new Error(`stateId is "${stateId}", expected "Start"`)
      const rect = await readRect('#cogito-screens [data-cogito="start"]')
      if (rect === null) throw new Error('no [data-cogito="start"] button mounted — the Start page did not render')
      if (rect.width <= 0 || rect.height <= 0) throw new Error(`start button rect is ${rect.width}x${rect.height} — mounted but not visible`)
      return `stateId=Start, button ${Math.round(rect.width)}x${Math.round(rect.height)}px`
    })

    await runner.step('SC-3', 'Start title pixels are visible', async () =>
      assertCopyPixels('#cogito-screens [data-cogito-copy="start-title"]', '01-start.png', MIN_TITLE_INK))

    await runner.step('SC-4', 'real click on 开始游戏 enters the Game state', async () => {
      await clickCenter('#cogito-screens [data-cogito="start"]')
      const stateId = await pollUntil('Game state after the click', waitForState('Game'), { timeoutMs: 10_000 })
      if (stateId !== 'Game') throw new Error(`after clicking, stateId is "${stateId}", expected "Game"`)
      return 'stateId=Game'
    })

    await runner.step('SC-5', 'tutorial world has player and goal', async () => {
      const snapshot = await snapshotValue()
      const names = snapshot.entities.map((e) => e.name)
      const missing = ['player', 'goal'].filter((n) => !names.includes(n))
      if (missing.length > 0) {
        throw new Error(`snapshot entities [${names.join(', ')}] are missing: ${missing.join(', ')}`)
      }
      await shot('02-game.png')
      return `entities: ${names.join(', ')}; score=${snapshot.score}; screenshot: 02-game.png`
    })

    await runner.step('SC-6', 'real input walk reaches the goal (cleared)', async () => {
      // settle: scene create + first physics frames must be done before input
      await evalIn(`new Promise((r) => setTimeout(r, ${SETTLE_MS}))`)
      await holdArrowRight()
      try {
        const taps = planJumpTaps(WALK_TIMEOUT_MS, JUMP_INTERVAL_MS, JUMP_HOLD_MS)
        let tapIndex = 0
        const walkStart = Date.now()
        const finish = await pollUntil(
          'GameOver(cleared)',
          async () => {
            if ((await readState()) !== 'GameOver') return null
            return (await readResult()) === 'cleared' ? 'cleared' : null
          },
          {
            timeoutMs: WALK_TIMEOUT_MS,
            onTick: async () => {
              const elapsed = Date.now() - walkStart
              while (tapIndex < taps.length && elapsed >= taps[tapIndex].atMs) {
                await tapJump(taps[tapIndex].holdMs)
                tapIndex += 1
              }
            },
          },
        )
        const snapshot = await snapshotValue()
        return `${finish} in ${((Date.now() - walkStart) / 1000).toFixed(1)}s; final score=${snapshot.score}`
      } finally {
        await releaseArrowRight()
      }
    })

    await runner.step('SC-7', 'GameOver title pixels are visible', async () =>
      assertCopyPixels('#cogito-screens [data-cogito-copy="gameover-title"]', '03-gameover.png', 0.04))

    await runner.step('SC-8', '回标题页 returns to the Start state', async () => {
      await clickCenter('#cogito-screens [data-cogito="back-title"]')
      const stateId = await pollUntil('Start state after 回标题页', waitForState('Start'), { timeoutMs: 10_000 })
      if (stateId !== 'Start') throw new Error(`after clicking 回标题页, stateId is "${stateId}", expected "Start"`)
      const rect = await readRect('#cogito-screens [data-cogito="start"]')
      if (rect === null) throw new Error('Start page did not re-mount its start button')
      await shot('04-restart.png')
      return 'stateId=Start, start button re-mounted; screenshot: 04-restart.png'
    })

    const failed = runner.results.filter((r) => r.status === 'FAIL')
    const skipped = runner.results.filter((r) => r.status === 'SKIPPED')
    console.log(`\n[selfcheck] ${runner.results.length - skipped.length - failed.length} pass / ${failed.length} fail / ${skipped.length} skipped — artifacts in .selfcheck/`)
    if (failed.length > 0 || skipped.length > 0) process.exitCode = 1
  } finally {
    // 🔴 Kill by the handle we hold, never by name/substring — same rule as
    // scripts/playtest.mjs (an orphaned headless Chromium outlives this process).
    if (client) client.close()
    launched.proc.kill()
    server.close()
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMainModule) {
  main().catch((err) => {
    console.error('[selfcheck] could not run the chain:', err.message)
    process.exitCode = 1
  })
}
