# {{PROJECT_NAME}}

> Generated from the [AgentDock](https://github.com/CogitoTech/agentdock) `game-web-phaser` template.

A minimal, structurally-correct Phaser 4 + Vite + TypeScript starter for browser games — built for AI coding agents working autonomously in a VM as much as for humans. See `AGENTS.md` for the execution rules that apply while working in this project, and `PROJECT_CONTEXT.md` for cross-session handoff notes.

## Tech Stack

| Layer    | Technology                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| Engine   | [Phaser 4](https://phaser.io)                                                   |
| Bundler  | [Vite](https://vitejs.dev)                                                      |
| Language | [TypeScript](https://www.typescriptlang.org) (strict mode)                      |
| Runtime  | Node.js ≥ 22 (the zero-dep `pnpm verify` needs the built-in `WebSocket` global) |

## Directory Structure

```text
index.html           # entry HTML — includes the CSS reset that keeps the canvas positioned correctly
vite.config.ts        # dev/preview server config — fixed port 8080, see below; build:play/build:learn outDir split
assertions.json        # sample machine-judgable acceptance items — see "Verifying" below
public/
├── game-data.json     # the gameplay-content data layer — levels / rules / vocabulary, see "Gameplay content data" below
└── game-doc.json      # in-game documentation panel content (default-hidden)
scripts/
├── verify.mjs          # pnpm verify — zero-dep headless-Chromium/CDP checks + assertion judging, see "Verifying" below
├── assert.mjs           # the assertion-judging engine verify.mjs calls (also runnable standalone)
└── lib/                 # shared CDP/browser/static-server/PNG plumbing
tests/                 # unit tests for verify's judgement, the assertion judges, and the state-jump contract (pnpm test)
src/
├── main.ts           # boots the Phaser.Game instance, installs window.__gameHarness
├── config.ts          # Phaser.Types.Core.GameConfig — Scale Manager configured here
├── game-assets.ts      # game-assets.json manifest contract — AI-generated title/bg/char/bgm, see "Adding assets" below
├── game-data.ts         # game-data.json contract — validation + accessors + consumption registry, see "Gameplay content data" below
├── debug/
│   ├── state-jump.ts   # listStates/jump/isValidStart contract + a minimal reference implementation
│   ├── harness-types.ts # window.__gameHarness contract types (zero imports)
│   ├── harness.ts        # window.__gameHarness reference implementation
│   └── panel.ts          # debug panel — only ever included in the build:learn bundle
└── scenes/
    ├── BootScene.ts    # runs first, engine-level setup only
    ├── PreloadScene.ts # loads assets + initializes the data layer / generates placeholder textures, shows a loading bar
    ├── StartScene.ts    # title/start screen — the only way into Game; also where BGM playback starts (autoplay policy)
    ├── GameScene.ts    # the playable scene, built FROM game-data.json — also the reference pattern for keyboard input
    ├── UiScene.ts       # HUD layer, launched parallel to GameScene — see AGENTS.md rule 7 (HUD band / playfield)
    └── GameOverScene.ts # the failure state + restart-to-gameplay
```

## Getting Started

### 1. Prerequisites

- Node.js ≥ 22
- pnpm (or npm/yarn — this template has no workspace-only dependencies)

### 2. Install dependencies

```bash
pnpm install
```

### 3. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:8080](http://localhost:8080). The port is fixed at `8080` (see `vite.config.ts`) — the platform hosting this project builds share/preview links against that exact port, so don't change it.

> Running as an autonomous agent? Start this in the **background**, never in the foreground — see rule 1 in `AGENTS.md`.

### 4. Build for production

```bash
pnpm build:play     # public share build → dist-play/, no debug panel
pnpm build:learn    # non-public build → dist-learn/, includes the debug panel
pnpm preview         # serves dist-play/ on port 8080
pnpm preview:learn   # serves dist-learn/ on port 8090
```

`pnpm build` (no target) is an alias for `pnpm build:play`. See [Two build targets](#two-build-targets) below for why there are two.

### 5. Type-check

```bash
pnpm check-types
```

### 6. Verify

```bash
pnpm verify
```

Builds `dist-play/`, loads it in real headless Chromium over CDP, and fails loudly (non-zero exit) if the build fails, the page throws an uncaught exception or has a failed resource request, or the rendered screenshot is provably empty or the canvas has zero size. If `public/game-assets.json` declared anything, it also fails loudly if none of the declared files reached the runtime, or if they loaded but nothing currently draws/plays them. If this project has an `assertions.json` at its root, `pnpm verify` also judges every item in it — same browser session, right after those checks — and fails loudly if any of them do. See [Verifying](#verifying) below and `scripts/verify.mjs`.

```bash
pnpm test
```

Runs the unit tests behind `verify` (the screenshot-emptiness judgement, the assertion judges, the exit-code rule) and the state-jump contract's traversal assertion (`tests/`), via Node's built-in test runner — no test framework dependency.

## What's already wired up

This template exists to structurally prevent bugs hit by earlier unstructured (vanilla JS + Canvas) agent-built games:

1. **Canvas positioned wrong / content below unreachable.** Fixed by Phaser's Scale Manager (`scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }` in `src/config.ts`) combined with a CSS reset in `index.html` that pins the canvas's parent element to the full viewport. Both pieces are required — the Scale Manager only centers the canvas _inside its parent_; the CSS makes sure the parent itself is positioned correctly.

2. **Space key makes the screen go blank and the page lock up, while audio keeps playing.** Fixed by binding all game input through Phaser's own Keyboard plugin (`this.input.keyboard`, scene-scoped, torn down with the scene) instead of raw `window`/`document` listeners, and by calling `keyboard.addCapture([...])` for every key the browser also binds to something (Space/arrows scroll the page by default). See the class-level comment in `src/scenes/GameScene.ts` for the full writeup and the reference pattern to copy for any new input you add.

3. **"I ran the agent and it said done" being the only signal a change actually worked.** Fixed by `pnpm verify` (`scripts/verify.mjs`) — see [Verifying](#verifying) below.

4. **"The health-check gates pass" being conflated with "the acceptance criteria are met."** A build that loads and renders can still be uncontrollable, never show a score, have no failure state, or hardcode all its content in scene classes — none of that shows up in a screenshot's pixel variance. `window.__gameHarness` (`src/debug/harness.ts`) plus `scripts/assert.mjs` close that gap for the 8 machine-judgable acceptance templates the outer platform can attach via `assertions.json` — see [Verifying](#verifying) below.

## Two build targets

| Target | Command                            | Output        | Port                        | Debug panel |
| ------ | ---------------------------------- | ------------- | --------------------------- | ----------- |
| Play   | `pnpm build:play` (= `pnpm build`) | `dist-play/`  | 8080 (`pnpm preview`)       | No          |
| Learn  | `pnpm build:learn`                 | `dist-learn/` | 8090 (`pnpm preview:learn`) | Yes         |

`dist-play/` is what a share link points at — the outer platform builds those links against the fixed, `strictPort`-enforced port 8080, and a student opening one should see the game, not a debug overlay. `dist-learn/` is for the person building the game.

Which target you get is decided by `--mode` on the `vite build` CLI (see `vite.config.ts`'s `build.outDir` branch and `src/main.ts`'s `import.meta.env.MODE` check) — **not** by a runtime switch anyone could flip in the browser. If you add more learn-only tooling, gate it the same way: import it from inside an `if (import.meta.env.MODE === 'learn')` branch so it's dead code, not just hidden, in `dist-play/`.

## Verifying

`pnpm verify` (`scripts/verify.mjs`) runs four gates, zero new dependencies — it spawns whatever Chromium already exists on the machine (Playwright's cache, `CHROME_PATH`, or `PATH`) and speaks CDP over Node's built-in `WebSocket` (Node ≥ 22):

- **BH-0 build** — `vite build --mode play` exits 0.
- **BH-1 load** — headless Chromium loads `dist-play/` with no uncaught JS exception and no failed resource request.
- **BH-2 render** — the screenshot is provably non-empty (unique-colour count + pixel variance both clear a floor — a solid-colour PNG does **not** pass) and the game canvas has non-zero size.
- **AU asset usage** — if `public/game-assets.json` declared anything, its files actually reached the runtime AND each *category* of asset (bgm/background/character/title) is used per its own rule, not just "something, somewhere, is used". See [Asset usage judging (AU)](#asset-usage-judging-au) below.

Every gate either passes or prints exactly what it expected vs. what it found and exits non-zero — it never prints "skipping" and exits 0. If it can't find a browser or the Node runtime lacks `WebSocket`, that's a failure, not a skip.

### Asset usage judging (AU)

A manifest confirming a file exists is not the same as the game actually drawing or playing it. Real incident this gate exists to catch: a generated project's `game-assets.json` declared backgrounds/characters, `PreloadScene` loaded every file, and every other gate above passed — but the level scenes never called anything that consumed them, so `add.image` was hit 0 times across every level and there was no BGM, and nothing caught it until a human played the game.

Right after BH-2, if `public/game-assets.json` declared anything, `pnpm verify` re-derives the same asset-load plan `PreloadScene` used and checks, over the same CDP session:

1. **Declared → loaded** — did each declared texture/audio key actually reach `this.textures`/`this.cache.audio`?
2. **Loaded → used, per category** (`scripts/lib/asset-usage.mjs`'s `classifyAssetKey()`) — a single asset somewhere being on screen is **not** enough (an earlier version of this gate worked that way and a real project shipped with 3 unused characters and no BGM while still passing, because the title and one background WERE in use). Each category has its own rule instead:
   - **bgm** — declared ⇒ MUST be in `usedInScene` (there's only ever one bgm key, so this is a plain yes/no).
   - **background** — declared ⇒ at least one declared background key MUST be in `usedInScene`. This is deliberately not "every level's background": a snapshot only scans scenes active *right now*, so a level this run's probes never visited is expected to show 0 use for its own background and must not be held against the project.
   - **character** — split by the reserved key: a character keyed `"player"` (see `src/game-assets.ts`'s `PLAYER_CHARACTER_KEY`) declared ⇒ MUST be in `usedInScene`, same zero-tolerance as bgm — declaring the reserved key is the manifest's own statement that this character IS the player sprite, so "loaded but never worn by the player" fails the gate (real incident: a project shipped with the protagonist texture in the cache and a placeholder square as the actual player, passing as `characters 1/3 in use` because a side character was on screen). Every other character keeps the lenient rule: at least one declared character MUST be in `usedInScene` (a game legitimately may not use every generated side character), any unused ones always named in `reason`.
   - **title** — never required (the title texture only makes sense on the start screen; a later probe may have legitimately left it behind), reported for visibility only.

Results land in `.verify-result.json`'s `assetUsage` field with the same three-status discipline as IA below: **`absent`** (no manifest — not a failure), **`unavailable`** (couldn't judge — counts as a failure), **`judged`** (a real pass/fail, `reason` naming every failing category by name). A `judged`-with-`passed: false` or `unavailable` result makes `pnpm verify` exit non-zero, same as any other gate.

🔴 **Why `GameScene.applyHarnessState()` also starts bgm, not just `StartScene`'s click.** `StartScene.handleStart()`'s `sound.play()` call is real players' only path to audio — a browser autoplay gesture requirement, unchanged. But `src/debug/harness.ts`'s `applyState()` reaches `'Game'` by calling `game.scene.start(id)` directly, never by dispatching a real click, so a per-category AU judge that requires bgm to be `usedInScene` would otherwise fail on *every* project doing this correctly, including this template's own unmodified reference implementation (confirmed by hand). `applyHarnessState()` is only ever invoked from `applyState()` (never from a real playthrough), and `design D2` already treats reaching `'Game'` there as "a state a real player could legitimately be in" — which, since `Start`'s click is the only door into `'Game'`, implies bgm would already be playing for any real player standing there. Mirroring the same idempotent `cache.audio.exists() && !sound.get()` guard in that hook makes the harness's simulation match that implication, with zero effect on real playback timing.

🔴 What this gate proves and what it doesn't: a "used" hit means a real GameObject/Sound exists with that key attached — it does **not** prove the asset looks correct, is sized right, or (for audio) is actually audible right now (browser autoplay policies can block playback even after `.play()` runs). See `src/debug/harness-types.ts`'s `AssetUsageSnapshot` doc and `scripts/lib/asset-usage.mjs`'s header for the full reasoning.

### Assertion judging (IA)

If a project-root `assertions.json` exists — a list of machine-judgable acceptance items, each naming one of 8 upstream templates and its parameters — `pnpm verify` judges every one of them right after BH-2/AU, over the **same** browser session (no second page load), by driving the live game through `window.__gameHarness` (`src/debug/harness.ts`):

| templateId          | what it checks                                                                    |
| -------------------- | ----------------------------------------------------------------------------------- |
| `loads_clean`         | reuses BH-1's own evidence — no uncaught exception, no failed resource request      |
| `controllable`        | pressing a key moves a named entity's x/y                                          |
| `restart`             | a trigger returns the game to a `gameplay`-role state with score reset to 0        |
| `hud_text_present`    | a substring appears in `getSnapshot().hudTexts` while in a given state             |
| `value_persists`      | a named value in `getSnapshot().values` is unchanged across a state transition     |
| `score_feedback`      | firing a scoring trigger changes the HUD text (checks the **text**, not the internal score field — an internal-only change is the bug this one exists to catch) |
| `game_over_trigger`   | firing a failure trigger lands on a `gameover`-role state                          |
| `data_from_files`     | the three data-layer evidence layers in `getSnapshot().data` (`declared`/`loaded`/`usedInScene`) are all non-empty — gameplay content is defined in `public/game-data.json` and actually loaded by the running game. 🔴 A missing manifest is a **failure**, never an unmet precondition — that asymmetry is the whole point (see "Gameplay content data" below) |

Results land in `.verify-result.json`'s `assertions` field with one of three statuses, never blurred together: **`judged`** (every item got a real pass/fail — see `results[]`), **`absent`** (no `assertions.json` — this is not a failure), or **`unavailable`** (a clean `assertions.json` exists but nothing could judge it, e.g. `window.__gameHarness` isn't installed). `judged`-with-failures and `unavailable` both make `pnpm verify` exit non-zero and write `passed: false`, same as a BH gate failure — a gate that could not run is not a gate that passed. Only `absent` is benign: a project that never opted into assertions stays green.

`scripts/assert.mjs` can also run standalone (`node scripts/assert.mjs`, after `pnpm build:play`) for iterating on assertion judging without re-running the full BH pipeline — that path opens its own browser session instead of reusing `verify`'s.

If you're building on this template and want `pnpm verify` to actually judge your game's acceptance criteria (not just report `unavailable`), read rule 6 in `AGENTS.md` before changing scenes.

## Adding assets

### Gameplay content data (levels / rules / vocabulary) — REQUIRED

This template's answer to "what is a game" is **data + interpreter**: gameplay content lives in `public/game-data.json` (`levels` / `rules` / `vocabulary` sections; contract: `src/game-data.ts`), and scene classes are the interpreter that reads it. `PreloadScene` loads the file and calls `initGameData()` at load time — strict validation, so an empty-shell or malformed manifest fails **loudly** (BH-1), never silently. Scenes take entries through the accessors (`getActiveLevel()` / `getLevelById()` / `getGameRules()` / `getVocabulary()`); the loader records what they take, and `getSnapshot().data` exposes it as three evidence layers for the upstream `data_from_files` assertion.

- **New level / rule value / word list = an edit to `game-data.json`**, not a new constant in a scene class. Same scene code, different data, different level (换数据即换关). This is AGENTS.md rule 9, and the reason it is a hard rule rather than a suggestion: a benchmark artifact once shipped 0 data files next to 3985 lines of hardcoded scene code and passed every machine gate, so the gate now exists and the scaffold teaches the data-driven shape.
- Don't bypass `src/game-data.ts` (hand-fetching the JSON, or inlining content back into scene classes): the bypass itself leaves `usedInScene` empty and fails `data_from_files` — the bypass is what's wrong, not the gate.

### Platform-delivered assets (AI-generated title/backgrounds/characters/BGM)

This template's reference scenes (`StartScene`, `GameScene`, `UiScene`) read a manifest at `public/game-assets.json` (contract: `src/game-assets.ts`) describing files the outer platform generates and drops into a fixed directory layout:

```text
public/assets/title.png          start-page hero image
public/assets/bg/level<N>.png    per-level background (N starts at 1)
public/assets/char/<slug>.png    a character, already alpha-matted (transparent PNG)
public/assets/bgm/main.mp3       background music
```

`PreloadScene` queues exactly the files the manifest lists — nothing is ever requested on a guess. Missing manifest, a missing individual file, or no manifest at all (the common case early in a project) all degrade the same way: no exception, no failed-looking load, just the existing procedural placeholder shapes / plain background / no audio, unchanged from this template's zero-asset default. If you're building on this template and want your generated files picked up, write them to the paths above and describe them in `public/game-assets.json` — see `src/game-assets.ts`'s header doc for the exact JSON shape, and `skills/game-flow-and-hud/SKILL.md`'s "Platform-Delivered Assets" section for the reasoning behind the degrade-gracefully contract.

### Everything else

Drop image/audio files under `public/assets/` (create the directory) and load them the normal Phaser way in `PreloadScene.preload()`:

```ts
this.load.image('player', 'assets/player.png')
this.load.audio('shoot', 'assets/shoot.mp3')
```

The loading bar in `PreloadScene` already listens for the standard Phaser loader `progress` event, so it animates correctly as soon as real files are queued — no changes needed there.

## Deployment

`pnpm build:play` produces a fully static `dist-play/` directory — deploy it to any static host (Vercel, Netlify, GitHub Pages, an nginx container, etc). No server-side runtime is required.

## Contributing

This project follows [Conventional Commits](https://www.conventionalcommits.org):

```
feat(game): add enemy spawner
fix(input): capture arrow keys during pause menu
chore: bump phaser
```

## License

MIT
