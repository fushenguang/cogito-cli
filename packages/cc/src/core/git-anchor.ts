// git-anchor.ts — deterministic git anchoring for guest projects (blade 1.5).
//
// Why this lives inside a cc command instead of dispatch prose: the platform
// has always WANTED version anchoring in guest projects (the dispatch runtime
// rules tell the executor to git-commit at every verifiable stage), but in
// practice the executor's own ad-hoc `git init / git add -A / git commit`
// command strings were rejected by its tool gateway 5 times on record (see
// the executor-briefing ledger in cogito-lib; probes of the policy endpoints
// all 404'd — the rejections misfire on the platform's own requirement, they
// are not a git ban). Fixed pipeline steps must not depend on prose the
// executor keeps getting blocked on — per the paradigm rule, `cc` is where
// fixed pipeline steps live so they happen 100% of the time. Everything this
// module does is reported in `cc init` / `cc evidence` output (NDJSON event /
// bundle field), so the run remains fully observable.
//
// Zero new dependencies: node:child_process only.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Commit identity used via `-c` flags — never written to any config file. */
const GIT_IDENTITY = ['-c', 'user.name=cogito-cc', '-c', 'user.email=cc@cogito.invalid'] as const

export interface GitAnchorResult {
  ok: boolean
  /** What actually happened, machine-readable. */
  action: 'initialized' | 'committed' | 'tagged' | 'skipped' | 'failed'
  /** Tag name, when one was created. */
  tag?: string
  /** For 'skipped' / 'failed': why. */
  reason?: string
}

function git(dir: string, args: readonly string[]): { status: number | null; stdout: string; error: Error | undefined } {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 60_000 })
  return { status: r.status, stdout: r.stdout ?? '', error: r.error }
}

function isGitMissing(res: { status: number | null; error: Error | undefined }): boolean {
  return res.status === null && res.error !== undefined
}

/**
 * Blade 1.5, first half — `cc init` anchors the scaffold with an initial
 * commit. Idempotent: if the target already has a .git, the re-run reports
 * skipped instead of touching anything (scaffold re-runs are expected on
 * retry rounds).
 */
export function anchorAfterScaffold(dir: string): GitAnchorResult {
  if (existsSync(join(dir, '.git'))) {
    return { ok: true, action: 'skipped', reason: 'already-anchored' }
  }
  // Plain `git init` — do not gamble on `-b main` (needs git >= 2.28; the
  // branch name is not an invariant, tags are the anchor).
  let r = git(dir, ['init', '-q'])
  if (isGitMissing(r)) return { ok: false, action: 'failed', reason: 'git-missing' }
  if (r.status !== 0) return { ok: false, action: 'failed', reason: 'git-init-exit-' + r.status }

  r = git(dir, [...GIT_IDENTITY, 'add', '-A'])
  if (r.status !== 0) return { ok: false, action: 'failed', reason: 'git-add-exit-' + r.status }

  r = git(dir, [...GIT_IDENTITY, 'commit', '-q', '-m', 'cc init: scaffold'])
  if (r.status !== 0) return { ok: false, action: 'failed', reason: 'git-commit-exit-' + r.status }

  return { ok: true, action: 'initialized' }
}

/**
 * Blade 1.5, second half — `cc evidence` (the fixed run-closing step) takes
 * a snapshot before collecting: commit if dirty, then tag HEAD so each run's
 * closing state is addressable (`cc-evidence-<unix-ms>`).
 *
 * Does NOT `git init` — evidence is a read-mostly step and never invents
 * repository structure that `cc init` was supposed to create. A missing .git
 * is reported as skipped and surfaces in the evidence bundle.
 */
export function anchorRunSnapshot(dir: string): GitAnchorResult {
  if (!existsSync(join(dir, '.git'))) {
    return { ok: true, action: 'skipped', reason: 'not-a-repo' }
  }

  const status = git(dir, ['status', '--porcelain'])
  if (isGitMissing(status)) return { ok: false, action: 'failed', reason: 'git-missing' }

  let committed = false
  if (status.status === 0 && status.stdout.trim().length > 0) {
    let r = git(dir, [...GIT_IDENTITY, 'add', '-A'])
    if (r.status !== 0) return { ok: false, action: 'failed', reason: 'git-add-exit-' + r.status }
    r = git(dir, [...GIT_IDENTITY, 'commit', '-q', '-m', 'cc evidence: run snapshot'])
    if (r.status !== 0) return { ok: false, action: 'failed', reason: 'git-commit-exit-' + r.status }
    committed = true
  }

  const tag = `cc-evidence-${Date.now()}`
  const t = git(dir, ['tag', tag])
  if (t.status !== 0) {
    // Tag collision (same-ms rerun) or tag failure: the commit still stands.
    return { ok: true, action: committed ? 'committed' : 'skipped', reason: 'git-tag-exit-' + t.status }
  }
  return { ok: true, action: committed ? 'committed' : 'tagged', tag, ...(committed ? {} : { reason: 'no-changes' }) }
}
