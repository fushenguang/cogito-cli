---
'@cogito.ai/cc': minor
---

Multi-level progression: `levels[1..]` is now reachable — clearing a level with a successor advances to it (data-driven, same Game scene; `score` re-zeroes per level, `persistValues` carry across). Harness snapshots expose `levelId`; the postbuild selfcheck accepts a level advance as its walk outcome for multi-level projects. Also fixes `applyState()` leaving the source state scene running, which made `stateId` read as the state you just left (first exposed by a Game→GameOver jump).
