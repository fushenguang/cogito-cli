import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anchorAfterScaffold, anchorRunSnapshot } from '../git-anchor.js'

// These run real git in a temp dir — the module under test is a subprocess
// wrapper, so mocking spawnSync would test nothing. Each case asserts the
// on-disk truth (git log / git tag), not just the return value.

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-git-anchor-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function sh(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, encoding: 'utf-8' }).trim()
}

describe('anchorAfterScaffold (cc init)', () => {
  it('initializes, commits, and is idempotent on rerun', () => {
    const dir = join(root, 'b')
    execSync(`mkdir -p ${JSON.stringify(dir)}`)
    writeFileSync(join(dir, 'package.json'), '{ "name": "demo" }\n')

    const first = anchorAfterScaffold(dir)
    expect(first.ok).toBe(true)
    expect(first.action).toBe('initialized')
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(sh(dir, 'git log --oneline')).toContain('cc init: scaffold')
    // No committer identity was written to any config file (uses -c only).
    expect(sh(dir, 'git config --local --list')).not.toContain('user.name')

    // Rerun (scaffold retry round) must not touch anything.
    const second = anchorAfterScaffold(dir)
    expect(second).toEqual({ ok: true, action: 'skipped', reason: 'already-anchored' })
    expect(sh(dir, 'git rev-list --count HEAD')).toBe('1')
  })
})

describe('anchorRunSnapshot (cc evidence)', () => {
  it('skips without inventing a repo when .git is absent', () => {
    const dir = join(root, 'c')
    execSync(`mkdir -p ${JSON.stringify(dir)}`)
    const res = anchorRunSnapshot(dir)
    expect(res).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' })
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })

  it('commits dirty state and tags HEAD', () => {
    const dir = join(root, 'd')
    execSync(`mkdir -p ${JSON.stringify(dir)}`)
    anchorAfterScaffold(dir)
    writeFileSync(join(dir, 'src-change.txt'), 'run work\n')

    const res = anchorRunSnapshot(dir)
    expect(res.ok).toBe(true)
    expect(res.action).toBe('committed')
    expect(res.tag).toMatch(/^cc-evidence-\d+$/)
    expect(sh(dir, 'git log --oneline')).toContain('cc evidence: run snapshot')
    expect(sh(dir, `git tag -l '${res.tag}'`)).toBe(res.tag)
    expect(sh(dir, 'git status --porcelain')).toBe('')
  })

  it('tags HEAD without committing when the tree is clean', () => {
    const dir = join(root, 'e')
    execSync(`mkdir -p ${JSON.stringify(dir)}`)
    writeFileSync(join(dir, 'package.json'), '{ "name": "clean" }\n')
    anchorAfterScaffold(dir)

    const res = anchorRunSnapshot(dir)
    expect(res.ok).toBe(true)
    expect(res.action).toBe('tagged')
    expect(res.tag).toMatch(/^cc-evidence-\d+$/)
    expect(sh(dir, 'git rev-list --count HEAD')).toBe('1') // no extra commit
    expect(sh(dir, `git tag -l '${res.tag}'`)).toBe(res.tag)
  })
})
