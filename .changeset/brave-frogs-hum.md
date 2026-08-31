---
'@cogito.ai/cc': minor
---

Feedback sfx enters the template's asset contract (blade 3 audio minimum line): `game-assets.json` gains an optional single-slot `sfx` entry (`public/assets/sfx/feedback.wav`), loaded by `PreloadScene` under the new well-known key `feedback` and played by `GameScene` on coin collect — guarded by `cache.audio.exists()`, so no delivered file just means a silent collect, never an error or a fallback beep. The AU gate deliberately judges it as `'other'` (reported, never held against `passed`): its own in-use judgement is deferred until after the platform's M1 reading. Platform half (CC0 curation + delivery) lands in the cogito-lib repo.
