// upgradeProject — the three-way contract of `cc upgrade` (issue #22):
// template-owned files the project never touched get replaced; ones the
// project edited are conflicts (skipped unless --force); write-surface
// files are never touched. All against a tiny fixture template + project
// (pure git/fs, ms-fast — no real scaffold).

import { test, beforeEach, afterAll } from 'vitest'
import { expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { upgradeProject, findBaselineCommit, UPGRADE_MARKER } from '../upgrade.js'

const ROOT = join(tmpdir(), `cc-upgrade-test-${Date.now()}`)
const TPL = join(ROOT, 'template') // the "new template version" source
const PRJ = join(ROOT, 'project')

function sh(dir: string, cmd: string): void {
  execFileSync('sh', ['-c', cmd], { cwd: dir, stdio: 'pipe' })
}

/** v1 template shape: template-owned code + a write-surface data file + dotfile. */
function writeTemplate(version: 'v1' | 'v2'): void {
  const scene = version === 'v1' ? 'export const SCENE = 1\n' : 'export const SCENE = 2\n'
  const gameData = version === 'v1' ? '{"levels":1}\n' : '{"levels":2}\n'
  const gitignore = version === 'v1' ? 'node_modules\n' : 'node_modules\ndist\n'
  mkdirSync(join(TPL, 'src/scenes'), { recursive: true })
  mkdirSync(join(TPL, 'public'), { recursive: true })
  writeFileSync(join(TPL, 'src/scenes/GameScene.ts'), scene)
  writeFileSync(join(TPL, 'src/shared.ts'), 'export const SHARED = 1\n')
  writeFileSync(join(TPL, 'public/game-data.json'), gameData)
  writeFileSync(join(TPL, '_gitignore'), gitignore)
  writeFileSync(join(TPL, 'package.json'), '{"name":"tpl","version":"0.1.0"}\n')
  if (version === 'v2') {
    // a file that did not exist in v1 — upgrade must ADD it
    writeFileSync(join(TPL, 'src/new-in-v2.ts'), 'export const NEW = 1\n')
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  writeTemplate('v1')
  // scaffold the project as a v1 copy + the anchor root commit
  sh(ROOT, `cp -R ${TPL} ${PRJ}`)
  // restoreDotfiles equivalent: the project holds the DOTTED name
  rmSync(join(PRJ, '_gitignore'), { force: true })
  writeFileSync(join(PRJ, '.gitignore'), 'node_modules\n')
  sh(PRJ, 'git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm "cc init: scaffold"')
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

test('not a git repo → failed', () => {
  mkdirSync(join(ROOT, 'plain'), { recursive: true })
  const r = upgradeProject({ projectDir: join(ROOT, 'plain'), templateDir: TPL, templateVersion: '0.9.0' })
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('not a git repository')
})

test('non-scaffold root commit → failed (the marker is the contract)', () => {
  const foreign = join(ROOT, 'foreign')
  mkdirSync(foreign, { recursive: true })
  sh(foreign, 'git init -q && echo x > f && git add -A && git -c user.name=t -c user.email=t@t commit -qm "hello world"')
  const r2 = upgradeProject({ projectDir: foreign, templateDir: TPL, templateVersion: '0.9.0' })
  expect(r2.ok).toBe(false)
  expect(r2.reason).toContain('not a cc-init scaffolded project')
})

test('dirty worktree → failed — an upgrade must land as exactly one commit', () => {
  writeFileSync(join(PRJ, 'public/game-data.json'), '{"levels":9}\n')
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('not clean')
})

test('the core flow: untouched files replaced, project-edited files conflict, write surface untouched', () => {
  // project edits its write-surface file AND one template-owned file (a violation, but real life)
  writeFileSync(join(PRJ, 'public/game-data.json'), '{"levels":99}\n')
  writeFileSync(join(PRJ, 'src/shared.ts'), 'export const SHARED = 42\n')
  sh(PRJ, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm "project work"')

  writeTemplate('v2') // the new template changes GameScene.ts, .gitignore, game-data.json, adds new-in-v2.ts
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })

  expect(r.ok).toBe(true)
  expect(r.action).toBe('upgraded')
  expect(r.replaced).toContain('src/scenes/GameScene.ts')
  expect(r.replaced).toContain('src/new-in-v2.ts')
  expect(r.replaced).toContain('.gitignore')
  expect(r.conflicts).toEqual(['src/shared.ts']) // project-edited → skipped
  expect(readFileSync(join(PRJ, 'src/scenes/GameScene.ts'), 'utf-8')).toContain('SCENE = 2')
  expect(readFileSync(join(PRJ, 'src/shared.ts'), 'utf-8')).toContain('42') // NOT clobbered
  expect(readFileSync(join(PRJ, 'public/game-data.json'), 'utf-8')).toContain('99') // NOT touched

  // one commit, marker in subject, clean tree after
  const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: PRJ, encoding: 'utf-8' })
  expect(subject).toContain(`${UPGRADE_MARKER} 0.9.0`)
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PRJ, encoding: 'utf-8' })
  expect(dirty.trim()).toBe('')
})

test('--force overwrites conflicts', () => {
  writeFileSync(join(PRJ, 'src/shared.ts'), 'export const SHARED = 42\n')
  sh(PRJ, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm "project work"')
  writeTemplate('v2')
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0', force: true })
  expect(r.ok).toBe(true)
  expect(r.conflicts).toEqual([])
  expect(readFileSync(join(PRJ, 'src/shared.ts'), 'utf-8')).toContain('SHARED = 1')
})

test('findBaselineCommit: upgrade commit becomes the baseline', () => {
  writeTemplate('v2')
  upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })
  const { rootCommit, baseline } = findBaselineCommit(PRJ)
  expect(rootCommit).toBeTruthy()
  expect(baseline).toBeTruthy()
  expect(baseline).not.toEqual(rootCommit) // the upgrade commit, not the scaffold root
})

test('second upgrade with no further template change → no-change, and the baseline stays the upgrade commit', () => {
  writeTemplate('v2')
  const first = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })
  expect(first.action).toBe('upgraded')
  const second = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.1' })
  expect(second.ok).toBe(true)
  expect(second.action).toBe('no-change')
})

test('exact-name write-surface files (README, PROJECT_CONTEXT, the public manifests…) are never touched', () => {
  // v2 changes public/game-data.json AND the fixture gains README.md as an
  // exact-name write-surface file the project never edited — neither may
  // be replaced, precisely because the scaffold substituted placeholders
  // into them and a template copy would destroy that.
  writeTemplate('v2')
  mkdirSync(join(TPL, 'docs'), { recursive: true })
  writeFileSync(join(TPL, 'README.md'), 'project {{PROJECT_NAME}} readme\n')
  writeFileSync(join(PRJ, 'README.md'), 'project upg-e2e readme\n')
  writeFileSync(join(TPL, 'package.json'), '{"name":"tpl","version":"0.1.0"}\n')
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })
  expect(r.replaced).not.toContain('README.md')
  expect(r.replaced).not.toContain('public/game-data.json')
  expect(readFileSync(join(PRJ, 'README.md'), 'utf-8')).toContain('upg-e2e') // NOT clobbered
  expect(readFileSync(join(PRJ, 'public/game-data.json'), 'utf-8')).toContain('"levels":1') // untouched
})

test('placeholder replay: replaced template files land with the PROJECT name, not the raw {{PROJECT_NAME}}', () => {
  // project name lives in its rewritten package.json
  writeFileSync(join(PRJ, 'package.json'), '{"name":"upg-e2e","version":"0.1.0"}\n')
  sh(PRJ, 'git add package.json && git -c user.name=t -c user.email=t@t commit -qm "project identity"')
  writeTemplate('v2')
  writeFileSync(join(TPL, 'src/scenes/GameScene.ts'), '// {{PROJECT_NAME}} entry\nexport const SCENE = 2\n')
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0' })
  expect(r.replaced).toContain('src/scenes/GameScene.ts')
  const content = readFileSync(join(PRJ, 'src/scenes/GameScene.ts'), 'utf-8')
  expect(content).toContain('upg-e2e entry')
  expect(content).not.toContain('{{PROJECT_NAME}}')
})

test('dry run: reports the plan but writes nothing and commits nothing', () => {
  writeTemplate('v2')
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PRJ, encoding: 'utf-8' }).trim()
  const r = upgradeProject({ projectDir: PRJ, templateDir: TPL, templateVersion: '0.9.0', dryRun: true })
  expect(r.action).toBe('upgraded')
  expect(r.replaced).toContain('src/scenes/GameScene.ts')
  expect(readFileSync(join(PRJ, 'src/scenes/GameScene.ts'), 'utf-8')).toContain('SCENE = 1') // NOT written
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PRJ, encoding: 'utf-8' }).trim()
  expect(after).toBe(before) // no commit
})
