#!/usr/bin/env node
// check-write-surface.mjs — the AI write-surface gate (issue #B5, 2026-09-01).
//
// 🔴 WHY THIS EXISTS — the 小小财迷 M1 verdict's structural fix: the playable
// FLOOR is guaranteed by the template (factory-shipped fixed pages + tutorial
// level + postbuild selfcheck), and the AI executor earns the FUN CEILING
// inside declared slots — data, copy, assets. The moment an executor edits
// scene/page code to "fix" something, the floor is no longer structural:
// 16 individually-green modules shipping a garbage game is exactly what
// editing outside the slots reproduces. This script makes the slot boundary
// mechanical: every path changed since the scaffold's root commit must be
// inside the whitelist below, or `pnpm verify` goes red.
//
// Anchor: `cc init` scaffolds the project with `git init` + a root commit
// whose message is "cc init: scaffold" (packages/cc/src/core/git-anchor.ts).
// That root commit is the template's as-shipped state. When the repo is NOT
// a scaffolded project (e.g. developing the template itself in cogito-cli),
// the gate reports not-applicable and passes — the whitelist's job is to
// police executors inside scaffolded projects, not to freeze the template.
//
// The judgement itself is a pure function (judgeWriteSurface) so
// tests/check-write-surface.test.mjs can pin the boundary without git.

import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(__dirname, '..')

/** The root commit's marker — cc init's initial commit message. */
export const SCAFFOLD_ROOT_MARKER = 'cc init: scaffold'

/**
 * The AI write surface (v1). Synchronized word-for-word with AGENTS.md's
 * rule 10 — if you change one, change both.
 *
 * - EXISTING files the executor may EDIT (content slots):
 *   the three public JSON manifests, this project's own acceptance items,
 *   its cross-session handoff notes, and its README.
 * - NEW files the executor may CREATE, by prefix:
 *   anything under public/ (data + assets), src/extensions/ (reserved for
 *   project-specific scene/mechanism extensions — see AGENTS.md rule 10's
 *   note that the template does not auto-load these yet), docs/ (project
 *   notes), assets/ (platform-delivered sfx drop dir).
 */
export const WRITABLE_EXISTING = new Set([
  'public/game-data.json',
  'public/game-doc.json',
  'public/game-assets.json',
  'assertions.json',
  'PROJECT_CONTEXT.md',
  'README.md',
])

export const WRITABLE_NEW_PREFIXES = ['public/', 'src/extensions/', 'docs/', 'assets/']

/** Generated/transient outputs that never count as edits either way. */
const IGNORED_PREFIXES = ['.selfcheck/', 'dist', 'node_modules', '.verify-result.json', '.playtest-screenshot.png']

/** @param {string} path */
function isIgnored(path) {
  return IGNORED_PREFIXES.some((p) => path === p || path.startsWith(p))
}

/**
 * Judge one changed path against the write surface.
 *
 * @param {string} path repo-relative path, forward slashes
 * @param {{ existedAtRoot: boolean }} change whether this path existed in the
 *   scaffold's root commit (an edit) or is new since then (an addition)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function judgeWriteSurface(path, change) {
  if (isIgnored(path)) return { ok: true }

  if (change.existedAtRoot) {
    if (WRITABLE_EXISTING.has(path)) return { ok: true }
    return {
      ok: false,
      reason:
        `"${path}" is template-owned (shipped by the scaffold) — edit its data/copy in the write surface ` +
        `(public/game-data.json, public/game-doc.json, public/game-assets.json) instead of the code. ` +
        'See AGENTS.md rule 10.',
    }
  }

  if (WRITABLE_NEW_PREFIXES.some((p) => path.startsWith(p))) return { ok: true }
  return {
    ok: false,
    reason:
      `"${path}" is a new file outside the write surface — new content belongs under public/ ` +
      '(data/assets), src/extensions/ (reserved), or docs/. See AGENTS.md rule 10.',
  }
}

/**
 * Parse one `git status --porcelain` line into the changed path.
 *
 * porcelain v1: `XY <path>` — two status chars, one space, then the path
 * (rename entries read `R  old -> new`; the new path is what we judge).
 *
 * 🔴 Exported and tested because of a real 2026-09-01 catch: the git wrapper
 * in checkWriteSurface() below trims its WHOLE output, which strips the
 * leading space of the FIRST line's ` M` status (unstaged edit) — a naive
 * slice(3) on the trimmed line then read "src/config.ts" as "rc/config.ts"
 * and judged a phantom path. The leading status char is data, not
 * whitespace; never trim before parsing porcelain output.
 *
 * @param {string} line
 * @returns {string | null}
 */
export function parsePorcelainLine(line) {
  if (!line) return null
  const path = line.slice(3).split(' -> ').pop()
  return path || null
}

/**
 * Full check: collect every path changed since the scaffold root commit
 * (committed diffs + uncommitted worktree changes) and judge each.
 *
 * @returns {Promise<{ applicable: boolean, violations: { path: string, reason: string }[], checked: number, rootCommit: string | null }>}
 */
export async function checkWriteSurface() {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim()
    } catch {
      return null
    }
  }
  const gitRaw = (args) => {
    try {
      return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf-8' })
    } catch {
      return null
    }
  }

  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { applicable: false, violations: [], checked: 0, rootCommit: null }
  }

  const rootCommit = git(['rev-list', '--max-parents=0', 'HEAD'])
  if (rootCommit === null) return { applicable: false, violations: [], checked: 0, rootCommit: null }

  const rootMessage = git(['log', '-1', '--pretty=%s', rootCommit]) ?? ''
  if (!rootMessage.includes(SCAFFOLD_ROOT_MARKER)) {
    // Not a cc-init scaffolded project (e.g. the template's own repo).
    return { applicable: false, violations: [], checked: 0, rootCommit }
  }

  const changed = new Set()
  for (const line of (git(['diff', '--name-only', `${rootCommit}..HEAD`]) ?? '').split('\n')) {
    if (line) changed.add(line)
  }
  for (const line of (gitRaw(['status', '--porcelain']) ?? '').split('\n')) {
    const path = parsePorcelainLine(line)
    if (path) changed.add(path)
  }

  const violations = []
  let checked = 0
  for (const path of changed) {
    if (isIgnored(path)) continue
    checked += 1
    const existedAtRoot =
      git(['cat-file', '-e', `${rootCommit}:${path}`]) !== null
    const judged = judgeWriteSurface(path, { existedAtRoot })
    if (!judged.ok) violations.push({ path, reason: judged.reason ?? 'outside the write surface' })
  }
  return { applicable: true, violations, checked, rootCommit }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMainModule) {
  checkWriteSurface().then((result) => {
    if (!result.applicable) {
      console.log('[write-surface] not applicable (not a cc-init scaffolded repo) — gate passes')
      process.exit(0)
    }
    if (result.violations.length > 0) {
      console.error(`[write-surface] ${result.violations.length} path(s) outside the AI write surface:`)
      for (const v of result.violations) console.error(`  - ${v.reason}`)
      process.exit(1)
    }
    console.log(`[write-surface] ${result.checked} changed path(s) all inside the write surface`)
    process.exit(0)
  })
}
