// evidence.ts — one command that produces the operator's evidence bundle.
//
// Born from the M1 incident loop (2026-08-30): every driver hand-rolled its
// own "cat .verify-result.json, read the data files, run playtest, pull the
// PNGs back, base64 them" sequence, slightly differently each time. That is
// a fixed pipeline step pretending to be improvisation. `cc evidence`
// replaces it: one JSON bundle with the verify verdict, the data files, git
// state, and (with --shots) per-state screenshots from the project's own
// playtest instrument — never a browser probe written ad hoc.
//
// Zero new dependencies: node:fs / node:child_process only.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { anchorRunSnapshot, type GitAnchorResult } from './git-anchor.js'

export interface EvidenceBundle {
  collectedAt: string
  dir: string
  verifyResult: unknown | null
  dataFiles: Record<string, { present: boolean; bytes: number; sha256?: string }>
  /** Blade 1.5: the run-closing anchor (commit-if-dirty + tag) taken BEFORE collecting. */
  gitAnchor: GitAnchorResult | null
  git: { log: string[]; status: string[] } | null
  shots: Array<{ state: string; file: string; bytes: number; exitCode: number | null }> | null
  errors: string[]
}

function sh(cwd: string, cmd: string, args: string[]): { stdout: string; status: number } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { stdout: r.stdout ?? '', status: r.status ?? -1 }
}

/**
 * Collect the standard evidence bundle. `shots` (when given) is a list of
 * harness state ids to photograph via the project's own
 * `scripts/playtest.mjs` — the sanctioned instrument, per the
 * no-ad-hoc-browser-probes rule. Screenshots stay files on disk (paths are
 * reported); embedding megabytes of PNG in JSON helps nobody.
 */
export function collectEvidence(dir: string, shotStates?: string[]): EvidenceBundle {
  const bundle: EvidenceBundle = {
    collectedAt: new Date().toISOString(),
    dir,
    verifyResult: null,
    dataFiles: {},
    gitAnchor: null,
    git: null,
    shots: null,
    errors: [],
  }

  // Blade 1.5: `cc evidence` is the fixed run-closing step, so it is where
  // the run's closing state gets anchored (commit-if-dirty + tag) — before
  // the git fields below are read, so the bundle reports the anchored state.
  bundle.gitAnchor = anchorRunSnapshot(dir)
  if (!bundle.gitAnchor.ok) {
    bundle.errors.push(`git anchor failed: ${bundle.gitAnchor.reason ?? 'unknown'}`)
  }

  const vrPath = join(dir, '.verify-result.json')
  if (existsSync(vrPath)) {
    try {
      bundle.verifyResult = JSON.parse(readFileSync(vrPath, 'utf8'))
    } catch (e) {
      bundle.errors.push(`.verify-result.json unreadable: ${String(e)}`)
    }
  } else {
    bundle.errors.push('.verify-result.json missing — verify has not run (or never wrote it)')
  }

  for (const name of ['game-data.json', 'game-assets.json', 'game-doc.json']) {
    const p = join(dir, 'public', name)
    if (!existsSync(p)) {
      bundle.dataFiles[name] = { present: false, bytes: 0 }
      continue
    }
    const raw = readFileSync(p)
    bundle.dataFiles[name] = { present: true, bytes: raw.length }
    try {
      JSON.parse(raw.toString('utf8'))
    } catch {
      bundle.errors.push(`public/${name} is not valid JSON`)
    }
  }

  const gitLog = sh(dir, 'git', ['log', '--oneline', '-10'])
  const gitStatus = sh(dir, 'git', ['status', '--porcelain'])
  bundle.git = gitLog.status === 0 ? { log: gitLog.stdout.trim().split('\n').filter(Boolean), status: gitStatus.stdout.trim().split('\n').filter(Boolean) } : null

  if (shotStates && shotStates.length > 0) {
    bundle.shots = []
    for (const state of shotStates) {
      const file = join(dir, `.evidence-shot-${state}.png`)
      const r = spawnSync('node', ['scripts/playtest.mjs', '--state', state, '--settle', '1200', '--shot', file], { cwd: dir, encoding: 'utf8', timeout: 120_000 })
      const bytes = existsSync(file) ? readFileSync(file).length : 0
      bundle.shots.push({ state, file, bytes, exitCode: r.status ?? null })
      if (r.status !== 0 || bytes === 0) {
        bundle.errors.push(`playtest --state ${state} failed (exit ${r.status}, ${bytes} bytes)`)
      }
    }
  }
  return bundle
}
