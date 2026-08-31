---
'@cogito.ai/cc': minor
---

Blade 1.5 — deterministic git anchoring for guest projects.

- `cc init` anchors the fresh scaffold with an initial commit (`cc init: scaffold`). Idempotent: a re-run on an already-anchored project reports `skipped: already-anchored` and touches nothing. Agent mode emits a `{"type":"git-anchor",...}` NDJSON event after the scaffold result.
- `cc evidence` (the fixed run-closing step) now takes the snapshot BEFORE collecting: commit-if-dirty (`cc evidence: run snapshot`) + tag (`cc-evidence-<unix-ms>`), so every run's closing state is addressable. The bundle gains a `gitAnchor` field reporting what was done; `git.log` now reflects the anchored state. Evidence never runs `git init` — a missing repo is reported as `skipped: not-a-repo`, not invented.
- Commit identity goes via `-c user.name/-c user.email` flags only — never written to local/global config.
- Fix: pre-existing `tsc --noEmit` failure on `exactOptionalPropertyTypes` in `serve.ts` (`ServeStartOptions.port/logFile`) that shipped red in 0.2.0.
