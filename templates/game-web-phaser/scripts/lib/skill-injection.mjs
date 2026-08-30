// Pure logic behind scripts/install-phaser-skills.mjs — the postinstall step
// that copies Phaser's bundled skills (node_modules/phaser/skills/*) into
// Shelley's skill directory so a coding agent running in a VM can see and
// activate them.
//
// See openspec/changes/phaser-skill-injection/design.md (D1-D4) in the
// AgentDock platform repo for the full rationale. Short version:
//
//   D1  the copy runs from this template's own `postinstall` — the one
//       moment after `pnpm install` when node_modules/phaser/skills/ is
//       guaranteed to exist. Not a platform prose instruction (agents don't
//       reliably follow those — see design.md), not the CLI's `init` (too
//       early, node_modules doesn't exist yet).
//   D2  the destination is ${HOME}/.config/shelley, derived from $HOME at
//       run time. 🔴 Never hardcode /root/.config/... — inside the VM guest
//       HOME=/, so a hardcoded /root path silently fails (file lands on
//       disk, `shelley skill ls` never lists it, nothing errors). Never
//       hardcode /.config either — that's wrong on a developer's own
//       machine. ${HOME}/.config/shelley resolves correctly in both places.
//   D2  the guard: only copy when ${HOME}/.config/shelley already exists.
//       Its existence is what "this machine is running Shelley" means. A
//       developer's own laptop doesn't have it, so `pnpm install` there
//       must no-op and must not create or write anything under $HOME.
//   D3  copy the *whole* skill directory, not just SKILL.md — 8 of the 28
//       skills have a references/REFERENCE.md that SKILL.md links to with a
//       relative path (`../other-skill/references/REFERENCE.md`); copying
//       SKILL.md alone would leave those links dangling.
//
// This file is deliberately zero-I/O so it can be unit tested without a
// real filesystem (tasks.md 2.1) — all fs/path calls that touch real disk
// state live in install-phaser-skills.mjs, which is not imported by any
// test (same split this template already uses for scripts/verify.mjs vs.
// scripts/lib/exit-decision.mjs).

import path from 'node:path'

/**
 * Resolve $HOME from an env-like object (normally `process.env`, injected
 * so this stays testable without touching real env vars). Returns
 * `undefined` when unset — callers must treat that as "cannot proceed",
 * never fall back to a hardcoded path (see file header, D2).
 */
export function resolveHome(env) {
  const home = env?.HOME
  return typeof home === 'string' && home.length > 0 ? home : undefined
}

/**
 * ${HOME}/.config/shelley — the directory Shelley reads its skills from.
 * MUST be derived from `home`, never hardcoded (D2). Returns `undefined`
 * when `home` is falsy so callers can't accidentally build a rooted path
 * like `/.config/shelley` out of an empty string.
 */
export function resolveShelleyDir(home) {
  if (!home) return undefined
  return path.join(home, '.config', 'shelley')
}

/**
 * The guard (D2): inject only when ${HOME}/.config/shelley already exists.
 * That existence is the entire definition of "this is a Shelley machine" —
 * there is no other signal this function is allowed to use.
 *
 * 🔴 This predicate is the thing tasks.md 2.2's mutation check removes to
 * prove the guard is load-bearing. Keep it as an isolated, directly
 * testable function — do not inline its condition into the install loop or
 * into resolveShelleyDir, or the mutation (deleting the guard) stops being
 * a single, obvious, revertible edit.
 */
export function shouldInject({ home, shelleyDirExists }) {
  return Boolean(home) && shelleyDirExists === true
}

/**
 * From a directory listing of node_modules/phaser/skills (fs.Dirent-shaped
 * entries — anything with `.name` and `.isDirectory()`), pick the names to
 * copy. One skill = one subdirectory; stray files (e.g. a README.md sitting
 * next to the skill dirs) are ignored. Sorted for deterministic output.
 */
export function listSkillDirNames(entries) {
  return entries
    .filter((entry) => typeof entry?.isDirectory === 'function' && entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Build the (src, dest) copy plan for one skill directory. Copies the whole
 * directory — see D3 in the file header for why SKILL.md alone isn't
 * enough.
 */
export function planCopy({ phaserSkillsDir, shelleyDir, name }) {
  return {
    src: path.join(phaserSkillsDir, name),
    dest: path.join(shelleyDir, name),
  }
}
