---
name: game-flow-and-hud
description: "Use this skill when structuring a Phaser game's HUD layer, level/stage progression, scene restart flow, start/title screen, or platform-delivered AI-generated assets — choosing between a dedicated UI Scene, multi-camera ignore(), or setScrollFactor(0) for HUD elements; externalizing level/stage data instead of hardcoding coordinates; deciding between scene.restart() and reusing-existing-objects for a replay loop; wiring registry/data-manager state so it survives (or correctly resets on) a restart; computing physics-derived placement (jump distance, reachable range) before laying out level geometry; or reading game-assets.json and degrading gracefully when an asset is missing/failed to load; or writing a NEW playable scene (e.g. a `Level1Scene`/`Level2Scene` replacing the template's `GameScene`) that must carry forward background-image draw, player/character texture keys, and BGM gesture-gating instead of drawing shapes in their place. Triggers on: HUD, UI Scene, heads-up display, score display, level design, level progression, stage select, level data, Tiled, scene restart, replay, game over restart, registry persistence, reachability, jump distance, gap width, level gotchas, start scene, title screen, game-assets.json, asset manifest, AI-generated assets, background music, BGM, mute toggle, autoplay policy, deleting GameScene, new level scene, LevelScene, applyLevelBackground."
---

# Game Flow and HUD

> This skill fills gaps the 28 official Phaser skills (`node_modules/phaser/skills/*`) leave open. It does not re-explain anything they already cover — see "Related skills" below for where that material lives. What's here: (1) a decision judgment for HUD architecture the official docs describe three ways to build but never say when to pick which; (2) level/stage progression structure, which has **no official skill at all**; (3) two self-checks that catch a specific failure shape — code that looks complete but is structurally disconnected from the game; (4) a rule about computing placement values instead of guessing them.

**Related skills (read these first for their own topic — do not re-derive):**
`../../node_modules/phaser/skills/scenes/SKILL.md` (lifecycle, `init()` vs constructor, restart mechanics), `../../node_modules/phaser/skills/events-system/SKILL.md` (listener leaks on restart, `shutdown` cleanup), `../../node_modules/phaser/skills/data-manager/SKILL.md` (registry semantics, cross-restart persistence), `../../node_modules/phaser/skills/cameras/SKILL.md` (multi-camera `ignore()`), `../../node_modules/phaser/skills/scale-and-responsive/SKILL.md` (Scale Manager modes), `../../node_modules/phaser/skills/game-object-components/SKILL.md` (`setScrollFactor` semantics).

## Quick Start

```ts
// 1. HUD: a dedicated Scene, launched alongside gameplay — see "HUD Architecture" below
// for why this is the default, not just one of three equally-valid options.
class UiScene extends Phaser.Scene {
  constructor() { super('UI') }

  create() {
    this.scoreText = this.add
      .text(16, 16, 'Score: 0', { fontSize: '20px', color: '#fff' })
      .setScrollFactor(0) // belt-and-suspenders even though this scene has no scroll yet
  }

  update() {
    // Event-driven, not framework-required — see "Level Progression Structure".
    // Polling registry here is the cheap version of the same idea.
    const score = this.registry.get('score') ?? 0
    if (score !== this.lastScore) {
      this.lastScore = score
      this.scoreText.setText(`Score: ${score}`)
    }
  }
}

class GameScene extends Phaser.Scene {
  create() {
    this.scene.launch('UI')
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scene.stop('UI'))
  }
}

// 2. Level data: external table, not hardcoded coordinates in scene code.
const LEVELS = [
  { id: 1, gapWidthPx: 300, connectsTo: 2 },
  { id: 2, gapWidthPx: 347, connectsTo: 3 },
] as const
```

## Core Concepts

### HUD Architecture: Three Zero-Cost Parts, One Decision Judgment

The official `cameras`, `game-object-components`, and `scale-and-responsive` skills each describe one piece you can build a HUD out of, but none of them says *when* to reach for which:

| Mechanism | Official skill | What it is |
|---|---|---|
| Dedicated UI Scene, `scene.launch()`'d alongside gameplay, rendered on top | `scenes` | A second Scene whose whole job is HUD |
| Multi-camera `ignore()` | `cameras` | One Scene, two cameras; each camera excludes objects the other should show |
| `setScrollFactor(0)` on HUD objects | `game-object-components` | One Scene, one camera; HUD objects opt out of scroll |

All three are legitimate Phaser mechanisms — none is deprecated or "the wrong way." The gap this skill fills is the judgment call, because getting it wrong is exactly how a real bug shape happens: HUD content and world geometry drawn in the same Scene with nothing structurally keeping them apart, so they visually overlap once the camera scrolls or the world grows past the visible band.

**Official documentation is on record about the default:** `docs.phaser.io/phaser/concepts/scenes` states, in its introduction to Scene rendering order — *"it's a common practise to have a Scene dedicated entirely to handling the UI for your game, that is rendered above all other Scenes."* That is Phaser's own recommended default, not one option among three equal ones.

**Independent evidence from real projects.** A survey of five Phaser open-source games (all Phaser 3 — see the version-honesty note below) found HUD architecture split 4-to-1 in favor of a dedicated Scene:

- `monster-tamer` (101★), `phaser3-simple-rpg` (132★), `reldens` (574★), and `digitsensitive`'s Phaser project collection (1032★) — all four use an independent UI Scene.
- `catch-the-cat` (753★) is the one exception — HUD elements pinned to a corner of the single gameplay Scene — and it is also the simplest of the five (no scrolling world, no camera movement, a static board). It was judged not to scale past that simplicity.

**`reldens`'s decision rule, which is the actual answer to "which one do I pick":** whether a UI element belongs in the UI Scene or the world Scene is decided by **whether it is screen-anchored or world-anchored**. A player's own health bar that must always sit in the same corner regardless of camera position is screen-anchored → UI Scene. A health bar floating above an NPC's head, which must move with that NPC through the world, is world-anchored → the gameplay Scene, `setScrollFactor(0)` if anything (usually not even that, since it's meant to scroll).

**The synthesis, stated as a judgment, not a rule to memorize:**

1. Default to a dedicated UI Scene for anything screen-anchored (score, health, timer, ability icons, dialogue box, menus). This is both Phaser's documented recommendation and what 4 of 5 real projects independently converged on.
2. Reach for `setScrollFactor(0)` inside the gameplay Scene only for a genuinely simple, non-scrolling game (`catch-the-cat`'s shape) where a second Scene is overhead you don't need yet.
3. Reach for multi-camera `ignore()` when you need the HUD *and* the world rendered through cameras with different transforms simultaneously (e.g. a minimap that must NOT show HUD icons, or split-screen) — this is a real use the `cameras` skill documents, but it solves a different problem than "keep HUD from overlapping the world," which the other two already solve more simply.
4. 🔴 Whichever you pick, decide **before** you draw the first HUD element, not after you notice overlap. All four majority projects structurally separate HUD from world from the start; none of them show a pattern of "drew it in one Scene, added scroll-factor patches later." The failure mode this whole section exists to prevent is retrofitting separation onto a HUD that already shipped tangled into world geometry — by the time overlap is visible, the fix touches every HUD element instead of one Scene boundary.

### Level Progression Structure (no official coverage — this is the whole gap)

None of the 28 official skills addresses how a game organizes multiple levels/stages, restart flow, or how state should persist across a restart in relation to Scene topology. Everything in this subsection comes from convergent evidence across `monster-tamer`, `phaser3-simple-rpg`, and `reldens` (again: Phaser 3 evidence, see version note).

**1. Level data lives outside scene code, scene code only reads it.** All three projects externalize level/stage layout — either as Tiled JSON maps or a constant data table — rather than hardcoding coordinates inline in a Scene's `create()`. Scene code's job is to *interpret* level data (spawn what the data says, at the positions the data says), never to *be* the level data. Where levels connect to each other, that's also data: a map-attribute convention (`connects_to` / `entrance_id` / `comesBackFrom` are the three names actually used across these projects) tells the next scene which entrance to spawn the player at, rather than the code branching on "which level did we come from."

**2. Two restart paths, and they solve different problems — pick by what the level *is*, not by habit:**

- **(a) Full scene rebuild** — `this.scene.restart()` or `this.scene.start(key)` on the current key. Tears down and reconstructs everything the Scene's `create()` sets up. Use this when the level has object lifecycles complex enough that hand-resetting them is more error-prone than letting Phaser rebuild from scratch — lots of one-off spawns (enemies, pickups, triggers) whose exact reset state is hard to enumerate correctly. The official `scenes` skill's Gotcha #13 ("reset state in `init()`, not the constructor") is what makes this path safe to use repeatedly — read it there, not here.
- **(b) Reuse existing objects, reset only their data.** Instead of destroying and recreating game objects, keep the same instances and reset positions/flags/counters on them directly. Use this when the object *count* is fixed and known up front — a grid, a board, a fixed roster of tiles or pieces — because rebuilding N identical objects on every restart is pure overhead a direct reset avoids.

Both paths are real and both have project-level backing; neither is universally "more correct." The judgment is: variable/unpredictable object population → rebuild; fixed/enumerable object population → reset-in-place.

**3. Where persisting state lives follows Scene topology, not preference.** This is independently verified across all three projects, not just one convention that happened to be copied:

- **Single-Scene games** (or where all gameplay state naturally lives in one place) keep state in a **module-level singleton** — a plain object/class instance imported wherever it's needed, no Phaser machinery involved.
- **Multi-Scene games** push cross-scene state into either **Phaser's `registry`** (`Phaser.Data.DataManager` on `game.registry`, shared by every Scene — see the official `data-manager` skill for its full semantics, including its Gotcha that registry listeners persist across scene restarts and must be cleaned up deliberately) or a **dedicated state-holding Scene** that never itself renders anything, just holds data other Scenes read/write through it.

The pattern to take away: **do not default to "a global variable" or "put it on the Scene class" without asking which Scene topology you actually have.** A module singleton in a multi-Scene game re-derives Scene-scoping bugs the registry already solves for you; the registry in a genuinely single-Scene game is unneeded indirection.

**4. HUD updates on events, not per-frame polling — where you can afford it.** An `xxxChanged`-style event convention (`scoreChanged`, `healthChanged`, etc., emitted from whatever mutates the underlying value) recurs across 4 games and 7 files in the surveyed projects. This is the general-purpose version of the same idea the Quick Start's polling loop uses as a cheap fallback: polling every frame is fine for one or two cheap reads (a `Text.setText()` call gated by an equality check, as in the Quick Start above), but an event-driven update is the pattern that scales once several HUD elements each depend on a different piece of state — it decouples "when does the number change" from "when does the frame tick," which polling conflates.

### Platform-Delivered Assets: Reading the Manifest, Degrading Gracefully

Real art/audio in this template does not arrive as files you pick and load by hand — it arrives from the outer platform as AI-generated files, dropped into a fixed directory layout, described by a manifest at `public/game-assets.json` (contract: `src/game-assets.ts`). This is the same shape of problem `game-doc.json` (`src/game-doc.ts`) already solves for the in-game documentation panel — a JSON file the platform may or may not have written yet, that the game must never treat as guaranteed to exist — extended to binary assets instead of prose.

**The directory contract (do not change it — it's the platform interface):**

```text
public/assets/title.png          start-page hero image
public/assets/bg/level<N>.png    per-level background (N starts at 1)
public/assets/char/<slug>.png    a character, already alpha-matted (transparent PNG)
public/assets/bgm/main.mp3       background music
public/game-assets.json          the manifest describing all of the above
```

**Three rules, all enforced by `src/game-assets.ts` + `src/scenes/PreloadScene.ts` already, worth understanding if you extend either:**

1. **Missing/malformed manifest queues zero requests, never a guess.** `PreloadScene` attempts to load `game-assets.json` itself (a 404 there is expected and non-fatal — same reasoning as `game-doc.json`, see `PreloadScene`'s header doc), but it never attempts to load `assets/title.png` or any other file *without* the manifest first confirming that file's path and existence. The decision of exactly which files to queue is a **pure function** (`planAssetLoads()` in `src/game-assets.ts`) precisely so "missing manifest ⇒ nothing queued" is a fact you can unit-test without a browser (`tests/game-assets.test.mjs`), not something you have to trust by reading Phaser plumbing.
2. **A scene that wants to *use* an asset only ever asks the texture/audio manager, never the manifest.** `StartScene`/`GameScene`/`UiScene` call `this.textures.exists(<well-known key>)` / `this.cache.audio.exists(<well-known key>)` — they never re-parse `game-assets.json` themselves. This is what keeps "did this actually load" as a single source of truth: a file the manifest lists but that 404s on disk simply never registers under its key, and every consumer already treats "key absent" as the normal, checked path (an `if`, not a `try/catch`).
3. **Fallback is always the existing shape/silence, never a thrown error.** No `title.png` → the start screen's plain background color already shows through (nothing to draw). No `bg/level1.png` → the gameplay scene's existing plain fill + placeholder shapes stand in, unchanged. No `bgm/main.mp3` → no audio plays and the HUD's mute toggle simply never mounts (a dead control that mutes nothing is worse than no control). No character keyed `"player"` → the procedural placeholder sprite `PreloadScene.generatePlaceholderTextures()` already drew is what's there. 🔴 That fallback is only legitimate when the manifest did **not** declare a `"player"` character: declare one in `game-assets.json` and then draw the placeholder anyway, and `pnpm verify`'s AU gate fails (a declared reserved key must actually be worn by the player — loaded-but-never-worn is exactly the trial-08 shape).

**Autoplay policy is the one hard gotcha here, not something graceful degradation solves for you:** browsers refuse `AudioContext`/`this.sound.play()` calls made outside a real user-gesture handler. Loading a file (`this.load.audio()`) needs no gesture and is safe to do in `PreloadScene`; *starting playback* does. This template's reference fix is to call `this.sound.play(BGM_AUDIO_KEY, { loop: true })` from inside the "开始游戏" button's own `pointerdown` handler (`StartScene.handleStart()`) — that click **is** the gesture — and never anywhere else. `this.sound` is the Game-level `SoundManager`, shared by every Scene, so starting it once there is enough for it to keep playing through every later scene; a mute toggle (see HUD Architecture above — it belongs in the UI Scene, same as score) only ever needs to flip `this.sound.mute`, never start/stop playback itself.

🔴 **`GameScene.applyHarnessState()` also has this exact same guarded `sound.play()` call — do not delete it as "duplicate" if you rewrite `GameScene`.** It exists solely for `pnpm verify`'s AU (asset-usage) gate: `src/debug/harness.ts`'s `applyState()` reaches gameplay by calling `game.scene.start(id)` directly, never a real click, so without this the gate would see a declared bgm that's never `usedInScene` and fail — on a project doing everything else right. `applyHarnessState()` only ever runs from that synthetic harness path (never a real playthrough), so it changes nothing about when real players hear audio; it only keeps the machine judge honest about a state (`'Game'`) a real player could only ever reach by already having triggered the click. If your replacement scene also wants a passing AU gate for bgm, carry this same guard into whatever scene's `applyHarnessState()` runs first after gameplay begins.

### Writing a New Playable Scene? This Wiring Comes With It — It Is Not `GameScene`'s Private Business

🔴 **Real incident, not a hypothetical.** A generated project's builder asked for AI-generated backgrounds/characters/BGM, "而不是用形状代替" (not shape placeholders). The executing agent then deleted `GameScene.ts` outright and wrote `Level1Scene` … `Level5Scene` from scratch to hold real level content. Real-machine instrumentation afterward showed `add.image` calls hitting **zero** across all five level scenes (only `StartScene` drew one image) and `sound` calls hitting **zero** everywhere — every level shipped with a solid-colour fill and colored-rectangle "characters", exactly the thing the builder explicitly said not to do. The mechanism was simple: `GameScene` was the *only* place in the template that demonstrated how to consume the manifest, and deleting it deleted the only working example along with it.

**The fix is a rule, not a patch to that one project:** deleting/replacing `GameScene` is expected and fine — its player-shooter gameplay is templated demo content, meant to be rewritten into whatever the actual game is. What is **not** demo content, and must be carried into every scene that replaces it, is the asset-consumption wiring "Platform-Delivered Assets" above describes. None of it is `GameScene`-specific; it only *lives* in `GameScene` today because this template ships exactly one gameplay scene.

**Checklist for every new playable scene** (a `Level<N>Scene`, or any additional gameplay scene alongside one):

1. **Background — call the shared helper, don't hand-roll the check again.** `../../src/game-assets.ts` exports `applyLevelBackground(scene, level, width, height)`: it checks `scene.textures.exists(backgroundTextureKey(level))` and, only if that texture is actually registered, draws it centered, sized to `width`×`height`, pinned to `setDepth(-1)` so it renders behind gameplay. No texture ⇒ no-op, return `false` — your scene's existing plain fill is already the fallback, there is nothing else to draw.

   ```ts
   import { applyLevelBackground, PLAYER_CHARACTER_KEY } from '../game-assets'
   import { GAME_WIDTH, PLAYFIELD_HEIGHT } from '../config'

   export class Level2Scene extends Phaser.Scene {
     create(): void {
       applyLevelBackground(this, 2, GAME_WIDTH, PLAYFIELD_HEIGHT) // level = 2 ⇒ reads public/assets/bg/level2.png if it loaded
       this.player = this.physics.add.sprite(x, y, PLAYER_CHARACTER_KEY) // see point 2
       // ...rest of this level's real gameplay
     }
   }
   ```

2. **Player sprite — always `PLAYER_CHARACTER_KEY`, never a key you invent.** `this.physics.add.sprite(x, y, PLAYER_CHARACTER_KEY)` resolves to the manifest's `"player"`-slugged character if the platform generated one, or `PreloadScene`'s procedural placeholder shape otherwise (see `PreloadScene.generatePlaceholderTextures()`'s guard) — every level shares the one texture-manager slot as the single source of truth for "what does the player look like." A scene that instead does `this.physics.add.sprite(x, y, 'level2-hero')` breaks that guarantee: nothing loaded that key, degradation to the placeholder never triggers, and Phaser silently renders its own "missing texture" checkerboard — which looks like a bug, not a graceful fallback.

3. **Other characters (NPCs/enemies) — same manifest-driven pattern, explicit guard.** `this.textures.exists(slug)` first (the manifest's `characters` record — see `GameCharacterEntry`'s optional `level` field for level-specific ones); if true, `this.physics.add.sprite(x, y, slug)`; if false, fall back to one of the template's existing placeholder shapes (`coin`/`obstacle`/a hand-drawn `Graphics` rect) — never an unconditional sprite creation against a key that might not exist. This is the same discipline point 2 already enforces for the one reserved slug, generalized to every other character.

4. **BGM — do not touch it from a level scene at all.** Playback starts exactly once, from `StartScene.handleStart()`'s `pointerdown` handler (the browser's required user gesture), and `this.sound` is the Game-level `SoundManager` — it is already playing by the time any level scene's `create()` runs. A new level scene needs zero BGM code. The mute toggle stays `UiScene`'s job, not something a level scene re-implements.

5. **HUD launch — same "don't re-derive" rule, orthogonal to assets.** Whichever scene is the new gameplay scene launches `UI` and stops it on shutdown exactly the way `GameScene.create()` already shows (`this.scene.launch('UI', { levelKey: this.scene.key })` + a `SHUTDOWN` listener that stops it) — copy that pair, not just the asset calls, into each replacement scene.

🔴 **Do not copy-paste the drawing logic itself between multiple `Level<N>Scene` files** — call `applyLevelBackground()` from each one. Hand-copying the `textures.exists()` + `add.image()` chain into five files is exactly the shape that goes stale the next time the fallback rule changes once and four of the five copies don't get the memo — the same reasoning `dimensions.ts` and `game-assets.ts` already apply to numeric/manifest constants, extended to a behavior.

## Common Patterns

### Full rebuild vs reuse-and-reset, side by side

```ts
// (a) Full rebuild — right when object population per level is variable/one-off.
class DungeonLevel extends Phaser.Scene {
  create(data: { levelId: number }) {
    this.levelId = data.levelId // re-set every time create() runs — see scenes skill Gotcha #13
    const level = LEVELS[this.levelId]
    for (const enemySpec of level.enemies) this.spawnEnemy(enemySpec)
    for (const pickupSpec of level.pickups) this.spawnPickup(pickupSpec)
  }

  onPlayerDied() {
    this.scene.restart({ levelId: this.levelId }) // tears down every spawned object, re-runs create()
  }
}

// (b) Reuse-and-reset — right when object count is fixed (a board/grid).
class MatchBoard extends Phaser.Scene {
  private tiles: Tile[] = [] // created once, in create(), never destroyed on replay

  create() {
    this.tiles = this.buildGrid() // runs exactly once across the object's lifetime
  }

  onBoardCleared() {
    for (const tile of this.tiles) tile.resetToStartingState() // same instances, fresh data
  }
}
```

### Event-driven HUD update (the `xxxChanged` convention)

```ts
// Wherever the value actually changes:
this.hp -= damage
this.events.emit('healthChanged', this.hp)

// UiScene, listening instead of polling:
gameScene.events.on('healthChanged', (hp: number) => this.healthText.setText(`HP: ${hp}`))
```

### Computing placement instead of guessing it

```ts
// Arcade-physics jump: airtime is symmetric (time up + time down) when takeoff
// and landing are the same height, so max horizontal distance is a plain
// projectile-motion calculation from constants you already have —
// never a number picked because it "felt right."
const gravityY = 800        // physics.arcade.gravity.y (+ any per-body gravity multiplier)
const jumpVelocityY = 420   // magnitude of the upward velocity set on jump
const moveVelocityX = 260   // horizontal velocity available while airborne

const airTimeSec = (2 * jumpVelocityY) / gravityY
const maxJumpDistancePx = moveVelocityX * airTimeSec

// Every gap the level places must be checked against this, not eyeballed:
console.assert(gapWidthPx < maxJumpDistancePx, 'gap exceeds max jump — level is uncrossable')
```

⚠️ The three constants above (`800` / `420` / `260`) are illustrative placeholders for the formula, not verified values for any specific game — see "Computed, Not Guessed" below for why this template does not ship recommended feel numbers.

## Self-Check Before Shipping

These two checks exist because "the code that implements a mechanic" and "the code that connects it to the rest of the game" are different things, and a mechanic can be fully written and still not do anything.

1. 🔴 **Is every state field you set actually read somewhere?** A real anti-pattern found during the research behind this skill: a project called `registry.set('level', 1)` and never once read `registry.get('level')` anywhere else in the codebase — the "level system" was structurally complete (correct API call, correct data shape) and completely inert. Grep every `registry.set(key, ...)` / `this.events.emit(name, ...)` you add for a matching `get`/`on` elsewhere before considering it done.
2. 🔴 **Does the restart path you wrote actually have an entry point?** Another real anti-pattern from the same research: a `loseHp()` method that placed a tombstone game object and called `destroy()` on the player — with no `scene.restart()`, no "press R," no menu link, anywhere in the codebase (a full-repo grep for the restart call came back with zero matches). The failure state was reachable; recovering from it was not. Trace the path a player would actually take from "I lost" back to "I'm playing again" and confirm each step exists in code, not just that the losing state itself is handled.

## Gotchas and Common Mistakes

1. **Treating the three HUD mechanisms as interchangeable stylistic choices.** They solve different problems (see "HUD Architecture" above). Picking `setScrollFactor(0)` in a scrolling multi-Scene game because it's the smallest diff, instead of a UI Scene, reproduces the exact overlap bug this skill exists to prevent the moment the camera starts moving.

   ```ts
   // BAD — HUD text lives in the same Scene as scrolling world geometry,
   // "fixed" after the fact with scroll-factor patches per element.
   class GameScene extends Phaser.Scene {
     create() {
       this.add.text(16, 16, 'Score: 0').setScrollFactor(0) // works only until the world grows past the visible band and something forgets this call
     }
   }

   // GOOD — HUD structurally cannot end up in world space; there's no
   // Scene boundary to forget to cross.
   class UiScene extends Phaser.Scene {
     create() {
       this.add.text(16, 16, 'Score: 0') // this Scene draws nothing else
     }
   }
   ```

2. **Hardcoding level geometry inline instead of externalizing it.** Makes every level a code change instead of a data change, and makes the "does this level even work" question unanswerable without running the game — see "Computed, Not Guessed" below for the specific case of reachability.

3. **Picking full-rebuild or reuse-and-reset by habit instead of by object-population shape.** Reusing objects in a level with unpredictable one-off spawns leaves stale enemies/pickups from the previous life half-reset; rebuilding a fixed-size board every restart is needless churn. Match the pattern to the level, per level if levels differ in shape.

4. **Global mutable state in a multi-Scene game, chosen because it's the smallest edit.** Works until a second Scene needs the same value and either duplicates it (drifts) or reaches across `Scene` instances directly (couples Scene lifecycles that should be independent). Use the registry or a state Scene once you have more than one Scene reading the same fact.

5. **Per-frame polling for every HUD element, including ones that change often.** Cheap for one gated `setText()` call (see Quick Start); becomes real waste once several elements each poll independently every `update()`. Prefer the `xxxChanged` event convention once you're past one or two HUD fields.

6. **A state field that's set but never read (see Self-Check #1).** This is not a hypothetical — it was found in real project research for this skill. Nothing about the code *looks* wrong; only tracing consumers reveals it does nothing.

7. **A failure/restart state with no way back to play (see Self-Check #2).** Also found in real project research. The losing path renders correctly and the bug is invisible from a screenshot of the game-over screen — it only shows up when you try to actually play again.

8. **Guessing "feel" numbers (jump velocity, gravity, move speed) instead of computing derived placement from them.** See "Computed, Not Guessed" — the direction of the mistake this skill can correct is always "level geometry follows from constants," never "constants follow from what looks right in the editor." This skill does not recommend specific feel values for that same reason: there is no evidence backing any particular number, only evidence backing the calculation method.

9. **Calling `this.sound.play()` anywhere except inside a real user-gesture handler.** Browsers silently refuse it otherwise — no exception, the call just does nothing, which is a confusing thing to debug from "the BGM just never plays." See "Platform-Delivered Assets" above: `this.load.audio()` (queuing the file) needs no gesture, only `this.sound.play()` (starting it) does. A start/title screen's own button click is usually the first real gesture available and the natural place to do this.

10. **Hardcoding a request for a platform-delivered asset instead of consulting its manifest first.** `this.load.image('title', 'assets/title.png')` unconditionally, without checking `game-assets.json` said that file exists, reproduces exactly the failure "Platform-Delivered Assets" above exists to prevent: a request with nothing behind it whenever the platform hasn't generated that asset yet (which, for any project mid-development, is the common case, not the exception).

11. **Deleting `GameScene` and not carrying its asset-consumption calls into whatever replaces it.** See "Writing a New Playable Scene? This Wiring Comes With It" above — this is the real incident this skill documents, not a hypothetical: five hand-written level scenes, zero `add.image` calls, zero `sound` calls, all-shape rendering, in a project whose builder explicitly asked for AI-generated art instead of shapes. `GameScene`'s gameplay is templated demo content and is meant to be replaced; `applyLevelBackground()` / `PLAYER_CHARACTER_KEY` / the BGM-stays-in-`StartScene` rule are not — they are the platform contract's consumer side, and they must land in every scene that plays a level, however many there end up being.

## Computed, Not Guessed

The one concrete before/after evidence behind this skill (2026-08-19, a platformer-genre project) is a level whose crossable gaps were originally placed at 85px and 35px — both comfortably inside the player's actual jump range, so the "obstacle" was not actually an obstacle; the level was trivially crossable without engaging the mechanic it was meant to test. The fix was not a bigger guess — it was computing the player's actual maximum jump distance from the scene's real physics constants (gravity, jump velocity, horizontal move speed — the same projectile-motion calculation shown in "Common Patterns" above), which came out to 217px, and then placing gaps at 300 / 347 / 394 / 441px — all verifiably beyond it. The level's own code comment records the intent directly: *"the unaltered level is genuinely uncrossable"* without the mechanic being used correctly.

Generalize this beyond jump gaps to any level-design relationship that is a *function of constants already in the code*: max jump distance vs. gap width, HUD band height vs. world/camera geometry (does a HUD Scene's reserved strip actually not overlap the gameplay camera's viewport at every supported resolution?), player move speed vs. minimum level length for a timed level to be theoretically completable. If the relationship can be computed from constants that already exist in your scene/config code, compute it and assert it — a comment stating the intended relationship ("the gap should be bigger than the max jump") is not the same as a runtime or build-time check confirming it actually is, and the 85px/35px level shows the two can silently diverge.

🔴 What this skill does **not** do: recommend specific gravity/velocity/speed values. There is no evidence base for what "feels good," only evidence for the calculation method once you've chosen those values some other way (playtesting, matching a reference game, etc.). Any SKILL.md that hands you a feel number without a game to back it is asking you to copy a guess.

## Version Honesty (Phaser 3 vs 4)

Every open-source project cited in this skill (`monster-tamer`, `phaser3-simple-rpg`, `reldens`, `digitsensitive`'s collection, `catch-the-cat`) is **Phaser 3**. A search for real, published Phaser 4 open-source games turned up none at the time this skill was written — the evidence base for the HUD-architecture and level-progression patterns above is entirely Phaser 3.

What can be said about Phaser 3 → 4 applicability: the official `v3-to-v4-migration` skill's own coverage does not list Scene Manager, ScaleManager, the registry/DataManager, or the camera system among the areas with breaking changes. That is **the migration guide not listing these areas** — not the same claim as "Phaser has confirmed no behavioral difference." Treat the patterns in this skill as **carrying over to Phaser 4 with unverified applicability**, not as confirmed-compatible, and re-check against `v3-to-v4-migration` and `v4-new-features` (`../../node_modules/phaser/skills/`) if a Phaser 4 project surfaces behavior that contradicts what's written here.
