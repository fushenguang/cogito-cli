---
'@cogito.ai/cc': minor
---

src/extensions/ is live — level-declared mechanism hooks (first consumer: 小小财迷 v2)

- game-data.json: `levels[i].extension = {module, config}` — module charset `/^[A-Za-z0-9-]+$/` doubles as the path-traversal guard; config is shape-only (the extension owns its fields)
- GameScene wires it at the END of create(): `import.meta.glob('../extensions/*.ts', {eager: true})` inlines every extension at BUILD time (no async gap where a level is playable but the mechanic missing; an empty directory contributes nothing); declared-but-missing module degrades to the vanilla level with a console warning — the floor is never held hostage by the ceiling
- contract in `src/extensions-contract.ts` (template-owned) + usage guide `src/extensions/README.md`; HUD counter follows `registry.set('score', ...)` and renames via `screens.scoreLabel`
- AGENTS.md rule 10 updated (the slot is loaded now, no longer "reserved"); wiring proven e2e with a temporary probe extension (config `startScore: 10` showed up as `score=10` in the selfcheck's SC-5 readout through the real build), then removed back to a clean 8/8 baseline
- tests: extension validation positives/negatives (traversal strings, non-object config, bare-string extension) — 224 green
