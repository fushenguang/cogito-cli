// asset-usage.mjs — asset-usage-gate design. Turns the `assets` field of one
// or more `HarnessSnapshot`s (see `src/debug/harness-types.ts`'s
// `AssetUsageSnapshot` doc) into the tri-state verdict `scripts/verify.mjs`'s
// AU gate records, mirroring the absent/unavailable/judged discipline
// `scripts/assert.mjs`'s IA layer and `scripts/lib/exit-decision.mjs` already
// established for this template.
//
// 🔴 Real incident this exists to close: a generated project's `game-assets.json`
// declared backgrounds/characters, the manifest parsed fine, `PreloadScene`
// queued the files, BH-0/BH-1/BH-2 and IA all passed — but the level scenes
// never actually drew any of it (`add.image` hit-count 0 across every
// level, `sound` hit-count 0). Nothing in the existing gate set is sensitive
// to "declared but never consumed" — this file is what makes it a machine
// judgment instead of something only a human playtester notices.
//
// Kept as a pure, zero-I/O function — same reason as exit-decision.mjs — so
// `tests/asset-usage.test.mjs` can exercise every branch without a browser.
//
// 🔴 Three states, never collapsed into one another (this template's own
// first rule: a check that can be silently skipped is not a check):
//
//   - absent      — no manifest declared anything usable, for the entire
//                    run (every sampled snapshot's `assets` was `null`).
//                    NOT a failure: most generated projects never opt into
//                    game-assets.json, and must not turn red for a
//                    capability they never used.
//   - unavailable — the caller could not produce ANY assets evidence to
//                    judge at all (every sampled snapshot came from a
//                    harness build that doesn't even have an `assets`
//                    field). Someone changed the manifest/harness contract
//                    and this runner can't tell absent from broken — per
//                    this template's own doctrine ("读不懂就判 unavailable，
//                    绝不默认通过") that counts as a failure, the same as
//                    IA's `unavailable`.
//   - judged      — a real declared/loaded/used comparison ran. `passed` is
//                    the only field that means anything here.
//
// 🔴 2026-08-22 — per-category judgment, not "at least one asset in use
// overall". The first real project this gate ran on exposed exactly the
// hole that phrasing left open: `assetUsage` reported
// `"7/7 declared asset(s) loaded, 2 in active use (title, bg-level1)"` and
// `passed: true` — while all 3 declared characters AND the declared bgm
// sat completely unused. The builder's own playtest complaint was, word
// for word, "没有背景音乐，没有使用 AI 设计的人物形象" (no BGM, no AI
// character art in use). A single `usedInScene.size > 0` check can never
// catch that: title+background alone are enough to make it true, no
// matter how much else never got touched. See
// `tests/asset-usage.test.mjs`'s "regression" test for the literal shape
// of this incident, kept as the mutation guard against reintroducing the
// old "any one thing in use" rule.
//
// 🔴 2026-08-28 — the reserved `player` key gets bgm's strict rule. The
// second real project (trial-08, 2026-08-27, in the platform repo that
// scaffolds from this template) exposed the remaining hole in the character
// category's lenient rule above: the protagonist texture was declared,
// loaded into the cache, and NEVER attached to the player — the player
// stayed a procedural placeholder square, the builder's playtest verdict was
// "逻辑不通，玩不了" (the protagonist was still a square), and this gate
// printed `characters 1/3 in use (unused: protagonist)` and PASSED, because
// a companion sprite used as scene decoration satisfied "at least one
// character in use". The gate SAW the unused protagonist and the rule let it
// through. Declaring the reserved key is how a manifest says "this character
// IS the player sprite" (`game-assets.ts`'s `PLAYER_CHARACTER_KEY`), so from
// that declaration alone the gate can finally tell WHICH character is the
// load-bearing one — see `tests/asset-usage.test.mjs`'s trial-08 regression
// test for the literal shape.
//
// Categories are inferred from `key` alone (never from `kind`, except as a
// fallback for a shape this template's own manifest never produces) by
// mirroring `../../src/game-assets.ts`'s own well-known key constants —
// `TITLE_TEXTURE_KEY`, `BGM_AUDIO_KEY`, `backgroundTextureKey()`'s
// `"bg-level<N>"` shape, `PLAYER_CHARACTER_KEY`. Not imported from there:
// this file's own zero-I/O, framework-free discipline (see this header's
// first paragraph) intentionally does not reach into `src/`, the same
// reasoning `harness-types.ts` documents for keeping `DeclaredAssetKind` a
// hand-mirrored type rather than an import. `tests/asset-usage.test.mjs`'s
// drift test imports the real constants from `game-assets.ts` and asserts
// `classifyAssetKey()` agrees with them — same "two copies of one fact,
// caught by a test" discipline as that mirrored type.
//
//   - bgm         — declared ⇒ MUST be in `usedInScene` (i.e. actually
//                    playing). There is only ever one bgm key, so "declared"
//                    and "used" are a direct yes/no, no partial credit.
//   - background  — declared ⇒ at least one declared background key MUST be
//                    in `usedInScene`. NOT "every level's background" — a
//                    snapshot only ever scans the scenes active *right now*
//                    (see `AssetUsageSnapshot`'s doc), so a level that was
//                    never visited during this run's probes is expected to
//                    show 0 use for its own background, and must not be
//                    held against the project.
//   - character   — split in two by the reserved key (see `PLAYER_KEY`
//                    below): a character keyed `"player"` declared ⇒ MUST be
//                    in `usedInScene` — bgm's strict rule, for the same
//                    reason: the reserved key is the template's own
//                    statement of intent ("this character IS the player
//                    sprite"), and there is no partial credit between
//                    "declared" and "actually worn by the player". Every
//                    OTHER declared character only requires at least one of
//                    them to be in `usedInScene` (a game legitimately may
//                    not use every generated side character), but any unused
//                    ones are always named in `reason` so "1/3 in use" is
//                    never silently indistinguishable from "3/3 in use".
//   - title       — never required. The title texture is only ever drawn on
//                    the start screen; by the time a later snapshot samples
//                    the gameplay state, the project may have legitimately
//                    left it behind. Reported in `reason` for visibility
//                    only, never counted against `passed`.
//
// `passed` is `false` when ANY declared category with a hard requirement
// (bgm, background, or character) fails its own rule above, OR when
// nothing loaded at all (the pre-existing, more severe failure — see
// below). `reason` always names every failing category by name (never one
// generic "something's unused" message) so it stays directly actionable —
// see this module's own `reason` construction below.

/** Mirrors `../../src/game-assets.ts`'s `TITLE_TEXTURE_KEY` — see this file's header. */
const TITLE_KEY = 'title'
/** Mirrors `../../src/game-assets.ts`'s `BGM_AUDIO_KEY` — see this file's header. */
const BGM_KEY = 'bgm'
/**
 * Mirrors `../../src/game-assets.ts`'s `PLAYER_CHARACTER_KEY` — the one
 * reserved character slug. Declaring a character under this key is the
 * manifest's own statement of intent ("this character IS the player
 * sprite"), which is what lets the judge below hold it to bgm's strict
 * declared-⇒-MUST-use rule instead of the lenient "at least one character
 * in use" every other character slug gets. See this file's header
 * (2026-08-28 note) for the real incident that made this strict. Exported
 * only so `tests/asset-usage.test.mjs`'s drift test can assert it never
 * diverges from the real constant — same pattern as `classifyAssetKey`.
 */
export const PLAYER_KEY = 'player'
/** Mirrors `../../src/game-assets.ts`'s `backgroundTextureKey()` (`"bg-level" + N`, `N >= 1`) — see this file's header. */
const BACKGROUND_KEY_PATTERN = /^bg-level[1-9]\d*$/

/**
 * One declared/loaded/used key -> which asset-usage category it belongs to,
 * for the per-category judgment this module's header documents. Exported
 * only so `tests/asset-usage.test.mjs` can assert this never drifts from
 * `../../src/game-assets.ts`'s real key-generating functions.
 *
 * `kind` is consulted only as a fallback for a shape today's manifest never
 * actually produces (an audio key that isn't `"bgm"` — there is currently no
 * other way to declare audio at all) so a future manifest shape doesn't
 * silently get miscategorized as a character.
 *
 * @param {string} key
 * @param {'image' | 'audio' | undefined} kind
 * @returns {'title' | 'bgm' | 'background' | 'character' | 'other'}
 */
export function classifyAssetKey(key, kind) {
  if (key === TITLE_KEY) return 'title'
  if (key === BGM_KEY) return 'bgm'
  if (BACKGROUND_KEY_PATTERN.test(key)) return 'background'
  if (kind === 'image') return 'character'
  return 'other'
}

/**
 * @param {readonly (import('../../src/debug/harness-types.ts').AssetUsageSnapshot | null | undefined)[]} assetSnapshots
 *   Every `HarnessSnapshot.assets` this run sampled, in whatever order they
 *   were taken (`scripts/verify.mjs` passes one per `applyState()` probe it
 *   already takes for the entity-bounds gate — see that file's AU section).
 *   `null` means "this particular snapshot's harness reported no manifest"
 *   (expected to be the same for every snapshot in a run, since the
 *   manifest doesn't change mid-run — never mixed on purpose, but this
 *   function does not assume that). `undefined` means "this snapshot did
 *   not even have an `assets` field" — a harness build that predates this
 *   gate, or a caller that failed to read it.
 * @returns {
 *   | { status: 'absent', reason: string }
 *   | { status: 'unavailable', reason: string }
 *   | { status: 'judged', passed: boolean, reason: string, declared: string[], loaded: string[], usedInScene: string[] }
 * }
 */
export function judgeAssetUsage(assetSnapshots) {
  const entries = assetSnapshots ?? []

  const withField = entries.filter((s) => s !== undefined)
  if (withField.length === 0) {
    return {
      status: 'unavailable',
      reason:
        'no getSnapshot() call in this run included an "assets" field at all — this build\'s harness predates the asset-usage gate, or every snapshot attempt was skipped before reaching it',
    }
  }

  const withManifest = withField.filter((s) => s !== null)
  if (withManifest.length === 0) {
    return { status: 'absent', reason: 'no game-assets.json manifest declared any usable asset for this run' }
  }

  // The manifest is static for the whole run — every non-null snapshot
  // should report the same declared/loaded sets. Unioning across every
  // sample (rather than just reading the first) is what lets `usedInScene`
  // combine evidence taken at genuinely different moments (e.g. the title
  // screen right after load, then the gameplay scene after applyState()) —
  // see AssetUsageSnapshot's own doc for why a single snapshot cannot see
  // everything a project draws across its whole state machine.
  const declaredKinds = new Map()
  const loaded = new Set()
  const usedInScene = new Set()
  for (const snap of withManifest) {
    for (const d of snap.declared) declaredKinds.set(d.key, d.kind)
    for (const key of snap.loaded) loaded.add(key)
    for (const key of snap.usedInScene) usedInScene.add(key)
  }
  const declared = [...declaredKinds.keys()]

  if (loaded.size === 0) {
    return {
      status: 'judged',
      passed: false,
      reason: `manifest declared ${declared.length} asset(s) (${declared.join(', ')}) but none of them made it into the texture/audio cache — check the manifest's "path" values against what actually exists under public/assets/`,
      declared,
      loaded: [],
      usedInScene: [],
    }
  }

  // Bucket every declared/loaded/used key by category — see this module's
  // header for what each category requires.
  const byCategory = new Map()
  function bucket(category) {
    let b = byCategory.get(category)
    if (!b) {
      b = { declared: new Set(), used: new Set() }
      byCategory.set(category, b)
    }
    return b
  }
  for (const key of declared) bucket(classifyAssetKey(key, declaredKinds.get(key))).declared.add(key)
  for (const key of usedInScene) {
    if (!declaredKinds.has(key)) continue // defensive only — usedInScene is always a subset of declared in practice
    bucket(classifyAssetKey(key, declaredKinds.get(key))).used.add(key)
  }

  const failures = []
  const notes = []

  const bgm = byCategory.get('bgm')
  if (bgm && bgm.declared.size > 0) {
    const unplayed = [...bgm.declared].filter((k) => !bgm.used.has(k))
    if (unplayed.length > 0) {
      failures.push(`bgm declared (${[...bgm.declared].join(', ')}) but not currently playing`)
    } else {
      notes.push('bgm playing')
    }
  }

  const background = byCategory.get('background')
  if (background && background.declared.size > 0) {
    if (background.used.size === 0) {
      failures.push(
        `background declared (${[...background.declared].join(', ')}) but none of them is drawn in the currently active scene`,
      )
    } else {
      notes.push(`background in use (${[...background.used].join(', ')})`)
    }
  }

  const character = byCategory.get('character')
  if (character && character.declared.size > 0) {
    // Reserved player-character key first — see PLAYER_KEY's doc. Declaring
    // it means "this character IS the player sprite", so unlike every other
    // character slug there is no "a game may not use it" leniency: declared
    // but not attached to a real GameObject in an active scene is a failure,
    // the exact trial-08 shape (protagonist loaded, player stayed a
    // procedural placeholder square, gate printed "1/3 in use (unused:
    // protagonist)" and passed).
    const playerDeclared = character.declared.has(PLAYER_KEY)
    const playerUsed = character.used.has(PLAYER_KEY)
    if (playerDeclared && !playerUsed) {
      failures.push(
        `player character declared (${PLAYER_KEY}) but not in use — the reserved "${PLAYER_KEY}" key marks it as THE player sprite, so declaring it means the player must actually wear it, not just have it loaded`,
      )
    } else if (playerDeclared && playerUsed) {
      notes.push(`player character (${PLAYER_KEY}) in use`)
    }

    // Every other character keeps the lenient per-category rule — but the
    // fraction and the failure below are computed over the non-reserved keys
    // only, so the reserved key's verdict never hides inside an average
    // ("1/3 in use") again.
    const otherDeclared = [...character.declared].filter((k) => k !== PLAYER_KEY)
    const otherUsed = [...character.used].filter((k) => k !== PLAYER_KEY)
    if (otherDeclared.length > 0) {
      const unused = otherDeclared.filter((k) => !otherUsed.includes(k))
      if (character.used.size === 0) {
        // Nothing at all is in use. When the reserved-key failure above
        // already fired, IT is the actionable one and the generic "0/N"
        // failure would just name the same keys again — skip it rather than
        // emit two failures saying one thing. Only when no reserved key was
        // declared does the plain old rule speak here, verbatim.
        if (!playerDeclared) {
          failures.push(`characters declared (${otherDeclared.join(', ')}) but 0/${otherDeclared.length} in use`)
        }
      } else if (unused.length > 0) {
        notes.push(`characters ${otherUsed.length}/${otherDeclared.length} in use (unused: ${unused.join(', ')})`)
      } else {
        notes.push(`characters ${otherUsed.length}/${otherDeclared.length} in use`)
      }
    }
  }

  const title = byCategory.get('title')
  if (title && title.declared.size > 0) {
    notes.push(title.used.size > 0 ? 'title in use' : 'title unused (may already have left the start screen — not required)')
  }

  const passed = failures.length === 0
  const summary = `${loaded.size}/${declared.length} declared asset(s) loaded`
  const details = passed ? notes : failures
  const reason = details.length > 0 ? `${summary}; ${details.join('; ')}` : summary

  return {
    status: 'judged',
    passed,
    reason,
    declared,
    loaded: [...loaded],
    usedInScene: [...usedInScene],
  }
}
