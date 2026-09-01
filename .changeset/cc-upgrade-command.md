---
'@cogito.ai/cc': minor
---

`cc upgrade [dir]`: move a scaffolded project onto the template version this CLI ships. Projects were frozen snapshots of the template at `cc init` time — a capability landing after scaffold (multi-level flow in 0.9.0) was unreachable for existing projects, and the executing AI cannot port template code (it is outside the write surface by design). Upgrade replaces every template-owned file the project has NOT touched since the baseline commit, reports project-edited files as conflicts (skipped without `--force`), never touches write-surface files, re-runs the `{{PROJECT_NAME}}` substitution on replaced files, and lands everything as ONE `cc upgrade: template <ver>` commit. The write-surface gate re-baselines onto the newest upgrade commit, so `pnpm verify` stays green across upgrades (closes #22).
