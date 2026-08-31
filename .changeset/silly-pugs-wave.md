---
'@cogito.ai/cc': minor
---

Blade 2 — data model pipeline + spine hot reload:

- `cc data deliver`: publish `DATA_MODEL/` runtime nodes into the `public/game-*.json` spine at their `consumedBy` paths (schema v0: `{id,type,name,description,content}`; runtime adds `consumedBy`/`assertions`; context/forbidden nodes stay put). Hash manifest `.data-deliver.json` is a record, never a gate — scaffold-only projects (no `DATA_MODEL/`) exit 0 as `skipped`; malformed nodes are reported and skipped without blocking well-formed ones.
- `cc serve start` now spawns a detached hot-reload watcher (`cc serve watch`): spine edits in `public/` are copied into `dist/` (live on next browser refresh, zero rebuild) and leaf-diffed into `.tuning-log.jsonl`. The watcher self-exits when the preview port dies — its only shutdown path.
- `cc evidence` now syncs tuned spine values back into `DATA_MODEL/` runtime nodes (before the git anchor, so the synced canonical is what gets committed), archives the tuning log, records spine sha256 hashes, and includes the `.data-deliver.json` manifest in the bundle.
