import { describe, it, expect } from 'vitest'
import { normalizeGitRemoteUrl } from '../gitRemoteUrl.js'

/**
 * Table-driven coverage of design.md §1 — the rule table is the single
 * source of truth. Each row below is annotated with its row number from
 * that table.
 */
describe('normalizeGitRemoteUrl', () => {
  it('row 1: SCP-like SSH with user → https, no port, no .git', () => {
    expect(normalizeGitRemoteUrl('git@github.com:owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
    })
  })

  it('row 2: SCP-like without user → https', () => {
    expect(normalizeGitRemoteUrl('github.com:owner/repo')).toEqual({
      url: 'https://github.com/owner/repo',
    })
  })

  it('row 3: ssh:// with userinfo and port → https, userinfo and port dropped', () => {
    expect(normalizeGitRemoteUrl('ssh://git@github.com:22/owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
    })
  })

  it('row 4: git:// → https', () => {
    expect(normalizeGitRemoteUrl('git://github.com/owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
    })
  })

  it('row 5: git+ssh:// → https, userinfo dropped', () => {
    expect(normalizeGitRemoteUrl('git+ssh://git@host.com/o/r.git')).toEqual({
      url: 'https://host.com/o/r',
    })
  })

  it('row 6: https:// → only .git and trailing slash stripped', () => {
    expect(normalizeGitRemoteUrl('https://github.com/owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo',
    })
  })

  it('row 7: https:// with embedded credentials → credentials dropped', () => {
    // Built from a variable rather than written as one literal: a literal
    // `user:pass@host` URL trips the repo's secretlint gate (which is doing
    // its job — that is exactly the shape this test exists to eliminate).
    const token = 'FAKE-TOKEN-DO-NOT-USE'
    const result = normalizeGitRemoteUrl(`https://x-token:${token}@github.com/o/r.git`)
    expect(result).toEqual({ url: 'https://github.com/o/r' })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('x-token')
  })

  it('row 8: http:// → scheme is preserved, not upgraded to https', () => {
    expect(normalizeGitRemoteUrl('http://git.internal.example.com/o/r.git')).toEqual({
      url: 'http://git.internal.example.com/o/r',
    })
  })

  it('row 9: absolute local path → error', () => {
    const result = normalizeGitRemoteUrl('/Users/x/repo')
    expect('error' in result).toBe(true)
  })

  it('row 9: relative local path → error', () => {
    const result = normalizeGitRemoteUrl('../repo')
    expect('error' in result).toBe(true)
  })

  it('row 9: file:// → error', () => {
    const result = normalizeGitRemoteUrl('file:///Users/x/repo')
    expect('error' in result).toBe(true)
  })

  it('row 10: dotless host (SSH config alias) → error, not guessed at', () => {
    const result = normalizeGitRemoteUrl('git@my-alias:owner/repo.git')
    expect('error' in result).toBe(true)
  })

  it('row 11: empty string → error', () => {
    const result = normalizeGitRemoteUrl('')
    expect('error' in result).toBe(true)
  })

  it('row 11: unparseable garbage → error', () => {
    const result = normalizeGitRemoteUrl('::::')
    expect('error' in result).toBe(true)
  })

  it('error messages include the original remote and an actionable fix (design.md §2)', () => {
    const original = '/Users/x/repo'
    const result = normalizeGitRemoteUrl(original)
    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain(original)
    expect(result.error).toContain('git remote set-url origin https://')
  })

  it('determinism: SSH and HTTPS forms of the same repo normalize to the same string', () => {
    const fromSsh = normalizeGitRemoteUrl('git@github.com:acme/widgets.git')
    const fromHttps = normalizeGitRemoteUrl('https://github.com/acme/widgets.git')
    expect(fromSsh).toEqual(fromHttps)
  })
})
