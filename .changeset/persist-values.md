---
'@cogito.ai/cc': minor
---

game-data.json `persistValues` — data-declared values that survive restarts, visible to `value_persists`

- top-level `"persistValues": ["jar"]` names registry values that must NOT re-zero on scene restart / state jump
- GameScene gives each declared name `highScore`'s exact has-once initialization; `harness.readValues()` reports them — before this, that function was hardcoded to `highScore` only, so a project's own persistent value had NO observable channel and `value_persists` could only report unmet-precondition (hit by the 小小财迷 v2 reopen's jar counter on day one)
- reserved names rejected at validation: `score` (re-zeroed by design) and `highScore` (template-owned); identifier charset enforced; duplicates rejected
- `playtest --replay <n>` re-applies the same state n times printing `values` each round — a value that re-zeroes shows as a different number between rounds; `playtest` now prints `values` at all (it didn't)
- e2e proven through the real build with a temporary gameplay-write probe: jar read 5 → 10 → 15 across three scene restarts (has-once held; the write survived), then removed back to a clean 8/8 baseline
