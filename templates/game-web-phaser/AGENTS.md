# AgentDock Game-Web-Phaser Template — Agent Execution Boundaries

> For AI coding agents running autonomously in a VM, building on this project after it was scaffolded from AgentDock's `game-web-phaser` template.

This is a standalone Phaser 4 + Vite + TypeScript project — not part of a monorepo. There is no `core/features/infra` layering here; it's a single package. The rules below are the ones that matter for an agent working unattended in a VM.

## Hard rules — read before doing anything else

These rules exist because each one caused a real incident during earlier unstructured agent runs (or, for rule 9, a benchmark validation producing a shipped artifact with 0 data files and 3985 lines of hardcoded scene code). They are not style preferences.

### 1. Never run a long-lived server in the foreground

Any command that starts a dev/preview server (`pnpm dev`, `pnpm preview`, `vite`, `vite preview`, ...) **does not exit**. Running it as your foreground tool call blocks you until your tool call times out.

**Real incident:** an agent ran `npm start` directly and the process never returned control; the agent sat blocked for 15 minutes until the tool call itself timed out.

Always background it explicitly and detach it from your shell session, then verify separately:

```bash
setsid pnpm dev > /tmp/vite-dev.log 2>&1 < /dev/null &
disown

# give it a moment, then verify it's actually up
sleep 2
curl -sf http://localhost:8080/ > /dev/null && echo "server is up" || cat /tmp/vite-dev.log
```

`setsid` detaches the process from your shell's session so it survives your shell exiting; `disown` removes it from your shell's job table; redirecting stdin from `/dev/null` and stdout/stderr to a log file stops it from blocking on TTY I/O. Read `/tmp/vite-dev.log` to check on it — don't reattach to the process.

### 2. The server port is fixed at 8080 — do not change it

`vite.config.ts` pins both `server.port` and `preview.port` to `8080` with `strictPort: true`. The outer platform builds this project's share/preview link against that exact port. If you change it (or let something else occupy 8080 so Vite silently falls back to another port), the share link breaks with no visible error on your side.

If port 8080 is already in use when you start the server, that is a bug to fix (find and stop whatever's squatting on it), not a reason to move to a different port.

This project also has a second, non-public build target — `build:learn`, served on port 8090 (`preview:learn`) — that includes a debug panel `build:play` deliberately excludes. Which target you get is decided entirely by which npm script built it (`vite.config.ts`'s `build.outDir` branches on `--mode`), never by anything read at runtime in the browser. Don't add a client-side switch for the panel; see `src/debug/panel.ts`.

### 3. Commit after every completed step

This project's local git history is the only rollback mechanism available. There is no other undo. After each meaningful, working step (a scene added, a bug fixed, an asset wired in) — commit it:

```bash
git add -A
git commit -m "feat: <what you just did>"
```

Small, frequent commits over one giant commit at the end. If an edit breaks something, you want to be able to revert to the last good commit, not to the start of the session.

### 4. Chinese / non-Latin text: use `font-family`, don't ship font files

If the game needs Chinese (or other non-Latin) copy, set a system font stack in CSS — see `index.html` for the pattern already in place (`system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`). Do not download/embed a font file or add a `@font-face` that fetches one. It adds asset weight and a network dependency for something the OS already provides.

### 5. Self-verify against the real rendered page, not just property values — and test every key, not just one

**Real incident, part A:** an agent checked that `canvas.width` / `canvas.height` had sensible non-zero values and called the layout verified — but the canvas's _position on the page_ was wrong (this is exactly the bug the Scale Manager config in `src/config.ts` and the CSS reset in `index.html` now prevent structurally). A property value being "correct" tells you nothing about where the element actually landed visually.

**Real incident, part B:** the same investigation involved multiple keybindings; the agent tested `P` and never tested `Space` — and the Space-key bug was the one that mattered. Testing one path through a small set and calling it done left the real bug untouched.

So, before calling a UI or input change verified:

- Take an actual screenshot / rendered snapshot (headless browser, Playwright, whatever tool you have) and look at where things actually are — not just at attribute values in the DOM or console-logged numbers. **`pnpm verify` now automates the floor of this** (build succeeds, page loads with no uncaught exception/failed request, screenshot is provably non-empty, canvas has real size) — see the acceptance checklist below. It does not replace looking at the game, it replaces "I forgot to look at all."
- If the feature involves more than one key/input/branch, exercise **all** of them, not just the first one that comes to mind. Space and arrow keys specifically — this template captures them (rule in `src/scenes/GameScene.ts`), but if you add more keys, verify each one individually. `pnpm verify` does **not** simulate keyboard input — this part is still yours to do by hand.

### 6. If the game's acceptance criteria include machine-judgable ("machine") items, keep `window.__gameHarness` honest as you change scenes

The outer platform can attach a project-root `assertions.json` (see the sample one already in this project) — a list of the 8 upstream assertion templates (`loads_clean` / `controllable` / `restart` / `hud_text_present` / `value_persists` / `score_feedback` / `game_over_trigger` / `data_from_files`) with parameters. `pnpm verify` judges every one of them against the **built artifact**, right after the BH gates, using `src/debug/harness.ts`'s `window.__gameHarness` — the same contract `src/debug/state-jump.ts`'s `jump()`/`isValidStart()` already established for state legality. If you add a scene, a new key, a new triggerable event, or a new persisting stat, this harness has to keep describing the *real* game, or the templates that depend on it silently degrade to "can't judge this" (never a false pass — see below):

- **New `StateRole`**: every `id` returned by `listStates()` (`src/debug/state-jump.ts`) needs an entry in `harness.ts`'s `STATE_ROLES` map. `game_over_trigger`/`restart` judge by **role** (`'gameplay'`/`'gameover'`), never by the scene's engine key — that's what lets a template's judgement survive you renaming a scene.
- **New key**: add it to `harness.ts`'s `KEY_TABLE` (DOM `KeyboardEvent.code` → Phaser `KeyCodes`) or `controllable`/`restart` assertions referencing it will report "not recognized by press()" instead of judging your game.
- **New triggerable event** (a scoring condition, a failure condition, …): call `registerTrigger('name', handler)` from the scene's `create()` (see `GameScene.ts`'s two calls for the pattern) so `score_feedback`/`game_over_trigger` can `fire()` it. 🔴 **The handler may only do what a real player's own actions could cause** — spawn something in the world and let the existing overlap/collision logic react (`GameScene.ts`'s `spawnCoinAtPlayer`/`spawnObstacleAtPlayer`) — **never write score/state directly** (`this.score += n` inside a trigger handler is a violation, even though nothing mechanically stops it — see `src/debug/harness-types.ts`'s `GameHarness` doc for the allow/forbid table this is part of). **The platform judges this, not just human review**: `src/debug/harness.ts`'s `fire()` reads the coordinates of the entity named `player` synchronously immediately before and immediately after calling the trigger's handler (no `await` between the two reads — nothing can insert a physics step in between) and throws if they differ at all, however small the change. A handler that teleports the player to its target instead of spawning something for the player to collide with is therefore a build-breaking failure — `pnpm verify` exits non-zero, and the offending assertion is recorded with a hint naming the trigger and the before/after coordinates — not something a reviewer has to notice by reading the diff. **This makes `player` a naming *contract*, not a habit**: the reference player sprite keeps `this.player.name = 'player'` (`GameScene.ts`), and any project that wants this check to mean anything for its own player-controlled entity must name it `player` too. A project with no entity named `player` does not fail this check — but `pnpm verify`'s `.verify-result.json` will visibly record that the check did not run for it (see this rule's `absent`/`unavailable` distinction above: an inapplicable check is recorded, never silent).

  BH-2 also checks, independently of `assertions.json`, that every named entity in `getSnapshot().entities` stays within the game's world bounds (`physics.world.bounds` when set, else the canvas/design-resolution size) with a small margin — a named object that has fallen or drifted off-screen (e.g. `setImmovable(true)` without also `setAllowGravity(false)`, so gravity keeps pulling it down forever) fails BH-2 on its own, independent of whether any trigger touched it.
- **New persisting stat** (a second `highScore`-shaped value, lives, an inventory count, …): expose it from `harness.ts`'s `readValues()` the same way `highScore` already is, so `value_persists` has something to check. A value that only exists in a scene's local field and is never read back here will make that template report "can't judge this," not fail — see the next paragraph.
- **Do not add a setter to `GameHarness`** (`setScore`, `setState`, anything that writes a value directly). Every method on it is either a pure read or something a real player could already trigger (`press()` dispatches a real `KeyboardEvent`, `applyState()` only lands on states `isValidStart()` accepts). If a change genuinely needs a new write-shaped harness method, that is a contract change, not a scene change — stop and ask a human before adding one.

`pnpm verify`'s IA output distinguishes three things and will never blur them together: **judged & passed**, **judged & failed** (a real defect — the failure detail names the assertion and what it saw), and **can't judge** (`absent` — no `assertions.json` — or `unavailable` — the harness above doesn't cover what an assertion needs yet, or isn't installed at all). 🔴 `absent` and `unavailable` are **not** the same thing, and only one of them is benign:

- **`absent`** — nobody asked for IA. Nothing was skipped, nothing turns red, `pnpm verify` still exits 0.
- **`unavailable`** — someone *did* ask (there is an `assertions.json`) and the gate could not run: no harness in the artifact, a `schemaVersion` this runner doesn't understand, the runner threw. That is a gate being skipped, so it counts as a failure: `passed: false`, a red `IA` row in `gates[]`, and a non-zero exit — exactly like a BH gate failure. **If you see `unavailable`, implement rule 6's harness; do not read it as "nothing to do here".**
- **`judged` with at least one failing item** — a real defect. Same treatment: non-zero exit, `passed: false`.

### 7. HUD and world geometry never share space — draw them in different scenes

`src/dimensions.ts` reserves a bottom strip `HUD_BAND_HEIGHT` pixels tall; `PLAYFIELD_HEIGHT = GAME_HEIGHT - HUD_BAND_HEIGHT` is everything left for gameplay. World geometry (ground, platforms, spawn points, `physics.world.setBounds(...)`) must stay within `y ∈ [0, PLAYFIELD_HEIGHT]`. HUD content (score, buttons, status text) must stay within `y ∈ [PLAYFIELD_HEIGHT, GAME_HEIGHT]` and belongs in `src/scenes/UiScene.ts` — a scene launched in parallel with `GameScene` (`this.scene.launch('UI')`), not inside `GameScene` itself. Do not add HUD elements directly to a gameplay scene; add them to `UiScene.ts` and pin them with `setScrollFactor(0)`.

### 8. Platform-delivered assets: consult `game-assets.json`, never request a file it didn't confirm

The outer platform can drop AI-generated art/audio into `public/assets/` (`title.png`, `bg/level<N>.png`, `char/<slug>.png`, `bgm/main.mp3`) alongside a manifest at `public/game-assets.json` describing them (contract: `src/game-assets.ts`). That manifest may not exist yet — most of a project's life, it won't. Two rules:

- **Never hardcode a `this.load.image()`/`this.load.audio()` call for one of these paths without the manifest having confirmed it first.** `src/scenes/PreloadScene.ts`'s `queueManifestAssets()` — driven by the pure, unit-tested `planAssetLoads()` in `src/game-assets.ts` — is the only place that decides what to request, precisely so "missing manifest ⇒ request nothing" stays a checkable fact (`tests/game-assets.test.mjs`), not something a reviewer has to trust by reading Phaser plumbing. A missing manifest or a 404'd individual file must never throw or leave the game half-loaded — see `src/scenes/StartScene.ts`/`GameScene.ts`'s use of `this.textures.exists(...)` for the fallback pattern to copy.
- **Starting background music requires a real user gesture.** `this.sound.play()` called anywhere outside a click/keypress/tap handler is silently refused by the browser's autoplay policy — no exception, it just does nothing. This template's reference fix starts BGM from `StartScene`'s "开始游戏" button `pointerdown` handler and nowhere else; see `skills/game-flow-and-hud/SKILL.md`'s "Platform-Delivered Assets" section for the full reasoning. `GameScene.applyHarnessState()` ALSO starts it (same idempotent guard) — but only for `window.__gameHarness`'s synthetic `applyState()` path, never for a real playthrough — see the 🔴 paragraph right below for why that's there.

🔴 **A manifest confirming a file exists is not the same as the game actually drawing/playing it — and "something, somewhere, is used" is not the same as "each declared asset is used".** Real incident: a generated project's manifest declared title/backgrounds/3 characters/bgm, `PreloadScene` queued and loaded every file, and BH-0/BH-1/BH-2/IA all passed, and the AU gate (below) as first shipped ALSO passed — because title and one background were in active use, even though all 3 characters and the bgm never were. The builder's own playtest complaint was, word for word, "没有背景音乐，没有使用 AI 设计的人物形象". `pnpm verify`'s **AU (asset usage)** gate now judges **per category**, not "at least one thing in use overall": right after BH-2, it re-derives the manifest's asset-load plan, checks each declared key actually reached the texture/audio cache, then applies `scripts/lib/asset-usage.mjs`'s `classifyAssetKey()` (mirrors `game-assets.ts`'s well-known keys: `title`, `bgm`, `"bg-level" + N`, else a character slug) to require: **bgm** declared ⇒ must be in `usedInScene`; **background** declared ⇒ at least one declared background key must be in `usedInScene` (not every level — only scenes active at snapshot time are scanned, so an unvisited level's background is expected to show 0 use); **character** declared ⇒ the reserved `"player"` key (see `src/game-assets.ts`'s `PLAYER_CHARACTER_KEY`) must be in `usedInScene` — declaring it is the manifest's own statement that this character IS the player sprite, so loaded-but-never-worn fails the gate (real incident, trial-08: a project shipped with the protagonist texture in the cache and a placeholder square as the actual player, passing as "1/3 in use" because a side character was on screen); every other character keeps the lenient rule — at least one of them must be in `usedInScene`, with every unused one named in `reason`; **title** is never required, informational only. See `src/debug/harness.ts`'s `readAssetUsage()`/`usedImageKeys()`/`usedAudioKeys()` and `scripts/lib/asset-usage.mjs`'s judge for the mechanism. Same three-state discipline as rule 6's IA gate: **`absent`** (no manifest — not a failure), **`unavailable`** (couldn't judge — counts as failure), **`judged`** (a real pass/fail, `.verify-result.json`'s `assetUsage` field, `reason` naming every failing category). If you write a new level scene that consumes a manifest asset a different way than `applyLevelBackground()`/`PLAYER_CHARACTER_KEY`, make sure it still ends up as a real `GameObject` with that texture key attached (or a real `this.sound.add()`/`.play()` call for audio) — that GameObject/Sound existing is exactly what this gate checks for, and what it cannot check is whether the result looks good.

🔴 **This is also why `GameScene.applyHarnessState()` starts bgm too, not only `StartScene`'s click.** `src/debug/harness.ts`'s `applyState()` reaches `'Game'` via `game.scene.start(id)` directly — never a real click — so a per-category bgm check would otherwise fail on *every* correctly-built project, including this template's own unmodified reference implementation (confirmed by hand: `pnpm verify` on an untouched scaffold with a declared bgm failed AU until this was added). `applyHarnessState()` only ever runs from the harness's synthetic `applyState()`, never from a real playthrough, so real users' autoplay-gesture behavior is unchanged — this only completes the harness's own premise (design D2: reaching `'Game'` via `applyState()` means "a state a real player could legitimately be in", and `Start`'s click is the only door into `'Game'`, so any real player there already triggered bgm).

### 9. Gameplay content lives in `public/game-data.json` — scene classes are interpreters, not data files

**Real incident (the reason this rule exists):** a benchmark-validation artifact shipped with **0 independent data files vs 3985 lines of scene code** — vocabulary, levels and rules all hardcoded in scene classes — and passed every machine gate, because nothing could see the difference. The scaffold taught that shape (constants at the top of the scene class), so executors faithfully copied it. The rule is the structural fix:

- **New level / new rule / new word list = an edit to `public/game-data.json`** (`levels` / `rules` / `vocabulary` sections; extend a section if the shape doesn't fit yet). The scene class builds from what the data says — same scene class, different data, different level (换数据即换关). `src/game-data.ts` is the only door: `PreloadScene` loads the file and calls `initGameData()` (required — a missing/empty-shell manifest throws at load time and fails BH-1, by design), and scenes take entries via its accessors (`getActiveLevel()` / `getLevelById()` / `getGameRules()` / `getVocabulary()`).
- **Scene classes MUST NOT carry content definitions** — no per-level geometry (spawn points, placements), no rule values (speeds, score weights), no word lists as constants. Infrastructure constants that have nothing to do with a *specific* level's content (canvas size, HUD band, physics world setup, scene flow) are the interpreter and stay in code. The upstream criterion this mirrors, word for word: 玩法内容（关卡/规则/词表）定义在独立数据文件中，且运行时实际从数据文件加载（场景代码不承载内容定义）.
- The upstream `data_from_files` assertion (in the sample `assertions.json`) judges exactly this, from three layers of evidence in `getSnapshot().data`: `declared` (what the manifest says) / `loaded` (the loader actually initialized) / `usedInScene` (a scene build actually took entries through the accessors). **All three must be non-empty; a missing manifest is a FAILURE, not an unmet precondition** — that asymmetry with rule 6's trigger/state preconditions is deliberate and is the whole point of the template. What it honestly cannot catch: a scene that consumes an entry and then ignores it (double bookkeeping) — don't do that either, but know the gate's boundary.
- Do not bypass `src/game-data.ts` (fetching the JSON yourself, or importing data as a TS module): bypassing leaves `usedInScene` empty, which fails the gate — the bypass is what's wrong, not the gate.

## Project layout

```text
index.html            # entry HTML + the CSS reset that keeps the canvas positioned correctly
vite.config.ts         # dev/preview server config — port 8080 pinned (rule 2), build:play/build:learn outDir split
assertions.json        # sample machine-judgable acceptance items (rule 6) — one per upstream template
public/
├── game-data.json     # the gameplay-content data layer (rule 9): levels / rules / vocabulary
└── game-doc.json      # in-game documentation panel content (default-hidden)
scripts/
├── verify.mjs          # pnpm verify — BH-0/BH-1/BH-2 + AU (asset usage) gates + IA assertion judging, one CDP session
├── assert.mjs           # the IA judging engine verify.mjs calls; also runnable standalone (`node scripts/assert.mjs`)
└── lib/                 # shared CDP/browser/static-server/PNG/entity-bounds/asset-usage plumbing scripts above use
tests/
├── state-jump.test.mjs  # traversal assertion for src/debug/state-jump.ts
├── harness-types.test.mjs # bare-Node import guard for src/debug/harness-types.ts
├── assert.test.mjs        # per-template judge tests (positive + negative) and design D6's order-independence test
├── asset-usage.test.mjs   # AU gate's absent/unavailable/judged tri-state (rule 8)
├── game-data.test.mjs     # data-layer validation, accessors, consumption registry, three-layer evidence (rule 9)
├── data-spine.test.mjs    # structural: scene classes carry no content constants; PreloadScene initializes the data layer
├── exit-decision.test.mjs # design D8's exit-code rule
└── png.test.mjs           # non-empty-screenshot judgement, incl. the required solid-colour negative case
src/
├── main.ts            # creates the Phaser.Game instance — should rarely need edits
├── config.ts           # Phaser.Types.Core.GameConfig — Scale Manager lives here
├── game-assets.ts       # game-assets.json manifest contract (AI-generated title/bg/char/bgm) — see rule 8
├── game-data.ts         # game-data.json contract: validation + accessors + consumption registry — see rule 9
├── debug/
│   ├── state-jump.ts    # listStates/jump/isValidStart contract + reference impl (Boot/Preload/Start/Game/GameOver)
│   ├── harness-types.ts # window.__gameHarness contract types — zero imports, see rule 6
│   ├── harness.ts        # window.__gameHarness reference implementation — see rule 6 before editing scenes
│   └── panel.ts          # learn-build-only debug panel; never gate this with a runtime switch
└── scenes/
    ├── BootScene.ts     # engine-level setup only, runs first
    ├── PreloadScene.ts  # load assets + initialize the data layer (rule 9), generate placeholder textures, show progress
    ├── StartScene.ts     # title/start screen — the only way into Game; also where BGM playback starts (see rule 8)
    ├── GameScene.ts     # the playable scene, built FROM game-data.json (rule 9) + the input-capture reference pattern
    ├── UiScene.ts        # HUD layer, launched parallel to GameScene — see rule 7 (HUD band / playfield)
    └── GameOverScene.ts # the failure state (`role: 'gameover'`) + restart-to-gameplay
```

Keep this split. Don't collapse Boot/Preload/Game back into one file — it's what makes the loading screen, the asset pipeline, and gameplay independently replaceable and testable.

## May execute autonomously

- `pnpm install`, `pnpm build`, `pnpm check-types`, `pnpm test`, `pnpm verify`
- Starting/stopping the dev server **in the background** (rule 1)
- Adding scenes under `src/scenes/`, adding assets under `public/`
- Editing any file in `src/`
- `git add` / `git commit` (local only)

## Must pause and confirm with a human

- `git push` (any remote operation)
- Adding new dependencies to `package.json`
- Changing `vite.config.ts` port settings (rule 2)
- Deleting any file not created in the current session

## Prohibited

- Foregrounding a long-lived process (rule 1)
- Writing real secrets/API keys anywhere in the repo
- `rm -rf` on tracked directories
- Bypassing git hooks with `--no-verify`, if hooks are later added to this project

## Acceptance checklist before calling a task done

1. `pnpm check-types` — exits 0.
2. `pnpm verify` — exits 0. This is the executable replacement for "build it and take a screenshot": it builds `dist-play/` (BH-0), loads it in real headless Chromium over CDP and fails loudly if the page throws an uncaught exception or has a failed resource request (BH-1), and fails loudly if the rendered screenshot is provably empty (solid-colour PNG, not just "a PNG exists"), the game canvas has zero size, or any named entity (`getSnapshot().entities`) has drifted outside the game's world bounds (BH-2). If `public/game-assets.json` declared anything, it also fails loudly if none of the declared assets reached the texture/audio cache, or if bgm/background/character each fail their own per-category usage rule (AU — see rule 8). Read `scripts/verify.mjs` for the exact judgement, and `pnpm test` for the unit tests behind it (`tests/`). If this project has an `assertions.json`, `pnpm verify` also judges every item in it against `window.__gameHarness` right after the BH/AU gates (same CDP session, no second page load) and exits non-zero if any of them fail — see rule 6 above before touching scenes if this project uses machine-judgable acceptance items.
3. Dev server started **in the background** (rule 1), and reachable at `http://localhost:8080/`.
4. Every interactive key/control your change touches has been pressed and observed, not just one of them (rule 5). `pnpm verify` does not simulate keyboard input — **`node scripts/playtest.mjs` does**. Run it before you say you're done:
   ```bash
   pnpm build:play
   node scripts/playtest.mjs --state <your final level> --press ArrowRight,Space
   ```
   It jumps to a state, presses the keys you name, and prints each named entity's coordinates before and after every press, plus a screenshot. 🔴 **It never judges — it prints numbers, you read them.** It cannot know which entities are *supposed* to move: a level's goal marker sitting still and your player sitting still produce the identical `dx=0.0 dy=0.0` reading, and only you know which one is a bug. That distinction is the whole reason this is a script and not a gate — no gate in this template can make it either. Paste the output into your report; "I verified it works" without those numbers is not evidence.
   🔴 **Do not hand-write your own CDP/eval expressions to do this.** Measured on a real run: 3 of that run's 7 blockers were mistakes inside hand-written expressions (`Illegal return statement`, `Phaser is not defined`, calling `.then()` on the synchronous `getSnapshot()`) — none of them were about the game.
5. Working state committed to git (rule 3).
