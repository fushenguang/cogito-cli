---
'@cogito.ai/cc': minor
---

factory-playable floor (issues #10/#11) — the playable minimum becomes structural, AI earns the fun ceiling inside slots

- #11 fixed auxiliary pages: Start/GameOver/Settings live as DOM overlays (`src/screen-dom.ts`), copy + colours fully data-driven from `game-doc.json`'s new `screens`/`theme` sections (total-fallback resolution: every page renders with no doc at all; a bad section degrades whole, never half)
- #10 prototype solid background: default `#2b2419` in `config.ts` — hue-orthogonal to every entity colour, so entity visibility is machine-judgeable (region modal-colour + ink ratio, not hand-tuned thresholds)
- factory-playable tutorial level: `game-data.json` ships a real platformer level (platforms/goal/coins, geometry per the official "my first game" tutorial; `initialObstacles: []` keeps the machine-completion invariant — levels[0] completable by hold→+periodic-jump); GameScene is now a platformer interpreter (gravity, grounded gate, goal overlap → win)
- postbuild selfcheck: `build:play` = `vite build --mode play && node scripts/selfcheck.mjs` — real CDP click on start, real keyboard through level 1, pixel-asserted Start/GameOver copy, back-to-title; a broken journey fails the build (verified both ways: contract-layer catch and player-path catch)
- AI write surface (WS gate): `scripts/check-write-surface.mjs` + `pnpm verify` — paths changed since the `cc init` root commit must stay inside the content slots (`game-data.json`/`game-doc.json`/`game-assets.json`/`assertions.json`/`PROJECT_CONTEXT.md`/`README.md` + new files under `public/`/`src/extensions/`/`docs/`/`assets/`); AGENTS.md rule 10 pins the same boundary word-for-word
