/**
 * Normalizes a `git remote get-url origin` output into an anonymous,
 * credential-free HTTPS (or, when the source scheme was `http://`, HTTP) URL
 * suitable for writing into a manifest that a stranger with no credentials
 * must be able to `git clone` (design.md §1 — the rule table is the single
 * source of truth for every branch below).
 *
 * Pure: no filesystem, no subprocess, no network. Zero external
 * dependencies — only string handling and the built-in `URL` (which cannot
 * parse the SCP-like `git@host:owner/repo.git` form, hence the handwritten
 * branch for it).
 */
export function normalizeGitRemoteUrl(remote: string): { url: string } | { error: string } {
  const trimmed = remote.trim()

  if (!trimmed) {
    return { error: unresolvable(remote) }
  }

  // Local paths / `file://` — a stranger can never clone these (design.md §1 row 9).
  if (isLocalPath(trimmed)) {
    return { error: unresolvable(remote) }
  }

  // SCP-like SSH form: `[user@]host:owner/repo[.git]` (design.md §1 rows 1-2).
  // Must be checked before attempting a `URL` parse — `URL` cannot parse this
  // form, and a bare `scheme://` prefix check is what disambiguates it from
  // an actual URL.
  if (!hasUrlScheme(trimmed)) {
    return normalizeScpLike(trimmed, remote)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { error: unresolvable(remote) }
  }

  switch (parsed.protocol) {
    case 'ssh:':
    case 'git+ssh:':
      return normalizeSshLikeUrl(parsed, remote)
    case 'git:':
      return normalizeToHttps(parsed, remote)
    case 'https:':
      return normalizeHttpFamily(parsed, remote, 'https:')
    case 'http:':
      return normalizeHttpFamily(parsed, remote, 'http:')
    case 'file:':
      return { error: unresolvable(remote) }
    default:
      return { error: unresolvable(remote) }
  }
}

function hasUrlScheme(value: string): boolean {
  // A leading `scheme://` (or `scheme:` for `file:` edge cases) — matched
  // loosely enough to hand off to `URL`, which will reject anything bogus.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)
}

function isLocalPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return true
  }
  if (value.startsWith('~')) {
    return true
  }
  // Windows-style absolute path (`C:\...` or `C:/...`) — not a real-world
  // case for this repo's CI, but not a URL either.
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return true
  }
  return false
}

/** `host:owner/repo[.git]`, optionally prefixed with `user@`. */
function normalizeScpLike(value: string, original: string): { url: string } | { error: string } {
  const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
  if (!match) {
    return { error: unresolvable(original) }
  }
  const host = match[1]
  const path = match[2]
  if (!host || !path) {
    return { error: unresolvable(original) }
  }
  if (!hostLooksReal(host)) {
    return { error: unresolvable(original) }
  }
  const cleanPath = stripGitSuffixAndSlashes(path)
  if (!cleanPath) {
    return { error: unresolvable(original) }
  }
  return { url: `https://${host}/${cleanPath}` }
}

/** `ssh://` / `git+ssh://` — drop userinfo and port (design.md §1 rows 3, 5). */
function normalizeSshLikeUrl(parsed: URL, original: string): { url: string } | { error: string } {
  if (!hostLooksReal(parsed.hostname)) {
    return { error: unresolvable(original) }
  }
  const cleanPath = stripGitSuffixAndSlashes(parsed.pathname)
  if (!cleanPath) {
    return { error: unresolvable(original) }
  }
  return { url: `https://${parsed.hostname}/${cleanPath}` }
}

/** `git://` — anonymous but plaintext; unify onto `https://` (design.md §1 row 4). */
function normalizeToHttps(parsed: URL, original: string): { url: string } | { error: string } {
  if (!hostLooksReal(parsed.hostname)) {
    return { error: unresolvable(original) }
  }
  const cleanPath = stripGitSuffixAndSlashes(parsed.pathname)
  if (!cleanPath) {
    return { error: unresolvable(original) }
  }
  return { url: `https://${parsed.hostname}/${cleanPath}` }
}

/**
 * `https://` / `http://` — keep the original scheme (design.md §1 row 8
 * explains why `http://` must not be upgraded to `https://`), drop userinfo
 * (row 7 — credentials must never reach the product), strip `.git` and
 * trailing slashes.
 */
function normalizeHttpFamily(
  parsed: URL,
  original: string,
  scheme: 'https:' | 'http:',
): { url: string } | { error: string } {
  if (!hostLooksReal(parsed.hostname)) {
    return { error: unresolvable(original) }
  }
  const cleanPath = stripGitSuffixAndSlashes(parsed.pathname)
  if (!cleanPath) {
    return { error: unresolvable(original) }
  }
  const prefix = scheme === 'https:' ? 'https://' : 'http://'
  const hostAndPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  return { url: `${prefix}${hostAndPort}/${cleanPath}` }
}

/**
 * Real DNS hostnames almost always contain a dot; `~/.ssh/config` Host
 * aliases almost never do. Without a network lookup there is no way to tell
 * them apart, so a dotless host is treated as an unresolvable alias rather
 * than guessed at (design.md §1 row 10 and the rationale below it).
 */
function hostLooksReal(host: string): boolean {
  return host.includes('.')
}

function stripGitSuffixAndSlashes(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

function unresolvable(original: string): string {
  return (
    `cannot resolve a clonable, credential-free source from git remote "${original}". ` +
    `Fix: git remote set-url origin https://<host>/<owner>/<repo>`
  )
}
