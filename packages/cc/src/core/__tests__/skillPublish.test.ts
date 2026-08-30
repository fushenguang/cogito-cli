import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { publishSkill, isValidSemver, resolveVersion, MANIFEST_FILENAME } from '../skillPublish.js'
import type { SkillAuthor } from '../skillPublish.js'
import type { SkillManifest } from '../skillPublish.js'
import type { AuthProvider } from '../auth.js'

// This file never wants a test run to touch a real `~/.cogito` — most
// tests below call `publishSkill` without an explicit `authEnv`, and after
// this change that path also decides whether `indexToRegistry` fires a real
// HTTP request. On a machine where the person running `pnpm test` happens to
// be logged in via `cc auth login` for real, an un-mocked `homedir()`
// would make every one of those tests read a real access token and (absent
// an injected `fetchImpl`) POST it at the real provider. Redirecting
// `homedir()` to a directory that never has a `.cogito` in it makes every
// call site that doesn't pass its own `authEnv` deterministically anonymous
// — tests that need a signed-in identity already pass `authEnv: { homeDir }`
// explicitly, which overrides this.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/cogito-test-no-real-home` }
})

const FAKE_REMOTE = 'git@example.com:acme/skills-repo.git'

function makeWorkDir(label: string): string {
  const dir = join(
    tmpdir(),
    `cogito-skill-publish-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A bare git repo (with an `origin` remote, no skill inside) — stands in for a `--registry` checkout. */
function makeRegistryRepo(label: string, remote: string): string {
  const repoRoot = makeWorkDir(`registry-repo-${label}`)
  execSync('git init -q -b main', { cwd: repoRoot, stdio: 'ignore' })
  execSync(`git remote add origin ${remote}`, { cwd: repoRoot, stdio: 'ignore' })
  return repoRoot
}

/** A git repo (with an `origin` remote) containing a skill directory at `skills/<name>`. */
function makeSkillRepo(
  name: string,
  frontmatter: string,
  remote: string = FAKE_REMOTE,
): { repoRoot: string; skillDir: string } {
  const repoRoot = makeWorkDir(`repo-${name}`)
  // `-b main` pins the branch name deterministically regardless of the host's
  // `init.defaultBranch` config (cli-publish-giturl-scope: tests below assert
  // on the resolved branch, so it can't be left to whatever a given machine
  // or CI runner happens to default to).
  execSync('git init -q -b main', { cwd: repoRoot, stdio: 'ignore' })
  execSync(`git remote add origin ${remote}`, { cwd: repoRoot, stdio: 'ignore' })

  const skillDir = join(repoRoot, 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8',
  )

  return { repoRoot, skillDir }
}

function readManifest(registryDir: string): SkillManifest {
  return JSON.parse(readFileSync(join(registryDir, MANIFEST_FILENAME), 'utf-8')) as SkillManifest
}

describe('publishSkill', () => {
  let cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    cleanupDirs = []
  })

  it('writes a manifest entry with the resolved git source for a valid skill', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'good-skill',
      'name: good-skill\ndescription: A valid publishable skill.',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.updated).toBe(false)
    expect(result.entry.id).toBe('good-skill')
    expect(result.entry.name).toBe('good-skill')
    expect(result.entry.description).toBe('A valid publishable skill.')
    // FAKE_REMOTE is SCP-like SSH (`git@example.com:acme/skills-repo.git`);
    // the published `source` MUST be the normalized, credential-free HTTPS
    // form (design.md §1 row 1), not the raw `git remote get-url` output.
    // This assertion used to be `=== FAKE_REMOTE` — that locked in the
    // defect this change fixes (design.md §4).
    expect(result.entry.source).toBe('https://example.com/acme/skills-repo')
    expect(result.entry.path).toBe(join('skills', 'good-skill'))
    expect(result.entry.nonSpecFields).toBeUndefined()
    expect(typeof result.entry.publishedAt).toBe('string')

    expect(existsSync(result.manifestPath)).toBe(true)
    const manifest = readManifest(registryDir)
    expect(manifest.version).toBe('1')
    expect(manifest.skills).toHaveLength(1)
    expect(manifest.skills[0]?.id).toBe('good-skill')
  })

  it('records downgraded non-spec top-level fields explicitly on the manifest entry (never silently dropped)', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'pipeline-skill',
      [
        'name: pipeline-skill',
        'description: A skill with a non-spec top-level key.',
        'pipeline:',
        '  post_processor: md2pptx',
      ].join('\n'),
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.entry.nonSpecFields).toEqual(['pipeline'])
  })

  it('is idempotent: republishing the same skill updates the entry instead of duplicating it', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'repeat-skill',
      'name: repeat-skill\ndescription: First description.',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const first = await publishSkill(skillDir, registryDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.updated).toBe(false)

    // Change the description and republish the same skill (same name/id).
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: repeat-skill\ndescription: Updated description.\n---\n\n# repeat-skill\n\nBody.\n',
      'utf-8',
    )

    const second = await publishSkill(skillDir, registryDir)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.updated).toBe(true)

    const manifest = readManifest(registryDir)
    expect(manifest.skills).toHaveLength(1)
    expect(manifest.skills[0]?.description).toBe('Updated description.')
  })

  it('does not write a manifest when validation fails', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'broken-skill',
      'description: Missing the name field.',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('SKILL_INVALID')
    expect(result.errors?.length).toBeGreaterThan(0)
    expect(existsSync(join(registryDir, MANIFEST_FILENAME))).toBe(false)
  })

  it('returns REGISTRY_NOT_FOUND when the registry checkout does not exist', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'good-skill-2',
      'name: good-skill-2\ndescription: Valid.',
    )
    cleanupDirs.push(repoRoot)
    const missingRegistryDir = join(tmpdir(), `cogito-does-not-exist-${Date.now()}`)

    const result = await publishSkill(skillDir, missingRegistryDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('REGISTRY_NOT_FOUND')
  })

  it('returns SKILL_SOURCE_UNRESOLVED when the skill directory is not inside a git repository', async () => {
    const parentDir = makeWorkDir('no-git')
    const skillDir = join(parentDir, 'lonely-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: lonely-skill\ndescription: Not in a git repo.\n---\n\nBody.\n',
      'utf-8',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(parentDir, registryDir)

    // Guard against the (unlikely) case tmpdir() itself sits inside a git
    // repo on some machine — this test's premise requires it not to.
    let insideGitRepo = true
    try {
      execSync('git rev-parse --show-toplevel', { cwd: skillDir, stdio: 'ignore' })
    } catch {
      insideGitRepo = false
    }
    if (insideGitRepo) return

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('SKILL_SOURCE_UNRESOLVED')
  })

  it('determinism: SSH and HTTPS origins for the same repo publish the same source (design.md §4)', async () => {
    const sshRepo = makeSkillRepo(
      'determinism-skill',
      'name: determinism-skill\ndescription: Published from an SSH origin.',
      'git@github.com:acme/determinism-repo.git',
    )
    const httpsRepo = makeSkillRepo(
      'determinism-skill',
      'name: determinism-skill\ndescription: Published from an HTTPS origin.',
      'https://github.com/acme/determinism-repo.git',
    )
    const registryDirSsh = makeWorkDir('registry-ssh')
    const registryDirHttps = makeWorkDir('registry-https')
    cleanupDirs.push(sshRepo.repoRoot, httpsRepo.repoRoot, registryDirSsh, registryDirHttps)

    const sshResult = await publishSkill(sshRepo.skillDir, registryDirSsh)
    const httpsResult = await publishSkill(httpsRepo.skillDir, registryDirHttps)

    expect(sshResult.ok).toBe(true)
    expect(httpsResult.ok).toBe(true)
    if (!sshResult.ok || !httpsResult.ok) return

    expect(sshResult.entry.source).toBe(httpsResult.entry.source)
    expect(sshResult.entry.source).toBe('https://github.com/acme/determinism-repo')
  })

  it('credentials embedded in the origin never reach the published source (design.md §4)', async () => {
    const token = 'FAKE-TOKEN-DO-NOT-USE'
    const { repoRoot, skillDir } = makeSkillRepo(
      'credential-skill',
      'name: credential-skill\ndescription: Origin has embedded credentials.',
      `https://x-access-token:${token}@github.com/acme/credential-repo.git`,
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.source).toBe('https://github.com/acme/credential-repo')
    expect(result.entry.source).not.toContain(token)

    const manifest = readManifest(registryDir)
    expect(JSON.stringify(manifest)).not.toContain(token)
  })

  it('a local-path origin fails explicitly and leaves the registry untouched (design.md §1 row 9)', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'local-path-origin-skill',
      'name: local-path-origin-skill\ndescription: Origin is a local filesystem path.',
      '/tmp/some-local-repo',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('SKILL_SOURCE_UNRESOLVED')
    expect(result.message).toContain('/tmp/some-local-repo')
    expect(existsSync(join(registryDir, MANIFEST_FILENAME))).toBe(false)
  })
})

describe('publish attribution (cli-auth)', () => {
  const AUTHOR: SkillAuthor = { id: 'user-uuid-1', name: 'someone@example.com' }

  it('stamps the author into the manifest entry when signed in', async () => {
    const { skillDir } = makeSkillRepo('signed', 'name: signed\ndescription: A signed skill.')
    const registry = makeWorkDir('registry-signed')

    const result = await publishSkill(skillDir, registry, { author: AUTHOR })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.anonymous).toBe(false)
    expect(result.entry.author).toEqual(AUTHOR)

    const manifest = JSON.parse(
      readFileSync(join(registry, MANIFEST_FILENAME), 'utf-8'),
    ) as SkillManifest
    expect(manifest.skills[0]?.author?.id).toBe(AUTHOR.id)
  })

  /**
   * Absent, not null: same "omit when empty" convention as path/license, so a
   * consumer can test `if (entry.author)` without special-casing null.
   */
  it('omits the author field entirely when publishing anonymously', async () => {
    const { skillDir } = makeSkillRepo('anon', 'name: anon\ndescription: An unsigned skill.')
    const registry = makeWorkDir('registry-anon')

    const result = await publishSkill(skillDir, registry, { author: undefined })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.anonymous).toBe(true)
    const raw = readFileSync(join(registry, MANIFEST_FILENAME), 'utf-8')
    expect(raw).not.toContain('author')
    expect(JSON.parse(raw).skills[0]).not.toHaveProperty('author')
  })

  it('reads the signed-in identity from the injected home dir when no author is passed', async () => {
    const { skillDir } = makeSkillRepo('fromcreds', 'name: fromcreds\ndescription: From creds.')
    const registry = makeWorkDir('registry-creds')
    const home = makeWorkDir('home-creds')
    mkdirSync(join(home, '.cogito'), { recursive: true })
    writeFileSync(
      join(home, '.cogito', 'credentials.json'),
      JSON.stringify({
        provider: 'thefoolai',
        userId: 'user-uuid-2',
        displayName: 'from@creds.example',
        accessToken: 'never-printed',
        savedAt: '2026-08-19T00:00:00.000Z',
      }),
    )

    // This test deliberately provides real-looking credentials to exercise
    // `currentAuthor`'s read path — which means it is signed in as far as
    // `indexToRegistry` is concerned too. Inject a `fetchImpl` so that stays
    // a fake in-memory call instead of a real POST to production.
    let indexRequestSeen = false
    const fetchImpl = async (): Promise<Response> => {
      indexRequestSeen = true
      return new Response('{}', { status: 200 })
    }

    const result = await publishSkill(skillDir, registry, { authEnv: { homeDir: home }, fetchImpl })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.author).toEqual({ id: 'user-uuid-2', name: 'from@creds.example' })
    expect(indexRequestSeen).toBe(true)
    expect(result.indexed).toBe(true)
  })
})

describe('isValidSemver', () => {
  it.each(['1.2.3', '1.2.3-beta.1', '1.2.3+build.5', '0.0.1', '10.20.30'])(
    'accepts %s',
    (version) => {
      expect(isValidSemver(version)).toBe(true)
    },
  )

  // Reverse control (proposal.md 验收 — "反向对照（不可省）"): every one of
  // these must be rejected, especially `v1.2.0` — thefoolai's
  // `compareVersions()` silently parses a `v` prefix down to 0 (see the
  // SEMVER_PATTERN doc comment in skillPublish.ts), which is the entire
  // reason this gate exists.
  it.each(['v1.2.0', '2026-08-19', '1.x', 'latest', '1.2'])('rejects %s', (version) => {
    expect(isValidSemver(version)).toBe(false)
  })
})

describe('resolveVersion', () => {
  it('reads the tool-neutral `version` key', () => {
    expect(resolveVersion({ version: '1.2.3' })).toBe('1.2.3')
  })

  it("falls back to thefoolai's namespaced `thefool.version` key", () => {
    expect(resolveVersion({ 'thefool.version': '1.2.3' })).toBe('1.2.3')
  })

  it('prefers the tool-neutral key when both are present', () => {
    expect(resolveVersion({ version: '2.0.0', 'thefool.version': '1.0.0' })).toBe('2.0.0')
  })

  it('returns undefined when neither key is present', () => {
    expect(resolveVersion({})).toBeUndefined()
  })

  it('treats a blank version as absent', () => {
    expect(resolveVersion({ version: '   ' })).toBeUndefined()
  })
})

describe('publishSkill version handling', () => {
  let cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    cleanupDirs = []
  })

  it('writes a valid semver from metadata.version into the manifest entry', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'versioned-skill',
      'name: versioned-skill\ndescription: Has a version.\nmetadata:\n  version: 1.2.3',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.version).toBe('1.2.3')
    expect(result.versionMissing).toBe(false)

    const manifest = readManifest(registryDir)
    expect(manifest.skills[0]?.version).toBe('1.2.3')
  })

  it('accepts a semver with prerelease and build metadata', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'prerelease-skill',
      'name: prerelease-skill\ndescription: Has a prerelease version.\nmetadata:\n  version: 1.2.3-beta.1+build.5',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.version).toBe('1.2.3-beta.1+build.5')
  })

  it("falls back to thefoolai's `thefool.version` metadata key", async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'thefool-versioned-skill',
      'name: thefool-versioned-skill\ndescription: thefoolai-style version.\nmetadata:\n  thefool.version: 3.4.5',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.version).toBe('3.4.5')
  })

  // Reverse control (proposal.md 验收): a malformed version must fail
  // publish outright — this is the fail-closed half of decision (b). The
  // `v1.2.0` case in particular is the exact string that silently breaks
  // thefoolai's update path (skillPublish.ts SEMVER_PATTERN doc comment).
  it.each(['v1.2.0', '2026-08-19', '1.x', 'latest', '1.2'])(
    'rejects publish when metadata.version is "%s", and leaves the registry untouched',
    async (badVersion) => {
      const { repoRoot, skillDir } = makeSkillRepo(
        'bad-version-skill',
        `name: bad-version-skill\ndescription: Has a malformed version.\nmetadata:\n  version: "${badVersion}"`,
      )
      const registryDir = makeWorkDir('registry')
      cleanupDirs.push(repoRoot, registryDir)

      const result = await publishSkill(skillDir, registryDir)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('SKILL_VERSION_INVALID')
      // Error message must show both the received value and the expected shape.
      expect(result.message).toContain(badVersion)
      expect(result.message).toContain('major.minor.patch')
      expect(existsSync(join(registryDir, MANIFEST_FILENAME))).toBe(false)
    },
  )

  it('publishes successfully with no version at all, and flags it as missing', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'unversioned-skill',
      'name: unversioned-skill\ndescription: No version at all.',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const result = await publishSkill(skillDir, registryDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.version).toBeUndefined()
    expect(result.versionMissing).toBe(true)

    const manifest = readManifest(registryDir)
    expect(manifest.skills[0]).not.toHaveProperty('version')
  })

  it('idempotent: republishing with a new version overwrites the old one, and there is still only one entry', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'reversioned-skill',
      'name: reversioned-skill\ndescription: v1.\nmetadata:\n  version: 1.0.0',
    )
    const registryDir = makeWorkDir('registry')
    cleanupDirs.push(repoRoot, registryDir)

    const first = await publishSkill(skillDir, registryDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.entry.version).toBe('1.0.0')

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: reversioned-skill\ndescription: v2.\nmetadata:\n  version: 2.0.0\n---\n\n# reversioned-skill\n\nBody.\n',
      'utf-8',
    )

    const second = await publishSkill(skillDir, registryDir)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.updated).toBe(true)
    expect(second.entry.version).toBe('2.0.0')

    const manifest = readManifest(registryDir)
    expect(manifest.skills).toHaveLength(1)
    expect(manifest.skills[0]?.version).toBe('2.0.0')
  })
})

// cli-publish-to-registry: `publishSkill` writes the manifest, then makes one
// best-effort attempt to index the entry into the hosted registry. Unit
// coverage of the request itself (headers, body shape, timeout, no-retry)
// lives in registryIndex.test.ts — this block only covers the wiring: does
// `publishSkill` call it at the right time, with the right data, and fold
// the result into its own return value without ever letting it affect the
// manifest write.
describe('publish indexing (cli-publish-to-registry)', () => {
  let cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    cleanupDirs = []
  })

  const PROVIDER: AuthProvider = { name: 'thefoolai', webUrl: 'https://web.example' }

  function makeSignedInHome(label: string, accessToken: string): string {
    const home = makeWorkDir(label)
    mkdirSync(join(home, '.cogito'), { recursive: true })
    writeFileSync(
      join(home, '.cogito', 'credentials.json'),
      JSON.stringify({
        provider: 'thefoolai',
        userId: `user-${label}`,
        accessToken,
        savedAt: '2026-08-19T00:00:00.000Z',
      }),
    )
    return home
  }

  it('does not call the registry endpoint when not signed in — manifest is still written', async () => {
    const { repoRoot, skillDir } = makeSkillRepo('idx-anon', 'name: idx-anon\ndescription: Anon publish.')
    const registryDir = makeWorkDir('registry')
    const home = makeWorkDir('home-idx-anon') // no .cogito/credentials.json
    cleanupDirs.push(repoRoot, registryDir, home)

    let called = false
    const fetchImpl = async (): Promise<Response> => {
      called = true
      return new Response('{}', { status: 200 })
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.anonymous).toBe(true)
    expect(result.indexed).toBe(false)
    expect(result.indexError).toBeUndefined()
    expect(called).toBe(false)
    expect(existsSync(result.manifestPath)).toBe(true)
  })

  it('indexes the entry when signed in and the endpoint accepts the request, and sends only the allowed fields', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'idx-ok',
      'name: idx-ok\ndescription: Indexed ok.\nlicense: MIT\nmetadata:\n  version: 1.0.0',
    )
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-ok', 'tok-idx-ok')
    cleanupDirs.push(repoRoot, registryDir, home)

    let capturedUrl: string | undefined
    let capturedAuth: string | undefined
    let capturedBody: Record<string, unknown> = {}
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization
      capturedBody = JSON.parse(init?.body as string)
      return new Response('{}', { status: 200 })
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.indexed).toBe(true)
    expect(result.indexError).toBeUndefined()
    expect(capturedUrl).toBe('https://web.example/api/skills/publish')
    expect(capturedAuth).toBe('Bearer tok-idx-ok')
    expect(capturedBody).toEqual({
      skill_id: 'idx-ok',
      git_url: result.entry.source,
      name: 'idx-ok',
      description: 'Indexed ok.',
      version: '1.0.0',
      license: 'MIT',
      // makeSkillRepo() nests the skill dir under `<repoRoot>/skills/<name>`
      // (cli-publish-giturl-scope tasks.md 1.1: this is the field that was
      // silently lost before this cut — proposal.md "Why", step ①).
      path: result.entry.path,
      branch: 'main',
    })
    expect(result.entry.path).toBe(join('skills', 'idx-ok'))
    // Reverse control: fields the server assigns must never be client-supplied.
    expect(capturedBody).not.toHaveProperty('access_tier')
    expect(capturedBody).not.toHaveProperty('is_official')
    expect(capturedBody).not.toHaveProperty('security_status')
  })

  // cli-publish-giturl-scope tasks.md 1.2: the branch sent must be whatever
  // branch the skill's source repo is actually on, not a hardcoded default.
  it('sends the actually-checked-out branch, not always "main"', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'idx-branch',
      'name: idx-branch\ndescription: Published from a feature branch.',
    )
    execSync('git checkout -q -b feature/publish-test', { cwd: repoRoot, stdio: 'ignore' })
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-branch', 'tok-idx-branch')
    cleanupDirs.push(repoRoot, registryDir, home)

    let capturedBody: Record<string, unknown> = {}
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response('{}', { status: 200 })
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(capturedBody.branch).toBe('feature/publish-test')
  })

  // cli-publish-giturl-scope tasks.md 1.2: detached HEAD has no branch name
  // (`git branch --show-current` prints an empty string there) — the
  // documented, verified fallback must kick in rather than sending "".
  it('falls back to the documented default branch when HEAD is detached', async () => {
    const { repoRoot, skillDir } = makeSkillRepo(
      'idx-detached',
      'name: idx-detached\ndescription: Published from a detached HEAD.',
    )
    writeFileSync(join(repoRoot, 'README.md'), 'x', 'utf-8')
    execSync('git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m init', {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: '/bin/bash',
    })
    execSync('git checkout -q --detach', { cwd: repoRoot, stdio: 'ignore' })
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-detached', 'tok-idx-detached')
    cleanupDirs.push(repoRoot, registryDir, home)

    let capturedBody: Record<string, unknown> = {}
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response('{}', { status: 200 })
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(capturedBody.branch).toBe('main')
  })

  it('still writes the manifest when the registry endpoint is unreachable, reports the failure, and never retries', async () => {
    const { repoRoot, skillDir } = makeSkillRepo('idx-fail', 'name: idx-fail\ndescription: Endpoint down.')
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-fail', 'tok-idx-fail')
    cleanupDirs.push(repoRoot, registryDir, home)

    let callCount = 0
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1
      throw new Error('ECONNREFUSED')
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.indexed).toBe(false)
    expect(result.indexError).toContain('ECONNREFUSED')
    expect(existsSync(result.manifestPath)).toBe(true)
    expect(readManifest(registryDir).skills).toHaveLength(1)
    expect(callCount).toBe(1)
  })

  it('still writes the manifest when the registry endpoint returns a non-2xx status', async () => {
    const { repoRoot, skillDir } = makeSkillRepo('idx-404', 'name: idx-404\ndescription: Not found.')
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-404', 'tok-idx-404')
    cleanupDirs.push(repoRoot, registryDir, home)

    const fetchImpl = async (): Promise<Response> => new Response('not found', { status: 404 })

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.indexed).toBe(false)
    expect(result.indexError).toBe('HTTP 404')
    expect(existsSync(result.manifestPath)).toBe(true)
  })

  // cli-publish-giturl-scope tasks.md 1.4: when the server rejects the entry
  // (e.g. design.md 方案 A — an old CLI that didn't send `path`), publish
  // must NOT roll the manifest back, must NOT retry, and must fold the
  // rejection into `indexError`/`indexed: false` exactly like any other
  // indexing failure — sending `path` did not carve out a new "block publish
  // outright" behavior anywhere in this file.
  it('still writes the manifest, only warns, and does not retry when the server rejects the entry outright', async () => {
    const { repoRoot, skillDir } = makeSkillRepo('idx-rejected', 'name: idx-rejected\ndescription: Server said no.')
    const registryDir = makeWorkDir('registry')
    const home = makeSignedInHome('home-idx-rejected', 'tok-idx-rejected')
    cleanupDirs.push(repoRoot, registryDir, home)

    let callCount = 0
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1
      return new Response(
        JSON.stringify({ error: 'path_required', message: 'Upgrade cogito: npm install -g @cogito.ai/cc@latest' }),
        { status: 400 },
      )
    }

    const result = await publishSkill(skillDir, registryDir, {
      authEnv: { homeDir: home },
      provider: PROVIDER,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.indexed).toBe(false)
    expect(result.indexError).toBe('Upgrade cogito: npm install -g @cogito.ai/cc@latest')
    expect(existsSync(result.manifestPath)).toBe(true)
    expect(readManifest(registryDir).skills).toHaveLength(1)
    expect(readManifest(registryDir).skills[0]?.id).toBe('idx-rejected')
    expect(callCount).toBe(1)
  })

  // The real incident this coverage guards against: a skill was published
  // with `--registry` pointing at a public content repo while the skill
  // directory itself lived in an unrelated *private* repo. The manifest
  // entry silently carried that private repo's URL — nobody downstream
  // could tell without reading `entry.source` themselves. `publishSkill`
  // must surface that mismatch as data (`registrySource` /
  // `sourceRepoDiffersFromRegistry`), not just as manifest bytes.
  describe('source vs. registry checkout provenance', () => {
    it('flags a mismatch when the skill repo and the --registry checkout have different origins', async () => {
      const { repoRoot, skillDir } = makeSkillRepo(
        'private-source-skill',
        'name: private-source-skill\ndescription: Lives in a different repo than the registry.',
        'git@github.com:acme-private/private-skills.git',
      )
      const registryDir = makeRegistryRepo('mismatch', 'https://github.com/acme-public/public-registry.git')
      cleanupDirs.push(repoRoot, registryDir)

      const result = await publishSkill(skillDir, registryDir)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.entry.source).toBe('https://github.com/acme-private/private-skills')
      expect(result.registrySource).toBe('https://github.com/acme-public/public-registry')
      expect(result.sourceRepoDiffersFromRegistry).toBe(true)
    })

    it('does not flag a mismatch when the skill repo IS the --registry checkout', async () => {
      const registryDir = makeRegistryRepo('same-repo', 'https://github.com/acme/skills-repo.git')
      const skillDir = join(registryDir, 'skills', 'in-registry-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: in-registry-skill\ndescription: Lives inside the registry checkout itself.\n---\n\nBody.\n',
        'utf-8',
      )
      cleanupDirs.push(registryDir)

      const result = await publishSkill(skillDir, registryDir)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.entry.source).toBe(result.registrySource)
      expect(result.sourceRepoDiffersFromRegistry).toBe(false)
    })

    it('omits both fields when the --registry checkout is not itself a git repo (e.g. an ad hoc directory)', async () => {
      const { repoRoot, skillDir } = makeSkillRepo(
        'plain-dir-registry-skill',
        'name: plain-dir-registry-skill\ndescription: Registry checkout has no git repo at all.',
      )
      // Deliberately NOT git-initialized — `makeWorkDir` alone, same as every
      // other test's `registryDir` in this file.
      const registryDir = makeWorkDir('registry-not-git')
      cleanupDirs.push(repoRoot, registryDir)

      const result = await publishSkill(skillDir, registryDir)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.registrySource).toBeUndefined()
      expect(result.sourceRepoDiffersFromRegistry).toBeUndefined()
    })
  })
})
