#!/usr/bin/env node
// assert.mjs — the IA (item assertion) judgement layer, design D4-D6.
//
// This module has two jobs, kept in one file because tasks.md's wave 3 names
// it that way and both halves are small:
//
//   1. `runAssertions()` — read the project's `assertions.json`, drive the
//      live game through `window.__gameHarness` over an already-open CDP
//      session, and judge each of the 8 upstream templates. This is what
//      `scripts/verify.mjs` calls, in-process, right after BH-2 (design D7 —
//      one browser session for the whole run).
//   2. A standalone CLI entry (`node scripts/assert.mjs`) for developing this
//      file itself without re-running the full BH-0..BH-2 build/load/render
//      pipeline. This path opens its own browser — see design D7's "那条路径
//      自己起浏览器".
//
// 🔴 Three outcomes, never collapsed into each other (design D4 / proposal):
//   - `absent`      — no assertions.json. Not a failure, not a pass.
//   - `unavailable` — a clean assertions.json exists but nothing could judge
//                      it (harness missing/wrong version, file malformed,
//                      judging itself crashed). Not a failure, not a pass.
//   - `judged`       — every item got a real pass/fail. THIS is the only
//                      status where `results[].passed` means anything.
// Within `judged`, a further distinction that must also never collapse:
// a `passed: false` item can mean "the game is broken" OR "this assertion's
// own precondition (a named trigger, a reachable state, a values[] key)
// isn't there" (design D5's "假 bug 比没测试更糟"). Both produce
// `passed: false` — the only place the difference survives is `hint`, which
// always says "前提不满足（不是产物缺陷）" for the second kind. Never silently
// treat one as the other.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveBrowser } from './lib/find-browser.mjs'
import { startStaticServer } from './lib/static-server.mjs'
import { launchBrowser } from './lib/browser-launch.mjs'
import { inspectPage } from './lib/inspect-page.mjs'
import { decideExitCode } from './lib/exit-decision.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(__dirname, '..')
const DIST_DIR = join(PROJECT_ROOT, 'dist-play')
const ASSERTIONS_FILE = join(PROJECT_ROOT, 'assertions.json')

/**
 * The only `assertions.json` shape this runner accepts (design D4). A new
 * template id must be added to `TEMPLATE_DESCRIBERS` below (and to
 * `KNOWN_TEMPLATE_IDS`, which is derived from it) before it can appear here —
 * an id this runner doesn't recognise makes the whole file `unavailable`,
 * the same as any other "format not recognised" case (task 3.1).
 */
const ASSERTIONS_SCHEMA_VERSION = 1

// ───────────────────────────────────────────────────────────────────────
// Template registry — mirrors cogito-lib's describe() output verbatim
// ───────────────────────────────────────────────────────────────────────

/**
 * 🔴 This is a manually-synced mirror of
 * `apps/web/src/features/workspace/assertion-templates.ts`'s `describe()`
 * functions in the cogito-lib repo (upstream of this template). It is NOT
 * imported from there — these are two different repos on two different
 * release cadences, the same reason `apps/agent-server/src/schema.ts` keeps
 * its own copy of `AssertionTemplateId` instead of importing the web one.
 *
 * `AssertionFailure.expected` (upstream's contract type,
 * `apps/web/src/core/types/workspace.ts`) is documented as "exactly the
 * string `describe(params)` produces" — so if upstream ever changes the
 * wording here, this file drifts and needs a manual re-sync. There is no
 * mechanical guard against that drift today; it would need a cross-repo test,
 * which is out of scope for this change.
 *
 * The `「…」` characters are full-width Chinese corner brackets (U+300C /
 * U+300D), not straight quotes — copied character-for-character from
 * upstream, not retyped.
 */
const TEMPLATE_DESCRIBERS = {
  loads_clean: () => '页面加载完成后，无未捕获异常、无失败的资源请求',
  restart: (p) => `触发「${p.trigger}」后，状态回到 PLAYING 且分数归零`,
  controllable: (p) => `按下「${p.key}」后，主体对象坐标发生变化`,
  score_feedback: (p) => `达成「${p.condition}」后，界面上的分数文本发生变化`,
  game_over_trigger: (p) => `满足「${p.condition}」后，进入 GAMEOVER 状态`,
  hud_text_present: (p) => `处于「${p.state}」状态时，界面上能看到「${p.text}」`,
  value_persists: (p) => `从「${p.from}」切到「${p.to}」时，「${p.value}」不被重置`,
  // 🔴 game-data-spine design D6: verbatim mirror of upstream data-layer-gate
  // design D1's zero-param describe() — do not paraphrase. Zero params by
  // design: this template judges a FORM (content-in-data), not a
  // parameterized behavior, so there is nothing for params to select.
  data_from_files: () => '玩法内容（关卡/规则/词表）定义在独立数据文件中，且运行时实际从数据文件加载（场景代码不承载内容定义）',
}

export const KNOWN_TEMPLATE_IDS = new Set(Object.keys(TEMPLATE_DESCRIBERS))

function describeTemplate(templateId, params) {
  const fn = TEMPLATE_DESCRIBERS[templateId]
  if (!fn) throw new Error(`assert.mjs: no describe() mirror registered for templateId "${templateId}"`)
  return fn(params ?? {})
}

// ───────────────────────────────────────────────────────────────────────
// assertions.json parsing — task 3.1: absent vs. unavailable, never a failure
// ───────────────────────────────────────────────────────────────────────

/**
 * @returns {{ status: 'absent' } | { status: 'unavailable', reason: string } | { status: 'ok', assertions: readonly { itemId: string, templateId: string, params: Record<string,string> }[] }}
 */
export function readAssertionsFile(projectRoot = PROJECT_ROOT) {
  const filePath = join(projectRoot, 'assertions.json')
  if (!existsSync(filePath)) {
    return { status: 'absent' }
  }

  let raw
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { status: 'unavailable', reason: `could not read assertions.json: ${err.message}` }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'unavailable', reason: `assertions.json is not valid JSON: ${err.message}` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unavailable', reason: 'assertions.json must be a JSON object with "schemaVersion" and "assertions"' }
  }
  if (parsed.schemaVersion !== ASSERTIONS_SCHEMA_VERSION) {
    return {
      status: 'unavailable',
      reason: `unrecognized assertions.json schemaVersion ${JSON.stringify(parsed.schemaVersion)} (this runner only understands ${ASSERTIONS_SCHEMA_VERSION})`,
    }
  }
  if (!Array.isArray(parsed.assertions)) {
    return { status: 'unavailable', reason: 'assertions.json "assertions" field must be an array' }
  }

  for (const [index, item] of parsed.assertions.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { status: 'unavailable', reason: `assertions.json assertions[${index}] is not an object` }
    }
    if (typeof item.itemId !== 'string' || item.itemId.length === 0) {
      return { status: 'unavailable', reason: `assertions.json assertions[${index}].itemId must be a non-empty string` }
    }
    if (!KNOWN_TEMPLATE_IDS.has(item.templateId)) {
      return {
        status: 'unavailable',
        reason: `assertions.json assertions[${index}].templateId "${item.templateId}" is not a recognized template id (known: ${[...KNOWN_TEMPLATE_IDS].join(', ')})`,
      }
    }
    if (item.params === undefined || item.params === null || typeof item.params !== 'object' || Array.isArray(item.params)) {
      return { status: 'unavailable', reason: `assertions.json assertions[${index}].params must be an object` }
    }
  }

  return { status: 'ok', assertions: parsed.assertions }
}

// ───────────────────────────────────────────────────────────────────────
// RemoteHarness — marshals GameHarness calls over an existing CDP session
// ───────────────────────────────────────────────────────────────────────

/**
 * Every `window.__gameHarness` call this runner needs, driven over CDP
 * `Runtime.evaluate`. There is no way to hold a live JS reference across the
 * Node <-> browser process boundary, so each call is serialised as a string
 * expression and evaluated in the page — the same technique verify.mjs
 * already uses for the canvas-size probe.
 *
 * 🔴 This class only ever calls methods that already exist on `GameHarness`
 * (`src/debug/harness-types.ts`). It adds zero new capability to the game —
 * it's a transport, not an extension of the contract.
 */
export class RemoteHarness {
  constructor(client, sessionId) {
    this.client = client
    this.sessionId = sessionId
  }

  async eval(expression) {
    const result = await this.client.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    )
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails
      const desc = ex.exception?.description ?? ex.text ?? JSON.stringify(ex)
      throw new Error(desc)
    }
    return result.result?.value
  }

  async exists() {
    return this.eval(`typeof window.__gameHarness === 'object' && window.__gameHarness !== null`)
  }

  async version() {
    return this.eval(`window.__gameHarness.version`)
  }

  async getSnapshot() {
    return this.eval(`window.__gameHarness.getSnapshot()`)
  }

  async listStates() {
    return this.eval(`window.__gameHarness.listStates()`)
  }

  async listTriggers() {
    return this.eval(`window.__gameHarness.listTriggers()`)
  }

  async press(key, opts) {
    const args = opts ? `${JSON.stringify(key)}, ${JSON.stringify(opts)}` : JSON.stringify(key)
    await this.eval(`window.__gameHarness.press(${args})`)
  }

  async fire(trigger) {
    await this.eval(`window.__gameHarness.fire(${JSON.stringify(trigger)})`)
  }

  async applyState(id, seed) {
    const args = seed !== undefined ? `${JSON.stringify(id)}, ${seed}` : JSON.stringify(id)
    // 🔴 game-data-spine hardening: `harness.ts`'s `applyState()` resolves
    // only when the target scene's CREATE event fires. If the scene's own
    // `create()` throws (any executor bug — including a scene consuming a
    // `game-data.json` section the manifest doesn't declare), CREATE never
    // fires and a bare eval would hang this whole verify run forever. The
    // timeout converts that hang into a thrown error, which
    // `runAssertions()`'s crash handler reports as a red `unavailable`
    // instead of a silent stall. Only `applyState` gets this: every other
    // eval here resolves on its own timers.
    const evalPromise = this.eval(`window.__gameHarness.applyState(${args})`)
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`applyState("${id}") timed out after ${APPLY_STATE_TIMEOUT_MS}ms — the target scene's create() likely threw (check the page console / .verify-result.json)`))
      }, APPLY_STATE_TIMEOUT_MS)
    })
    return await Promise.race([evalPromise, timeout])
  }

  /** Not part of GameHarness — a runner-side settle wait, same idea as harness.ts's own TRIGGER_SETTLE_MS. */
  async wait(ms) {
    await this.eval(`new Promise((resolve) => setTimeout(resolve, ${ms}))`)
  }
}

// Extra settle time this runner gives a scene *transition* (game_over_trigger,
// restart) beyond what harness.ts's own fire()/press() already wait — a
// scene's CREATE event and its harness-visible side effects (new Text
// objects, registry writes) can land a tick after the transition call
// resolves. harness.ts's own TRIGGER_SETTLE_MS covers "did the trigger's
// effect happen"; this covers "did the *scene switch* finish settling" on
// top of that, entirely on the runner side — it does not require any harness
// API change.
const TRANSITION_SETTLE_MS = 100

/** See `RemoteHarness.applyState()`'s comment — the one eval that can hang forever without this. */
const APPLY_STATE_TIMEOUT_MS = 15000

// ───────────────────────────────────────────────────────────────────────
// Result helpers — every judge function below returns one of these shapes
// ───────────────────────────────────────────────────────────────────────

function passResult(item) {
  return { itemId: item.itemId, templateId: item.templateId, passed: true, failure: null }
}

function failResult(item, expected, actual, hint) {
  return {
    itemId: item.itemId,
    templateId: item.templateId,
    passed: false,
    failure: { itemId: item.itemId, templateId: item.templateId, expected, actual, hint: hint ?? null },
  }
}

/**
 * 🔴 task 3.4 / design D5: the ONLY place a "can't judge this" outcome gets
 * produced. Always routes through failResult so the shape stays identical to
 * a real failure (`passed: false`) — the ONLY distinguishing signal is this
 * fixed hint prefix. Tests assert on that prefix, not on some separate status
 * field, because there isn't one: upstream's `AssertionFailure` has exactly
 * `itemId/templateId/expected/actual/hint`, nothing else to carry a "kind".
 */
function preconditionResult(item, expected, actual, detail) {
  return failResult(item, expected, actual, `前提不满足（不是产物缺陷）：${detail}`)
}

/**
 * 🔴 trigger-integrity-and-onscreen-gate task 1.3 / design D5: `fire()`
 * (`src/debug/harness.ts`) throws when a trigger's handler moves the named
 * `player` entity — see that function's doc. This is a DIFFERENT kind of
 * "can't prove anything" than `preconditionResult()`'s (a missing
 * trigger/state/value): here the assertion's own precondition WAS met
 * (`applyState()` succeeded, the trigger IS registered) and the *product*
 * is provably violating the trigger-integrity contract. Routed through the
 * same `failResult()` shape — reusing the existing red path is cheaper than
 * inventing a fourth status (design D5) — but with a hint prefix that says
 * so explicitly. It must never read "前提不满足": that phrase would
 * misdescribe a real trigger-integrity violation as a benign precondition
 * gap, exactly the kind of collapse this file's own header comment forbids.
 */
function triggerViolationResult(item, expected, errorMessage, condition) {
  return failResult(
    item,
    expected,
    errorMessage,
    `触发器违规（不是前提不满足）：触发「${condition}」时 fire() 抛出异常——handler 在同步执行期间移动了名为 "player" 的实体，违反了 AGENTS.md 规则 6 的触发器完整性契约`,
  )
}

function resolveStateDescriptor(states, raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  // Try an exact engine state id first, then a StateRole — see harness-types.ts's
  // doc on why role, not id, is what template prose actually means. Both are
  // checked because assertions.json params may name either: the runner's own
  // sample file uses ids (design D5's own table literally writes
  // `applyState(gameplay)`, i.e. a role, for controllable/score_feedback/
  // game_over_trigger/restart's precondition — those calls resolve a role
  // to a state below), while hud_text_present/value_persists's `state`/`from`/
  // `to` params can be given as either.
  const byId = states.find((s) => s.id === raw)
  if (byId) return byId
  const byRole = states.find((s) => s.role === raw)
  if (byRole) return byRole
  return null
}

function findGameplayState(states) {
  return states.find((s) => s.role === 'gameplay') ?? null
}

// ───────────────────────────────────────────────────────────────────────
// Per-template judges — design D5's table, one function per row
// ───────────────────────────────────────────────────────────────────────

function judgeLoadsClean(loadEvidence, item) {
  // 🔴 task 3.6: reuses BH-1's evidence, never reloads the page. `loadEvidence`
  // is handed in by the caller (verify.mjs's own BH-1 check, or the
  // standalone CLI's own single page load) — this function never touches CDP.
  const expected = describeTemplate('loads_clean', {})
  const { exceptions, failedRequests } = loadEvidence
  if (exceptions.length === 0 && failedRequests.length === 0) return passResult(item)
  return failResult(
    item,
    expected,
    `${exceptions.length} uncaught exception(s), ${failedRequests.length} failed request(s)`,
    'see the BH-1 gate detail in the same .verify-result.json for the exception/request list',
  )
}

async function judgeControllable(harness, item) {
  const expected = describeTemplate('controllable', item.params)
  const key = item.params?.key

  const states = await harness.listStates()
  const gameplay = findGameplayState(states)
  if (!gameplay) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `no state with role "gameplay" — controllable has nowhere to establish its starting point`,
    )
  }

  const applied = await harness.applyState(gameplay.id)
  if (!applied) {
    return preconditionResult(
      item, expected,
      `applyState("${gameplay.id}") returned false`,
      `applyState() rejected this project's own gameplay state "${gameplay.id}" as an illegal start — check isValidStart()`,
    )
  }

  const before = await harness.getSnapshot()
  if (before.entities.length === 0) {
    return preconditionResult(
      item, expected,
      'getSnapshot().entities is empty',
      'harness.getSnapshot() exposes no named entities — controllable has no position to diff a press() against',
    )
  }

  try {
    await harness.press(key, { durationMs: 200 })
  } catch (err) {
    return preconditionResult(
      item, expected,
      `press("${key}") threw: ${err.message}`,
      `key "${key}" is not recognized by this project's harness.press() (check its KEY_TABLE)`,
    )
  }

  const after = await harness.getSnapshot()
  const moved = before.entities.some((b) => {
    const a = after.entities.find((e) => e.name === b.name)
    return a !== undefined && (a.x !== b.x || a.y !== b.y)
  })

  if (!moved) {
    return failResult(
      item, expected,
      `entities before: ${JSON.stringify(before.entities)}, after: ${JSON.stringify(after.entities)}`,
      `pressing "${key}" produced no x/y change on any named entity — check that this key is bound to movement in this state`,
    )
  }
  return passResult(item)
}

async function judgeHudTextPresent(harness, item) {
  const expected = describeTemplate('hud_text_present', item.params)
  const text = item.params?.text ?? ''

  const states = await harness.listStates()
  const target = resolveStateDescriptor(states, item.params?.state)
  if (!target) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `state "${item.params?.state}" does not match any state id or role`,
    )
  }

  const applied = await harness.applyState(target.id)
  if (!applied) {
    return preconditionResult(
      item, expected,
      `applyState("${target.id}") returned false`,
      `applyState() rejected this project's own state "${target.id}" as an illegal start`,
    )
  }

  const snap = await harness.getSnapshot()
  const found = snap.hudTexts.some((t) => t.includes(text))
  if (!found) {
    return failResult(
      item, expected,
      `hudTexts: ${JSON.stringify(snap.hudTexts)}`,
      `no HUD text object contains "${text}" while in state "${target.id}" — check the Text objects created there`,
    )
  }
  return passResult(item)
}

async function judgeValuePersists(harness, item) {
  const expected = describeTemplate('value_persists', item.params)
  const valueName = item.params?.value

  const states = await harness.listStates()
  const from = resolveStateDescriptor(states, item.params?.from)
  const to = resolveStateDescriptor(states, item.params?.to)
  if (!from) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `"from" state "${item.params?.from}" does not match any state id or role`,
    )
  }
  if (!to) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `"to" state "${item.params?.to}" does not match any state id or role`,
    )
  }

  const appliedFrom = await harness.applyState(from.id)
  if (!appliedFrom) {
    return preconditionResult(
      item, expected,
      `applyState("${from.id}") returned false`,
      `applyState() rejected this project's own "from" state "${from.id}"`,
    )
  }
  const snap0 = await harness.getSnapshot()
  if (!(valueName in snap0.values)) {
    return preconditionResult(
      item, expected,
      `values = ${JSON.stringify(snap0.values)}`,
      `"${valueName}" is not a key in getSnapshot().values at state "${from.id}" — this project's harness.readValues() does not expose it (yet)`,
    )
  }
  const before = snap0.values[valueName]

  const appliedTo = await harness.applyState(to.id)
  if (!appliedTo) {
    return preconditionResult(
      item, expected,
      `applyState("${to.id}") returned false`,
      `applyState() rejected this project's own "to" state "${to.id}"`,
    )
  }
  const snap1 = await harness.getSnapshot()
  if (!(valueName in snap1.values)) {
    return preconditionResult(
      item, expected,
      `values = ${JSON.stringify(snap1.values)}`,
      `"${valueName}" is not a key in getSnapshot().values at state "${to.id}"`,
    )
  }
  const after = snap1.values[valueName]

  if (before !== after) {
    return failResult(
      item, expected,
      `values.${valueName} before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`,
      `the value changed across the "${from.id}" -> "${to.id}" transition — check where it gets reset`,
    )
  }
  return passResult(item)
}

async function judgeScoreFeedback(harness, item) {
  const expected = describeTemplate('score_feedback', item.params)
  const condition = item.params?.condition

  const states = await harness.listStates()
  const gameplay = findGameplayState(states)
  if (!gameplay) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `no state with role "gameplay" — score_feedback has nowhere to fire a trigger against`,
    )
  }
  const applied = await harness.applyState(gameplay.id)
  if (!applied) {
    return preconditionResult(
      item, expected,
      `applyState("${gameplay.id}") returned false`,
      `applyState() rejected this project's own gameplay state "${gameplay.id}"`,
    )
  }

  const triggers = await harness.listTriggers()
  if (!triggers.includes(condition)) {
    return preconditionResult(
      item, expected,
      `listTriggers() = ${JSON.stringify(triggers)}`,
      `trigger "${condition}" is not registered (see harness.listTriggers())`,
    )
  }

  const before = await harness.getSnapshot()
  try {
    await harness.fire(condition)
  } catch (err) {
    return triggerViolationResult(item, expected, err.message, condition)
  }
  const after = await harness.getSnapshot()

  // 🔴 design D5's hard rule: judge hudTexts, never `score`. An internal
  // variable changing with no on-screen text change is exactly the bug this
  // template exists to catch — comparing `score` here would let it through.
  const changed = JSON.stringify(before.hudTexts) !== JSON.stringify(after.hudTexts)
  if (!changed) {
    return failResult(
      item, expected,
      `hudTexts 前后一致：${JSON.stringify(after.hudTexts)}`,
      `trigger「${condition}」已注册且已触发，但没有任何 HUD 文本变化——检查得分是否只改了内部变量、没有同步到 Text object`,
    )
  }
  return passResult(item)
}

async function judgeGameOverTrigger(harness, item) {
  const expected = describeTemplate('game_over_trigger', item.params)
  const condition = item.params?.condition

  const states = await harness.listStates()
  const gameplay = findGameplayState(states)
  if (!gameplay) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `no state with role "gameplay" — game_over_trigger has nowhere to fire a trigger against`,
    )
  }
  const applied = await harness.applyState(gameplay.id)
  if (!applied) {
    return preconditionResult(
      item, expected,
      `applyState("${gameplay.id}") returned false`,
      `applyState() rejected this project's own gameplay state "${gameplay.id}"`,
    )
  }

  const triggers = await harness.listTriggers()
  if (!triggers.includes(condition)) {
    return preconditionResult(
      item, expected,
      `listTriggers() = ${JSON.stringify(triggers)}`,
      `trigger "${condition}" is not registered (see harness.listTriggers())`,
    )
  }

  try {
    await harness.fire(condition)
  } catch (err) {
    return triggerViolationResult(item, expected, err.message, condition)
  }
  await harness.wait(TRANSITION_SETTLE_MS)

  const snap = await harness.getSnapshot()
  const statesNow = await harness.listStates()
  const matched = statesNow.find((s) => s.id === snap.stateId)
  if (!matched) {
    return failResult(
      item, expected,
      `stateId="${snap.stateId}" not found in listStates()`,
      `getSnapshot().stateId doesn't match any entry from listStates() — check that the reported id matches an actual scene key`,
    )
  }
  if (matched.role !== 'gameover') {
    return failResult(
      item, expected,
      `stateId="${snap.stateId}" role="${matched.role}"`,
      `trigger「${condition}」已触发，但当前状态 role 不是「gameover」——检查该 trigger 触发的碰撞/事件是否切到了失败场景`,
    )
  }
  return passResult(item)
}

async function judgeRestart(harness, item) {
  const expected = describeTemplate('restart', item.params)
  const triggerKey = item.params?.trigger

  const states = await harness.listStates()
  const gameplay = findGameplayState(states)
  if (!gameplay) {
    return preconditionResult(
      item, expected,
      `listStates() = ${JSON.stringify(states)}`,
      `no state with role "gameplay" — restart has nowhere to establish its starting point`,
    )
  }
  const applied = await harness.applyState(gameplay.id)
  if (!applied) {
    return preconditionResult(
      item, expected,
      `applyState("${gameplay.id}") returned false`,
      `applyState() rejected this project's own gameplay state "${gameplay.id}"`,
    )
  }

  // Best-effort: put a nonzero score on the board before restarting, so this
  // assertion can actually observe "score reset to 0" rather than a no-op
  // 0 -> 0. Design D5's own driver note ("先制造非零分（fire 得分 trigger，
  // 没有就 press)") names no specific trigger id — this reference runner
  // tries a trigger literally called "score" (this template's own reference
  // convention, see GameScene.ts's registerTrigger('score', ...)) and falls
  // back to pressing Space (a common "act"/"shoot" key). Neither branch's
  // outcome gates pass/fail below — if score is still 0 afterwards because
  // neither convention applies to this project, the assertion just verifies
  // a less interesting (but not wrong) 0 -> 0 reset.
  const triggers = await harness.listTriggers()
  if (triggers.includes('score')) {
    // 🔴 Unlike the Space-press fallback below, a `fire()` throw here is
    // NEVER a benign "this convention doesn't apply" — it means `fire()`
    // (harness.ts) caught this trigger's handler moving the "player" entity
    // (trigger-integrity-and-onscreen-gate design D1/D2). That is real
    // evidence of a genuine defect and MUST surface as this item's result,
    // not be swallowed as best-effort setup, and MUST NOT be left to
    // propagate uncaught up into runAssertions()'s crash handler either —
    // that would turn ONE trigger violation into the entire run going
    // `unavailable`, hiding every other item's real verdict.
    try {
      await harness.fire('score')
    } catch (err) {
      return triggerViolationResult(item, expected, err.message, 'score')
    }
  } else {
    try {
      await harness.press('Space', { durationMs: 100 })
    } catch {
      // best-effort convention only — not every project binds Space to anything
    }
  }

  try {
    await harness.press(triggerKey, { durationMs: 150 })
  } catch (err) {
    return preconditionResult(
      item, expected,
      `press("${triggerKey}") threw: ${err.message}`,
      `key "${triggerKey}" is not recognized by this project's harness.press() (check its KEY_TABLE)`,
    )
  }
  await harness.wait(TRANSITION_SETTLE_MS)

  const snap = await harness.getSnapshot()
  const statesNow = await harness.listStates()
  const matched = statesNow.find((s) => s.id === snap.stateId)
  const role = matched?.role ?? 'unknown'
  // 🔴 strict `=== 0`, not `== 0` — a scoreless game reports `score: null`
  // (harness-types.ts), and `null` MUST NOT be treated as "reset to zero"
  // (spec.md's negative-case scenario for this exact trap).
  const passed = role === 'gameplay' && snap.score === 0
  if (!passed) {
    return failResult(
      item, expected,
      `role="${role}", score=${JSON.stringify(snap.score)}`,
      `触发「${triggerKey}」后未能同时满足「回到 gameplay 状态」与「分数归零」——检查重开逻辑是否两者都做了`,
    )
  }
  return passResult(item)
}

/**
 * data_from_files — game-data-spine design D3. The ONE judge whose every
 * "can't run" outcome is a product defect, never a precondition: a project
 * with no gameplay state, or one whose gameplay scene won't even start, is
 * a broken product from this assertion's point of view too. The upstream
 * spec delta is explicit that manifest-absent MUST fail rather than
 * precondition-out — trial-09's 0-data-files/3985-lines artifact passing
 * every machine gate is exactly what a 前提不满足 routing here would
 * re-enable. That also means this function NEVER calls
 * `preconditionResult()` — every failure below is `failResult` with a
 * hint pointing at the fix, and the tests pin that property.
 */
async function judgeDataFromFiles(harness, item) {
  const expected = describeTemplate('data_from_files', {})
  // Every `actual` names all three layers, so a reader of the failure never
  // has to guess WHICH of the three gaps they're looking at (spec scenario
  // 「actual 区分『声明/加载/消费』三层各自的状况」).
  const summarize = (data) =>
    data === null
      ? '声明 0 条（data=null，从未声明数据清单）/ 加载 0 条 / 场景消费 0 条'
      : `声明 ${data.declared.length} 条 / 加载 ${data.loaded.length} 条 / 场景消费 ${data.usedInScene.length} 条`

  const states = await harness.listStates()
  const gameplay = findGameplayState(states)
  if (!gameplay) {
    return failResult(
      item, expected,
      '没有 role="gameplay" 的状态——玩法场景不存在，数据层证据无处产生',
      '这个游戏没有可进入的玩法状态：先让玩法场景存在并在其中消费 game-data.json 的条目（这是产物缺陷，不是前提不满足）',
    )
  }
  // Establish the gameplay start OURSELVES (order independence): the data
  // evidence's `usedInScene` layer only fills once a scene build has taken
  // entries from `src/game-data.ts`, and on a fresh page load the boot chain
  // stops at Start — Game has never run yet.
  const applied = await harness.applyState(gameplay.id)
  if (!applied) {
    return failResult(
      item, expected,
      `applyState("${gameplay.id}") returned false`,
      '玩法场景起不来（applyState 被拒）：没有可运行的玩法，就谈不上「运行时实际从数据文件加载」——修场景，这是产物缺陷，不是前提不满足',
    )
  }

  const snap = await harness.getSnapshot()
  const data = snap.data ?? null

  if (data === null || data.declared.length === 0) {
    return failResult(
      item, expected,
      summarize(data),
      '先按数据层约定立数据：在项目根的 public/game-data.json 声明 levels/rules/vocabulary 分节（契约见 src/game-data.ts），并让 PreloadScene 加载它——这是产物缺陷，不是前提不满足',
    )
  }
  if (data.loaded.length === 0) {
    return failResult(
      item, expected,
      summarize(data),
      '清单声明了但运行时没有加载：确认 PreloadScene 用 this.load.text(GAME_DATA_RAW_CACHE_KEY, "game-data.json") 加载并在 create() 里调用 initGameData()（不要绕开 src/game-data.ts 另起一套）',
    )
  }
  if (data.usedInScene.length === 0) {
    return failResult(
      item, expected,
      summarize(data),
      '数据加载了但玩法场景构建没有消费：让场景在 create() 里经 src/game-data.ts 的访问接口取条目（getActiveLevel()/getLevelById()/getGameRules()/getVocabulary()），而不是把内容写死在场景类里',
    )
  }
  return passResult(item)
}

/** Exported so tests/assert.test.mjs can drive each template's judgement directly against a mock harness, without going through runAssertions()'s file-reading and harness-presence checks. */
export async function judgeOne(harness, loadEvidence, item) {
  switch (item.templateId) {
    case 'loads_clean':
      return judgeLoadsClean(loadEvidence, item)
    case 'controllable':
      return judgeControllable(harness, item)
    case 'hud_text_present':
      return judgeHudTextPresent(harness, item)
    case 'value_persists':
      return judgeValuePersists(harness, item)
    case 'score_feedback':
      return judgeScoreFeedback(harness, item)
    case 'game_over_trigger':
      return judgeGameOverTrigger(harness, item)
    case 'restart':
      return judgeRestart(harness, item)
    case 'data_from_files':
      return judgeDataFromFiles(harness, item)
    default:
      // Unreachable in practice: readAssertionsFile() already rejects any
      // templateId outside KNOWN_TEMPLATE_IDS as `unavailable` before this
      // function is ever called. Thrown here (not returned) so it's caught
      // by runAssertions()'s try/catch and folded into `unavailable` rather
      // than silently producing a wrong per-item result.
      throw new Error(`assert.mjs: unhandled templateId "${item.templateId}"`)
  }
}

/**
 * trigger-integrity-and-onscreen-gate task 1.2 / design D3. A project with
 * no entity named `player` makes `fire()`'s trigger-integrity check a
 * silent no-op (see `src/debug/harness.ts`'s `fire()` doc — it only ever
 * throws or resolves cleanly, it has no channel of its own to say "I didn't
 * check"). Design D3 forbids that from being invisible ("能被静默跳过的闸不
 * 是闸") — the same rule that already governs the top-level `unavailable`
 * status. This probe runs once per `runAssertions()` call, not once per
 * item, because "did A even have something to check" is a fact about the
 * *project*, not about any one assertion — its result is carried on the
 * returned object as `triggerIntegrityCheck` and flows straight into
 * `.verify-result.json` regardless of which specific templates this
 * project's assertions.json happens to list.
 *
 * 🔴 This function must never make the run red by itself. An inconclusive
 * probe (no gameplay state, applyState() rejects it, the probe itself
 * throws) is reported exactly like a confirmed-absent `player` entity:
 * `ran: false` plus a human-readable reason, never a failure. Only `fire()`
 * throwing during an actual assertion — a real violation — produces a
 * failure, and that happens in the per-item judges above, not here.
 */
export async function checkTriggerIntegrityAvailability(harness) {
  try {
    const states = await harness.listStates()
    const gameplay = findGameplayState(states)
    if (!gameplay) {
      return {
        ran: false,
        reason: 'no state with role "gameplay" — trigger-integrity check (A) had nowhere to look for a "player" entity',
      }
    }
    const applied = await harness.applyState(gameplay.id)
    if (!applied) {
      return {
        ran: false,
        reason: `applyState("${gameplay.id}") returned false — trigger-integrity check (A) could not establish its starting point`,
      }
    }
    const snap = await harness.getSnapshot()
    const hasPlayer = snap.entities.some((e) => e.name === 'player')
    if (!hasPlayer) {
      return {
        ran: false,
        reason:
          `no entity named "player" in getSnapshot().entities (found: ${JSON.stringify(snap.entities.map((e) => e.name))}) — ` +
          `trigger-integrity check (A) did not run for this project; see AGENTS.md rule 6 for the "player" naming contract`,
      }
    }
    return { ran: true, reason: null }
  } catch (err) {
    return { ran: false, reason: `trigger-integrity availability probe failed: ${err.message}` }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Orchestrator — the thing verify.mjs and the CLI entry both call
// ───────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   harness: RemoteHarness,
 *   loadEvidence: { exceptions: string[], failedRequests: unknown[] },
 *   projectRoot?: string,
 * }} args
 * @returns {Promise<{
 *   status: 'judged' | 'absent' | 'unavailable',
 *   reason: string | null,
 *   passedCount: number,
 *   total: number,
 *   results: readonly { itemId: string, templateId: string, passed: boolean, failure: unknown }[],
 *   triggerIntegrityCheck?: { ran: boolean, reason: string | null },
 * }>}
 */
export async function runAssertions({ harness, loadEvidence, projectRoot = PROJECT_ROOT }) {
  const fileResult = readAssertionsFile(projectRoot)

  if (fileResult.status === 'absent') {
    return { status: 'absent', reason: 'no assertions.json found at the project root', passedCount: 0, total: 0, results: [] }
  }
  if (fileResult.status === 'unavailable') {
    return { status: 'unavailable', reason: fileResult.reason, passedCount: 0, total: 0, results: [] }
  }

  let harnessPresent
  try {
    harnessPresent = await harness.exists()
  } catch (err) {
    return {
      status: 'unavailable',
      reason: `could not probe window.__gameHarness: ${err.message}`,
      passedCount: 0, total: 0, results: [],
    }
  }
  if (!harnessPresent) {
    return {
      status: 'unavailable',
      reason: 'window.__gameHarness is not present in this build — see AGENTS.md for the harness implementation requirement',
      passedCount: 0, total: 0, results: [],
    }
  }

  const version = await harness.version()
  if (version !== 1) {
    return {
      status: 'unavailable',
      reason: `unsupported window.__gameHarness.version ${JSON.stringify(version)} (this runner only understands 1)`,
      passedCount: 0, total: 0, results: [],
    }
  }

  // 🔴 trigger-integrity-and-onscreen-gate task 1.2 / design D3: run once,
  // ahead of the per-item loop below, regardless of which templates this
  // project's assertions.json actually lists — see checkTriggerIntegrityAvailability()'s
  // own doc for why "did A's check even run" is a project-level fact, not a
  // per-assertion one.
  const triggerIntegrityCheck = await checkTriggerIntegrityAvailability(harness)

  // 🔴 design D6: every item is judged independently against a freshly
  // established precondition (each judge*() function calls applyState()
  // itself before doing anything else that reads state). Nothing here
  // reorders or dedupes assertions.json — order-independence is a property
  // of the judge functions, not of this loop; see tests/assert.test.mjs's
  // shuffled-order test.
  const results = []
  try {
    for (const item of fileResult.assertions) {
      // Intentionally sequential (not Promise.all) — every item drives the
      // one live game instance through the same harness; running them
      // concurrently would race applyState() calls against each other.
      const result = await judgeOne(harness, loadEvidence, item)
      results.push(result)
    }
  } catch (err) {
    // A judge function threw something unexpected (not one of its own
    // precondition checks, which all return normally) — this is "判定过程
    // 崩了" from design D4, and per that design it becomes `unavailable`,
    // not a partial `judged` result with some items silently missing.
    return {
      status: 'unavailable',
      reason: `assertion runner crashed while judging: ${err.message}`,
      passedCount: 0, total: 0, results: [],
    }
  }

  const passedCount = results.filter((r) => r.passed).length
  return { status: 'judged', reason: null, passedCount, total: results.length, results, triggerIntegrityCheck }
}

// ───────────────────────────────────────────────────────────────────────
// Standalone CLI entry — design D7: its own browser, for local dev only
// ───────────────────────────────────────────────────────────────────────

function logAssertionsResult(result) {
  if (result.status === 'absent') {
    console.log(`[assert] absent — ${result.reason}`)
    return
  }
  if (result.status === 'unavailable') {
    console.log(`[assert] unavailable — ${result.reason}`)
    return
  }
  console.log(`[assert] judged — ${result.passedCount}/${result.total} passed`)
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

async function runStandalone() {
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    console.error(`[assert] ${DIST_DIR} not found — run \`pnpm build:play\` first.`)
    process.exitCode = 1
    return
  }

  const browser = resolveBrowser()
  console.log(`[assert] Using browser: ${browser.path} (found via: ${browser.source})`)

  const { server, url: staticUrl } = await startStaticServer(DIST_DIR)
  console.log(`[assert] Serving ${DIST_DIR} at ${staticUrl}`)

  let launched
  try {
    launched = await launchBrowser(browser)
  } catch (err) {
    console.error(`[assert] Failed to launch browser: ${err.message}`)
    server.close()
    process.exitCode = 1
    return
  }
  const { proc, wsUrl } = launched

  let result
  let inspected
  try {
    inspected = await inspectPage(wsUrl, staticUrl)
    const loadEvidence = { exceptions: inspected.exceptions, failedRequests: inspected.failedRequests }
    const harness = new RemoteHarness(inspected.client, inspected.sessionId)
    result = await runAssertions({ harness, loadEvidence, projectRoot: PROJECT_ROOT })
  } finally {
    inspected?.client?.close()
    proc.kill()
    server.close()
  }

  logAssertionsResult(result)
  process.exitCode = decideExitCode({ bhPassed: true, assertions: result })
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMainModule) {
  runStandalone().catch((err) => {
    console.error('[assert] Unexpected error:', err)
    process.exitCode = 1
  })
}
