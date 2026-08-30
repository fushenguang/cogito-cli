import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { readProperties } from 'skills-ref'
import { type AuthEnvironment, type AuthProvider, type FetchLike, readCredentials } from './auth.js'
import { normalizeGitRemoteUrl } from './gitRemoteUrl.js'
import { indexToRegistry } from './registryIndex.js'
import { extractNonSpecFields, validateSkill } from './skillValidate.js'

/**
 * git manifest schema for the skill registry.
 *
 * Shape borrowed from `src/registry.json` (id/name/description/source —
 * design.md §2), but NOT its loading code: that code hardcodes "content is
 * bundled inside the CLI package", which doesn't fit "source points at an
 * external git repo" (design.md §2 / tasks.md 2.2).
 *
 * There is deliberately no `minCliVersion` / `resolvedDependencies` here —
 * those are template-registry concepts (CLI compat gate, npm deps), and the
 * Agent Skills spec has no version field to borrow instead.
 */
/**
 * Who published this entry (cli-auth design.md §4).
 *
 * `id` is the stable key attribution hangs off; `name` is a redundant, possibly
 * stale human label. Storing only the readable one would break provenance the
 * first time somebody changes their display name.
 */
export interface SkillAuthor {
  id: string
  name?: string
}

export interface SkillManifestEntry {
  /** Skill name from frontmatter — also the idempotency key (design.md §2, tasks.md 2.4). */
  id: string
  name: string
  description: string
  /** git remote URL of the repo that contains this skill. */
  source: string
  /** Path of the skill directory relative to the repo root, when not the repo root itself. */
  path?: string
  license?: string
  /**
   * Semver string, read from `metadata.version` (falling back to
   * thefoolai's `metadata['thefool.version']`) — see `resolveVersion` below.
   * The Agent Skills spec has no top-level `version` field, so this is never
   * read from frontmatter directly (openspec skill-semver-and-author-name
   * proposal.md "What Changes" #2). Optional: a skill may publish without a
   * version (proposal.md 待裁决 #1, resolved (b)) but never with a
   * malformed one — `publishSkill` rejects that before it reaches here.
   * Present only when non-empty — same "omit when empty" convention as
   * `path` / `license` / `author`.
   */
  version?: string
  /**
   * Non-spec top-level frontmatter keys that skills-ref downgraded to
   * warnings (design.md §3.1 附带要求). Present only when non-empty — never
   * silently dropped.
   */
  nonSpecFields?: string[]
  /**
   * Publisher identity, present only when the CLI was logged in at publish time.
   * Absent (not `null`) when anonymous — same "omit when empty" convention as
   * `path` / `license` / `nonSpecFields` above.
   */
  author?: SkillAuthor
  /** ISO 8601 timestamp of the most recent publish of this entry. */
  publishedAt: string
}

export interface SkillManifest {
  version: '1'
  skills: SkillManifestEntry[]
}

export interface SkillPublishResult {
  ok: true
  entry: SkillManifestEntry
  manifestPath: string
  /** true when an existing entry with the same id was replaced (idempotent update). */
  updated: boolean
  /** true when nobody was signed in, so the entry carries no author. */
  anonymous: boolean
  /**
   * true when the skill published with no version at all — publish is not
   * blocked on this (proposal.md 待裁决 #1, resolved (b): optional but loudly
   * warned), but adapters use this flag to surface the warning since core
   * never writes to stdout/stderr itself.
   */
  versionMissing: boolean
  /**
   * true when the entry was also indexed into the hosted registry
   * (`cli-publish-to-registry` proposal.md — the step after the manifest
   * write). This is always an addendum: false here NEVER means the manifest
   * write failed, and it never rolls the manifest write back — see
   * `manifestPath` above, which is populated either way.
   */
  indexed: boolean
  /**
   * Present only when `indexed` is false because the request itself failed
   * (network error, timeout, non-2xx) — NOT when it's false because nobody
   * was signed in (that case is already covered by `anonymous`, and carries
   * no error to show). Adapters use this to print a status/error summary.
   */
  indexError?: string
  /**
   * The `--registry` checkout's own `origin` remote (normalized the same
   * way `entry.source` is), present only when it could be resolved — i.e.
   * `registryDir` is itself inside a git repo with a clonable `origin`.
   * Absent whenever that can't be determined (registryDir has no git repo,
   * no `origin`, or an unresolvable remote), which is common in ad hoc or
   * test registry checkouts and is not an error.
   */
  registrySource?: string
  /**
   * `true` when `entry.source` (the skill's OWN repo) does not match
   * `registrySource` (the `--registry` checkout's own repo) — i.e. `publish`
   * wrote a manifest entry that points somewhere other than the registry
   * checkout it was written into. This is a legitimate, intentional shape
   * (publish never copies skill files into the registry repo — see this
   * function's doc comment) but easy to hit by accident, most dangerously
   * when the skill's own repo is private: nobody but the publisher can then
   * `git clone` what the entry points at. Present only alongside
   * `registrySource` — when that can't be resolved, no comparison was made,
   * so this field is omitted rather than defaulting to `false` (which would
   * read as "confirmed same" when nothing was actually confirmed).
   */
  sourceRepoDiffersFromRegistry?: boolean
}

export interface SkillPublishError {
  ok: false
  error:
    | 'SKILL_INVALID'
    | 'REGISTRY_NOT_FOUND'
    | 'SKILL_SOURCE_UNRESOLVED'
    | 'SKILL_VERSION_INVALID'
    | 'SKILL_PUBLISH_FAILED'
  message: string
  errors?: string[]
}

/** Filename of the manifest written into the `--registry` checkout. */
export const MANIFEST_FILENAME = 'skills.json'

/**
 * Strict semver (https://semver.org, the same grammar as the spec's own
 * regex): `major.minor.patch` with optional `-prerelease` and `+build`
 * segments, no leading `v`. Deliberately not a dependency — see tasks.md
 * 1.2 ("不引入新依赖").
 *
 * ★ Why this matters more than it looks: thefoolai's `compareVersions()`
 * parses each dot-separated segment with `parseInt(segment, 10) || 0`. Fed
 * `v1.2.0`, that silently parses as `[0, 2, 0]` — lower than `0.9.9` — so the
 * update path never triggers again for that skill, with no error anywhere
 * (openspec skill-semver-and-author-name proposal.md "缺口一"). Rejecting
 * non-semver strings here, before they ever reach a manifest, is the actual
 * fix; thefoolai's parser is left as-is (proposal.md Non-goals).
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * Reads the skill's version out of `metadata` — never off a top-level
 * frontmatter key, since the Agent Skills spec doesn't define one and adding
 * one there would just re-trigger the non-spec-field downgrade `lesson-prep`
 * already hit (proposal.md "缺口一", tasks.md 1.1).
 *
 * `metadata` is a flat `Record<string, string>` parsed straight off the YAML
 * `metadata:` mapping (skills-ref `parser.ts`), so thefoolai's namespaced key
 * is the literal string `"thefool.version"`, not a nested `thefool.version`
 * path — checked as a plain fallback key, in that order.
 */
export function resolveVersion(metadata: Record<string, string>): string | undefined {
  const raw = metadata.version ?? metadata['thefool.version']
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/** Whether `version` is a well-formed semver string (no `v` prefix, no ranges). */
export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version)
}

/**
 * Fallback branch name used only when the current branch of the repo
 * containing the published skill can't be determined (detached HEAD, a repo
 * with no commits yet, or an old `git` without `branch --show-current`).
 *
 * Verified (not guessed) as the real default branch of the registry this
 * CLI actually publishes against — `fushenguang/thefool-skills` — via two
 * independent checks on 2026-08-20:
 *   `git ls-remote --symref https://github.com/fushenguang/thefool-skills.git HEAD`
 *     → `ref: refs/heads/main`
 *   `gh repo view fushenguang/thefool-skills --json defaultBranchRef`
 *     → `{"defaultBranchRef":{"name":"main"}}`
 *
 * Known gap (cli-publish-giturl-scope tasks.md 1.2, flagged rather than
 * silently assumed away): a third-party fork published from a detached-HEAD
 * checkout with a non-`main` default branch would get a wrong-but-safe guess
 * here — this only matters once forks with a different default branch start
 * publishing, which is not the case today.
 */
const DEFAULT_BRANCH_FALLBACK = 'main'

/**
 * Best-effort current branch of the repo containing `dir` (the same repo
 * `resolveGitSource` reads the `origin` remote from) — the server needs this
 * to build a `/tree/<branch>/<path>` URL rather than trusting the client to
 * assemble one itself (cli-publish-giturl-scope design.md "拼装放服务端而
 * 不是客户端").
 *
 * `git branch --show-current` (git ≥2.22) prints the branch name, or an
 * empty string in detached HEAD / no-commits-yet states. Deliberately not
 * `git rev-parse --abbrev-ref HEAD`, which prints the literal string `HEAD`
 * in those same states — an easy footgun to leave unhandled, since `HEAD` is
 * not a valid branch name to hand to the server.
 */
function resolveCurrentBranch(absDir: string): string {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: absDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch || DEFAULT_BRANCH_FALLBACK
  } catch {
    return DEFAULT_BRANCH_FALLBACK
  }
}

/**
 * Resolves the git remote URL + in-repo relative path + current branch for a
 * skill directory. `publish` needs this because a manifest entry that lacks
 * a real, clonable source is not "a real usable manifest entry" (design.md
 * §6-1). `branch` is never written into the manifest (cli-publish-giturl-scope
 * proposal.md Non-Goals: "不改 manifest 格式") — it exists only to be
 * forwarded to `indexToRegistry()`.
 */
function resolveGitSource(dir: string): { source: string; path?: string; branch: string } | { error: string } {
  const absDir = resolve(dir)

  // `git rev-parse --show-toplevel` is only used to confirm we're inside a
  // repo (and for the error message) — the actual relative path comes from
  // `--show-prefix` below, computed by git itself, so it can't disagree with
  // git about where the repo root is (e.g. os.tmpdir() vs its realpath on
  // macOS, where /var/folders is a symlink to /private/var/folders and a
  // manual `path.relative(root, absDir)` would silently produce a bogus
  // `../../..` climb instead of the intended in-repo path).
  try {
    execSync('git rev-parse --show-toplevel', {
      cwd: absDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return { error: `"${absDir}" is not inside a git repository` }
  }

  let remote: string
  try {
    remote = execSync('git remote get-url origin', {
      cwd: absDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return { error: `no git remote "origin" configured for the repository containing "${absDir}"` }
  }

  if (!remote) {
    return { error: `no git remote "origin" configured for the repository containing "${absDir}"` }
  }

  const normalized = normalizeGitRemoteUrl(remote)
  if ('error' in normalized) {
    return { error: normalized.error }
  }

  const prefix = execSync('git rev-parse --show-prefix', {
    cwd: absDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .trim()
    .replace(/\/+$/, '')

  const branch = resolveCurrentBranch(absDir)

  return prefix ? { source: normalized.url, path: prefix, branch } : { source: normalized.url, branch }
}

/**
 * Best-effort normalized `origin` remote URL of `registryDir` itself — used
 * only to detect when a published entry's `source` (the skill's OWN repo,
 * from `resolveGitSource` above) points somewhere other than the
 * `--registry` checkout the entry was just written into.
 *
 * That mismatch is not an error — publishing a skill that lives in a
 * different repo than the registry checkout is a legitimate, intentional
 * shape (design.md never required them to be the same repo) — but it is
 * easy to publish by accident while believing `publish` "collects the skill
 * into the registry repo" (it never does, see `publishSkill` doc comment).
 * A real incident: a skill was published with `--registry` pointing at a
 * public content repo while the skill directory itself lived in an
 * unrelated *private* repo — the manifest entry silently carried that
 * private repo's URL, which nobody can `git clone`.
 *
 * Deliberately silent (never returns an `error`, unlike `resolveGitSource`):
 * a `--registry` checkout that isn't a git repo, has no `origin`, or has an
 * unresolvable remote (e.g. a local path) is not a `publish` failure — it
 * just means this comparison can't be made, so the caller treats "can't
 * tell" as "say nothing" rather than a false positive or false negative.
 */
function resolveRegistryOriginUrl(registryDir: string): string | undefined {
  const absDir = resolve(registryDir)

  let remote: string
  try {
    remote = execSync('git remote get-url origin', {
      cwd: absDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }

  if (!remote) return undefined

  const normalized = normalizeGitRemoteUrl(remote)
  return 'error' in normalized ? undefined : normalized.url
}

function loadManifest(manifestPath: string): SkillManifest {
  if (!existsSync(manifestPath)) {
    return { version: '1', skills: [] }
  }
  const raw = readFileSync(manifestPath, 'utf-8')
  return JSON.parse(raw) as SkillManifest
}

/**
 * Validates then publishes a skill into a local registry checkout.
 *
 * Pure: does not write stdout, does not call `process.exit`. The only side
 * effect is writing the manifest file inside `registryDir` — the actual
 * product of this command (design.md §1). Never commits, pushes, or opens a
 * PR (design.md §4 — hard boundary).
 */
/**
 * Resolve the signed-in identity into an author stamp, or `undefined` when
 * nobody is signed in. Kept separate from `publishSkill` so tests can inject a
 * fake home directory instead of touching the real `~/.cogito`.
 */
export function currentAuthor(env: AuthEnvironment = {}): SkillAuthor | undefined {
  const status = readCredentials(env)
  if (!status.loggedIn) return undefined
  return {
    id: status.credentials.userId,
    ...(status.credentials.displayName ? { name: status.credentials.displayName } : {}),
  }
}

export async function publishSkill(
  dir: string,
  registryDir: string,
  options: {
    author?: SkillAuthor | undefined
    authEnv?: AuthEnvironment
    /** Test/fork seam for `indexToRegistry` — production callers rely on the default. */
    provider?: AuthProvider
    fetchImpl?: FetchLike
  } = {},
): Promise<SkillPublishResult | SkillPublishError> {
  const validation = await validateSkill(dir)
  if (!validation.ok) {
    return {
      ok: false,
      error: 'SKILL_INVALID',
      message: `"${dir}" failed skill validation`,
      errors: validation.errors,
    }
  }

  if (!existsSync(registryDir)) {
    return {
      ok: false,
      error: 'REGISTRY_NOT_FOUND',
      message: `Registry checkout not found: "${registryDir}"`,
    }
  }

  const gitSource = resolveGitSource(dir)
  if ('error' in gitSource) {
    return { ok: false, error: 'SKILL_SOURCE_UNRESOLVED', message: gitSource.error }
  }

  let props
  try {
    props = await readProperties(dir)
  } catch (err) {
    return {
      ok: false,
      error: 'SKILL_PUBLISH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const version = resolveVersion(props.metadata)
  if (version !== undefined && !isValidSemver(version)) {
    return {
      ok: false,
      error: 'SKILL_VERSION_INVALID',
      message: `Invalid version "${version}" in "${dir}": expected semver (major.minor.patch, e.g. "1.2.3", optionally with a "-prerelease" and/or "+build" suffix, e.g. "1.2.3-beta.1" or "1.2.3+build.5") — got "${version}"`,
    }
  }

  const nonSpecFields = extractNonSpecFields(validation.warnings)
  const author = 'author' in options ? options.author : currentAuthor(options.authEnv ?? {})
  // Computed against the same `--registry` checkout `manifestPath` below is
  // about to write into — see `resolveRegistryOriginUrl` doc comment.
  const registrySource = resolveRegistryOriginUrl(registryDir)

  const entry: SkillManifestEntry = {
    id: props.name,
    name: props.name,
    description: props.description,
    source: gitSource.source,
    ...(gitSource.path ? { path: gitSource.path } : {}),
    ...(props.license ? { license: props.license } : {}),
    ...(version ? { version } : {}),
    ...(nonSpecFields.length > 0 ? { nonSpecFields } : {}),
    ...(author ? { author } : {}),
    publishedAt: new Date().toISOString(),
  }

  try {
    const manifestPath = join(registryDir, MANIFEST_FILENAME)
    const manifest = loadManifest(manifestPath)

    const existingIndex = manifest.skills.findIndex((s) => s.id === entry.id)
    const updated = existingIndex !== -1
    if (updated) {
      manifest.skills[existingIndex] = entry
    } else {
      manifest.skills.push(entry)
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

    // Indexing is a strict addendum to the manifest write above (proposal.md
    // "manifest 永远先写，且永远不因索引失败而回滚") — it runs only after
    // that write has already succeeded, and its outcome is folded into the
    // result without ever changing `ok`.
    const indexResult = await indexToRegistry(
      {
        skillId: entry.id,
        gitUrl: entry.source,
        name: entry.name,
        description: entry.description,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.license ? { license: entry.license } : {}),
        // `path` mirrors the manifest entry's own field 1:1 (cli-publish-giturl-scope
        // tasks.md 1.1) — never added to `entry` itself here, it is already
        // there. `branch` is never written into the manifest (Non-Goal: "不改
        // manifest 格式") — it only exists for this one request, computed
        // fresh from the same repo `gitSource.source` came from.
        ...(entry.path ? { path: entry.path } : {}),
        branch: gitSource.branch,
      },
      {
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.authEnv ? { authEnv: options.authEnv } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    )

    return {
      ok: true,
      entry,
      manifestPath,
      updated,
      anonymous: !author,
      versionMissing: !version,
      indexed: indexResult.indexed,
      ...(indexResult.indexed === false && indexResult.reason === 'REQUEST_FAILED'
        ? { indexError: indexResult.message }
        : {}),
      ...(registrySource
        ? { registrySource, sourceRepoDiffersFromRegistry: entry.source !== registrySource }
        : {}),
    }
  } catch (err) {
    return {
      ok: false,
      error: 'SKILL_PUBLISH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
