#!/usr/bin/env node
// playtest.mjs — drive the shipped artifact through `window.__gameHarness` and
// print the numbers, so an agent can answer "is the goal actually reachable?"
// before it says "done".
//
// 🔴 This is an INSTRUMENT, not a gate. It never judges whether the game is
// good, fun, or correct — it applies a state, presses the keys you name, and
// prints the numbers. Exit code is 0 whenever it managed to run; non-zero only
// means "I could not observe anything" (no build, no browser, no harness).
// Do not add pass/fail logic here: `scripts/verify.mjs` owns the gates, and
// the whole reason this file exists is that the gates can be green while the
// game is unplayable.
//
// 🔴 **"Prints the numbers" is meant literally, and the first version of this
// file broke it.** It annotated every unchanged entity with `<- did not move`,
// and the template's AGENTS.md told readers that meant "this control key is
// dead". Measured on a real run: the annotation fired on `goal` — the level's
// target object, which is *supposed* to stay put — with the exact same wording
// used for a broken control. A script that cannot know which entities ought to
// move must not phrase anything as a verdict. `dx=0.0` is a reading;
// "did not move" is a conclusion. Print the former, never the latter.
//
// ## Why this exists as a script instead of prose in the task text
//
// Upstream (cogito-lib) used to hand the agent a ~20-line recipe telling it to
// write its own CDP/eval expressions. Measured on a real run (2026-08-22,
// 453 messages): 3 of the 7 real blockers in that run were mistakes inside
// those hand-written expressions — `Illegal return statement`,
// `Phaser is not defined`, and calling `.then()` on the synchronous
// `getSnapshot()`. None of them were about the game.
//
// Every one of those disappears if the loop is a shipped script instead of a
// recipe, and every new project scaffolded from this template gets it for free.
//
// ## Usage
//
//   node scripts/playtest.mjs                       # auto-pick the gameplay state
//   node scripts/playtest.mjs --state Level3
//   node scripts/playtest.mjs --state Level3 --press ArrowRight,Space --ms 800
//   node scripts/playtest.mjs --trigger goal_reached
//
// Options:
//   --state <id>     state to jump to (default: last state whose role is 'gameplay')
//   --press <keys>   comma-separated keys to press, in order (default: none)
//   --ms <n>         how long each key is held, in ms (default: 600)
//   --settle <n>     how long to wait after a state jump / key press (default: 400)
//   --trigger <name> fire a registered trigger after the presses
//   --shot <path>    where to write the screenshot (default: .playtest-screenshot.png)
//   --seed <n>       seed passed to applyState (default: 1)

import { writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBrowser } from './lib/find-browser.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { launchBrowser } from './lib/browser-launch.mjs'
import { inspectPage } from './lib/inspect-page.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DIST_DIR = join(PROJECT_ROOT, 'dist-play')

/**
 * 🔴 `applyState()` resolves BEFORE the new scene is live. Measured on this
 * very template: `applyState('Game', 1)` returns `true`, and a `getSnapshot()`
 * issued immediately afterwards still reports the OLD `stateId`; ~300ms later
 * it reports the new one. Reading too early makes a working jump look broken,
 * which sends you off fixing something that isn't wrong.
 *
 * 400 is 300 plus headroom. Override with `--settle` if a project's boot chain
 * is slower — but never drop it to 0.
 */
const DEFAULT_SETTLE_MS = 400
const DEFAULT_PRESS_MS = 600

/**
 * Parse argv into options. Pure — `tests/playtest-args.test.mjs` covers it, so
 * the argument handling can't rot silently while the browser half is the part
 * nobody unit-tests.
 *
 * @param {readonly string[]} argv tokens after `node playtest.mjs`
 * @returns {{state: string|null, press: string[], pressMs: number, settleMs: number,
 *            trigger: string|null, shot: string, seed: number}}
 */
export function parseArgs(argv) {
  const opts = {
    state: null,
    press: [],
    pressMs: DEFAULT_PRESS_MS,
    settleMs: DEFAULT_SETTLE_MS,
    trigger: null,
    shot: '.playtest-screenshot.png',
    seed: 1,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--state' && value) { opts.state = value; i += 1 }
    else if (flag === '--press' && value) { opts.press = value.split(',').map((k) => k.trim()).filter(Boolean); i += 1 }
    else if (flag === '--ms' && value) { opts.pressMs = Number(value); i += 1 }
    else if (flag === '--settle' && value) { opts.settleMs = Number(value); i += 1 }
    else if (flag === '--trigger' && value) { opts.trigger = value; i += 1 }
    else if (flag === '--shot' && value) { opts.shot = value; i += 1 }
    else if (flag === '--seed' && value) { opts.seed = Number(value); i += 1 }
  }
  return opts
}

/**
 * Pick which state to jump to when `--state` was not given: the LAST state
 * whose role is `gameplay`. Last, not first — a multi-level game lists its
 * levels in order, and "can the player still reach the goal in the final
 * level?" is the question worth asking automatically.
 *
 * Returns `null` when there is no gameplay state at all, which the caller
 * reports rather than guessing.
 *
 * @param {readonly {id: string, role: string}[]} states
 * @returns {string|null}
 */
export function pickDefaultState(states) {
  const gameplay = states.filter((s) => s.role === 'gameplay')
  const chosen = gameplay.length > 0 ? gameplay[gameplay.length - 1] : null
  return chosen ? chosen.id : null
}

/**
 * Diff two entity lists by name. Entities that appeared or disappeared are
 * reported as such — not silently skipped, because "the player object stopped
 * existing" is exactly the kind of thing this script is for.
 *
 * @param {readonly {name: string, x: number, y: number}[]} before
 * @param {readonly {name: string, x: number, y: number}[]} after
 * @returns {string[]} one human-readable line per entity
 */
export function formatEntityDelta(before, after) {
  const beforeByName = new Map(before.map((e) => [e.name, e]))
  const afterByName = new Map(after.map((e) => [e.name, e]))
  const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort()

  return names.map((name) => {
    const b = beforeByName.get(name)
    const a = afterByName.get(name)
    if (!b) return `  + ${name}: (—) -> (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`
    if (!a) return `  - ${name}: (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) -> (—)`
    const dx = a.x - b.x
    const dy = a.y - b.y
    // `~` / `=` are state markers (changed / unchanged), not verdicts — one glyph
    // saying what the numbers already say. Nothing here appends prose: see this
    // file's header for why the first version's `<- did not move` was wrong.
    const changed = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5
    return (
      `  ${changed ? '~' : '='} ${name}: (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) -> ` +
      `(${a.x.toFixed(1)}, ${a.y.toFixed(1)})  dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`
    )
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    console.error('[playtest] dist-play/index.html not found — run `pnpm build:play` first.')
    process.exitCode = 1
    return
  }

  const browser = resolveBrowser()
  const { server, url } = await startStaticServer(DIST_DIR)
  const launched = await launchBrowser(browser)
  let client = null

  try {
    const inspected = await inspectPage(launched.wsUrl, url)
    client = inspected.client
    const { sessionId } = inspected

    const evalIn = async (expression) => {
      const res = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      if (res.exceptionDetails) {
        throw new Error(
          `page threw while evaluating: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`,
        )
      }
      return res.result.value
    }

    const harnessVersion = await evalIn('window.__gameHarness ? window.__gameHarness.version : null')
    if (harnessVersion === null) {
      console.error('[playtest] window.__gameHarness is not present in this build — cannot observe anything.')
      process.exitCode = 1
      return
    }

    const states = JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.listStates())'))
    const triggers = JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.listTriggers())'))

    console.log('=== playtest ===')
    console.log(`harness version : ${harnessVersion}`)
    console.log(`states          : ${states.map((s) => `${s.id}(${s.role})`).join(', ')}`)
    console.log(`triggers        : ${triggers.length > 0 ? triggers.join(', ') : '(none registered)'}`)

    const targetState = opts.state ?? pickDefaultState(states)
    if (targetState === null) {
      console.log('\nno gameplay state to jump to (listStates() reported none) — nothing else to observe.')
      return
    }

    const applied = await evalIn(
      `window.__gameHarness.applyState(${JSON.stringify(targetState)}, ${opts.seed})`,
    )
    // See DEFAULT_SETTLE_MS's doc: applyState resolves before the scene is live.
    await evalIn(`new Promise((r) => setTimeout(() => r(1), ${opts.settleMs}))`)
    const snapshotAfterJump = JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.getSnapshot())'))

    console.log(`\napplyState(${JSON.stringify(targetState)}, ${opts.seed}) -> ${applied}`)
    console.log(`  stateId after ${opts.settleMs}ms : ${snapshotAfterJump.stateId}`)
    if (snapshotAfterJump.stateId !== targetState) {
      // Factual mismatch, stated as a mismatch — not "the jump failed".
      console.log(`  (requested "${targetState}", reading "${snapshotAfterJump.stateId}")`)
    }
    console.log(`  score          : ${snapshotAfterJump.score}`)
    console.log(`  hudTexts       : ${JSON.stringify(snapshotAfterJump.hudTexts)}`)
    console.log(`  worldBounds    : ${JSON.stringify(snapshotAfterJump.worldBounds)}`)
    console.log(`  entities       : ${JSON.stringify(snapshotAfterJump.entities)}`)

    let previous = snapshotAfterJump
    for (const key of opts.press) {
      await evalIn(
        `window.__gameHarness.press(${JSON.stringify(key)}, { durationMs: ${opts.pressMs} }).then(() => 1)`,
      )
      await evalIn(`new Promise((r) => setTimeout(() => r(1), ${opts.settleMs}))`)
      const next = JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.getSnapshot())'))
      console.log(`\npress(${JSON.stringify(key)}, { durationMs: ${opts.pressMs} })`)
      console.log(`  stateId : ${previous.stateId} -> ${next.stateId}`)
      console.log(`  score   : ${previous.score} -> ${next.score}`)
      for (const line of formatEntityDelta(previous.entities, next.entities)) console.log(line)
      previous = next
    }

    if (opts.trigger !== null) {
      try {
        await evalIn(`window.__gameHarness.fire(${JSON.stringify(opts.trigger)}).then(() => 1)`)
        await evalIn(`new Promise((r) => setTimeout(() => r(1), ${opts.settleMs}))`)
        const next = JSON.parse(await evalIn('JSON.stringify(window.__gameHarness.getSnapshot())'))
        console.log(`\nfire(${JSON.stringify(opts.trigger)})`)
        console.log(`  stateId : ${previous.stateId} -> ${next.stateId}`)
        console.log(`  score   : ${previous.score} -> ${next.score}`)
        for (const line of formatEntityDelta(previous.entities, next.entities)) console.log(line)
        previous = next
      } catch (err) {
        // A trigger that doesn't exist is information, not a crash — print it
        // and keep going so the screenshot still gets written.
        console.log(`\nfire(${JSON.stringify(opts.trigger)}) failed: ${err.message}`)
      }
    }

    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const bytes = Buffer.from(shot.data, 'base64')
    writeFileSync(join(PROJECT_ROOT, opts.shot), bytes)
    console.log(`\nscreenshot -> ${opts.shot} (${bytes.length} bytes)`)
    console.log('\n=== end playtest ===')
  } finally {
    // 🔴 Kill by the handle we hold, never by name/substring, and always in
    // `finally` — an orphaned headless Chromium survives the process that
    // spawned it. The field is `proc` (see lib/browser-launch.mjs's JSDoc);
    // guessing a different field name silently no-ops the cleanup.
    if (client) client.close()
    launched.proc.kill()
    server.close()
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMainModule) {
  main().catch((err) => {
    console.error('[playtest] could not observe the artifact:', err.message)
    process.exitCode = 1
  })
}
