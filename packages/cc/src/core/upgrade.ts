// upgrade.ts — move a scaffolded project onto the template version this CLI
// ships (issue #22). Projects are frozen snapshots of the template at
// `cc init` time; without this command, a template capability that lands
// AFTER a project's scaffold (multi-level flow in 0.9.0 being the first
// concrete case) is unreachable for that project, and the executing AI
// cannot port it: template-owned code is outside the project's write
// surface by design, so delivering newer template code is the platform's
// job, never the project's.
//
// The algorithm leans on the two invariants the scaffold already gives us:
//   1. `cc init` anchors the project with a root commit whose subject is
//      SCAFFOLD_ROOT_MARKER (git-anchor.ts) — the project's as-shipped state.
//   2. The write surface is exactly enumerated (this list is synchronized
//      with the template's scripts/check-write-surface.mjs and AGENTS.md
//      rule 10 — change all three together).
//
// So: every template-owned file the project has NOT touched since the
// baseline commit is replaced with the new template's version; files the
// project HAS touched are conflicts (reported, skipped unless --force —
// never silently clobbered); write-surface files are never touched (they
// are the project's content, not the platform's).
//
// The upgrade lands as ONE commit whose subject carries UPGRADE_MARKER —
// that commit becomes the gate's new baseline (check-write-surface.mjs
// resolves the newest upgrade commit before judging), which is what keeps
// `pnpm verify` green across an upgrade. The marker is an honesty
// convention, not a security boundary — same standing as the gate itself.
//
// Zero new dependencies: node:fs / node:child_process only.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_NAME_PLACEHOLDER } from './scaffold.js'

/** Must match templates/game-web-phaser/scripts/check-write-surface.mjs (and AGENTS.md rule 10). */
export const SCAFFOLD_ROOT_MARKER = 'cc init: scaffold'
/** The commit marker that re-baselines a project after an upgrade. */
export const UPGRADE_MARKER = 'cc upgrade: template'

/**
 * Write-surface files the scaffold ships but the project owns from then on
 * (template's check-write-surface.mjs WRITABLE_EXISTING + the new-file
 * prefixes — an upgrade never touches anything in these).
 */
const WRITE_SURFACE_PREFIXES = ['public/', 'src/extensions/', 'docs/', 'assets/']
/**
 * Exact-name write-surface files (the template gate's WRITABLE_EXISTING).
 * 🟡 Synchronized with templates/game-web-phaser/scripts/check-write-surface.mjs
 * and its AGENTS.md rule 10 — change all three together.
 */
const WRITE_SURFACE_FILES = new Set([
  'public/game-data.json',
  'public/game-doc.json',
  'public/game-assets.json',
  'assertions.json',
  'PROJECT_CONTEXT.md',
  'README.md',
])

/** Generated/transient outputs that never ship and never get replaced. */
const IGNORED_PREFIXES = ['node_modules', 'dist', '.selfcheck', '.git', '.verify-result.json', '.playtest-screenshot.png']

/**
 * v1 boundary, deliberate: the project's package.json was REWRITTEN at
 * scaffold time (name, version, resolved deps — see scaffold.ts's
 * rewritePackageJson), so a naive template copy would destroy project
 * identity. Upgrade reports it instead of merging it. When a template
 * release changes dependencies, that merge logic is worth building — until
 * then the report line is the honest state.
 */
const SKIPPED_BY_NAME = new Set(['package.json'])

export interface UpgradeReport {
  ok: boolean
  action: 'upgraded' | 'no-change' | 'failed'
  reason?: string
  /** Template-owned files whose content changed and were replaced. */
  replaced: string[]
  /** Files identical between the project and the new template. */
  unchanged: string[]
  /** Template-owned files the project has edited — skipped without --force. */
  conflicts: string[]
  commit?: string
}

function git(dir: string, args: readonly string[]): string | null {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 60_000 })
  if (r.status !== 0) return null
  return (r.stdout ?? '').trim()
}

function isIgnored(relPath: string): boolean {
  return IGNORED_PREFIXES.some((p) => relPath === p || relPath.startsWith(p + '/'))
}

function isWriteSurface(relPath: string): boolean {
  return (
    WRITE_SURFACE_FILES.has(relPath) ||
    WRITE_SURFACE_PREFIXES.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))
  )
}

/** Collect every file under `dir` as repo-relative POSIX paths (dotfile renames applied). */
function walkTemplateFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (isIgnored(rel)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkTemplateFiles(full, rel))
    } else if (entry.isFile()) {
      // The publish-survival renames (scaffold.ts restoreDotfiles) apply
      // here too: the template ships _gitignore/_npmrc, projects hold the
      // dotted names.
      out.push(rel.replace(/^_gitignore$/, '.gitignore').replace(/^_npmrc$/, '.npmrc'))
    }
  }
  return out
}

/** Apply the scaffold's placeholder substitution to one file's content. */
function substitutePlaceholder(content: string, projectName: string): string {
  return content.split(PROJECT_NAME_PLACEHOLDER).join(projectName)
}

/** The project's own package.json `name` — the substitution value for replaced files. */
function readProjectName(projectDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as { name?: string }
    return pkg.name ?? null
  } catch {
    return null
  }
}

/** The baseline commit the gate judges against: the newest upgrade commit, else the scaffold root. */
export function findBaselineCommit(projectDir: string): { rootCommit: string | null; baseline: string | null } {
  const rootCommit = git(projectDir, ['rev-list', '--max-parents=0', 'HEAD'])
  if (rootCommit === null) return { rootCommit: null, baseline: null }
  // --fixed-strings: the marker contains a colon, keep it literal.
  // 🔴 `|| null`, not `?? null`: git log --grep with no match exits 0 with
  // EMPTY stdout, which trims to '' — and '' ?? fallback never fires, so
  // the baseline becomes '' and every later git call silently fails.
  const upgradeCommit =
    git(projectDir, [
      'log',
      '--fixed-strings',
      `--grep=${UPGRADE_MARKER}`,
      '-n',
      '1',
      '--pretty=%H',
      'HEAD',
    ]) || null
  return { rootCommit, baseline: upgradeCommit ?? rootCommit }
}

export interface UpgradeOptions {
  projectDir: string
  templateDir: string
  /** Overwrite conflicts (template-owned files the project edited). */
  force?: boolean
  /** The template version being moved onto — recorded in the commit subject. */
  templateVersion: string
  /** Compute and report without touching anything. */
  dryRun?: boolean
}

export function upgradeProject(opts: UpgradeOptions): UpgradeReport {
  const { projectDir, templateDir, force = false, dryRun = false } = opts
  const empty: UpgradeReport = {
    ok: false,
    action: 'failed',
    replaced: [],
    unchanged: [],
    conflicts: [],
  }

  if (git(projectDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { ...empty, reason: 'not a git repository' }
  }
  const { rootCommit, baseline } = findBaselineCommit(projectDir)
  if (rootCommit === null || baseline === null) {
    return { ...empty, reason: 'no commits — cannot establish the scaffold baseline' }
  }
  const rootMessage = git(projectDir, ['log', '-1', '--pretty=%s', rootCommit]) ?? ''
  if (!rootMessage.includes(SCAFFOLD_ROOT_MARKER)) {
    return {
      ...empty,
      reason: `root commit subject is "${rootMessage}" — not a cc-init scaffolded project (expected "${SCAFFOLD_ROOT_MARKER}")`,
    }
  }
  const dirty = git(projectDir, ['status', '--porcelain'])
  if (dirty) {
    return {
      ...empty,
      reason: 'working tree is not clean — commit or stash first, an upgrade must land as exactly one commit of its own',
    }
  }

  // What the project has already changed (committed) since the baseline.
  const projectTouched = new Set(
    (git(projectDir, ['diff', '--name-only', `${baseline}..HEAD`]) ?? '')
      .split('\n')
      .filter((l) => l.length > 0),
  )

  const replaced: string[] = []
  const unchanged: string[] = []
  const conflicts: string[] = []
  const skippedNamed: string[] = []

  for (const rel of walkTemplateFiles(templateDir).sort()) {
    if (SKIPPED_BY_NAME.has(rel)) {
      skippedNamed.push(rel)
      continue
    }
    if (isWriteSurface(rel)) continue // the project's files, never touched

    const templateFile = templateFileFor(templateDir, rel)
    const projectFile = join(projectDir, rel)
    const projectName = readProjectName(projectDir) ?? '{{PROJECT_NAME}}'
    // Compare in PROJECT space: a template file plus the scaffold's
    // placeholder substitution IS the project's file — that combination is
    // "unchanged", not a replacement (otherwise every {{PROJECT_NAME}}-
    // bearing file reads as eternally different and the nothing-to-commit
    // upgrade commit fails).
    const templateContent = substitutePlaceholder(readFileSync(templateFile, 'utf-8'), projectName)
    const projectContent = existsSync(projectFile) ? readFileSync(projectFile, 'utf-8') : null

    if (projectContent === templateContent) {
      unchanged.push(rel)
      continue
    }
    if (projectTouched.has(rel) && !force) {
      conflicts.push(rel)
      continue
    }
    replaced.push(rel)
  }

  if (replaced.length === 0) {
    return {
      ok: true,
      action: 'no-change',
      reason:
        conflicts.length > 0
          ? `${conflicts.length} conflict(s) remain (project-edited template files) and nothing else changed — rerun with --force to overwrite them`
          : 'project already matches the template',
      replaced,
      unchanged,
      conflicts,
    }
  }

  if (!dryRun) {
    for (const rel of replaced) {
      const target = join(projectDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(templateFileFor(templateDir, rel), target)
      // 🔴 Re-run the scaffold's placeholder substitution on every replaced
      // file: template files carry {{PROJECT_NAME}} and the project's copy
      // must carry the project's name (scaffold did this pass once at init;
      // upgrade delivers fresh template files, so it owes the same pass).
      // v1 boundary: the substitution value is package.json's `name` — a
      // scaffold-time --display-name different from `name` is not recorded
      // anywhere a project can re-read, so it degrades to `name`.
      const projectName = readProjectName(projectDir)
      if (projectName) {
        writeFileSync(target, substitutePlaceholder(readFileSync(target, 'utf-8'), projectName))
      }
    }
    const gitArgs = ['add', ...replaced]
    if (git(projectDir, gitArgs) === null) return { ...empty, reason: 'git add failed' }
    const subject = `${UPGRADE_MARKER} ${opts.templateVersion}`
    // Same identity convention as git-anchor.ts — commit via -c flags,
    // never by writing to the project's git config.
    const committed = git(projectDir, [
      '-c',
      'user.name=cogito-cc',
      '-c',
      'user.email=cc@cogito.invalid',
      'commit',
      '-m',
      subject,
    ])
    if (committed === null) return { ...empty, reason: 'git commit failed' }
  }

  const report: UpgradeReport = { ok: true, action: 'upgraded', replaced, unchanged, conflicts }
  if (skippedNamed.length > 0) {
    report.reason = `skipped (v1 boundary): ${skippedNamed.join(', ')} — merge manually if the template's dependencies changed`
  }
  return report
}

/**
 * Resolve a project-side path to its template-side file. The template
 * holds `_gitignore`/`_npmrc` in PUBLISHED form (dist) but the dotted
 * names in the monorepo source — both layouts are valid inputs here
 * (check:template exercises dist, local tsx runs exercise the source), so
 * try the renamed form first and fall back to the dotted one.
 */
function templateFileFor(templateDir: string, rel: string): string {
  const renamed = rel.replace(/^\.gitignore$/, '_gitignore').replace(/^\.npmrc$/, '_npmrc')
  if (renamed !== rel) {
    const renamedPath = join(templateDir, renamed)
    if (existsSync(renamedPath)) return renamedPath
  }
  return join(templateDir, rel)
}
