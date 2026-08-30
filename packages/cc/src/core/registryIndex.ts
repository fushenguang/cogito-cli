import { readCredentials, resolveProvider } from './auth.js'
import type { AuthEnvironment, AuthProvider, FetchLike } from './auth.js'

/**
 * Indexes a freshly-published manifest entry into the provider's hosted
 * registry — the second (optional) step of `skill publish`, per
 * `cli-publish-to-registry` proposal.md "What Changes":
 *
 *   ① write the git manifest (core/skillPublish.ts — the source of truth,
 *      never rolled back)
 *   ② POST {webUrl}/api/skills/publish + Bearer <token> (this module)
 *
 * This reuses the zero-key transport shape `cli-auth-via-endpoint` built for
 * `consumeDeviceAuth()` (auth.ts design.md §2.2): the CLI never holds an API
 * key, only the access token a logged-in user already has on disk. Kept as
 * its own module rather than folded into auth.ts because it is not part of
 * the login flow — it is the *one* other backend touch point the CLI has,
 * and giving it its own file keeps that boundary visible instead of letting
 * auth.ts grow a second, unrelated responsibility.
 *
 * Hard behavioral rules (proposal.md 反向对照 ①②, and this cut's brief):
 *   - never called when nobody is signed in
 *   - never retried — this is a one-shot best-effort call, not `pollForSession`
 *   - always time-bounded — a slow/hanging endpoint must not hang `publish`
 *   - never throws — every failure mode resolves to `{ indexed: false, ... }`
 *     so the caller (skillPublish.ts) can write the manifest unconditionally
 *     and treat indexing purely as an addendum to the result
 */

/** Manifest fields the endpoint accepts. Deliberately NOT `access_tier` /
 * `is_official` / any scan/security status — those are server-assigned
 * (proposal.md "核心安全问题": a client-supplied "scan passed" is exactly the
 * bypass the server-side design is meant to close).
 *
 * `path` / `branch` added by cli-publish-giturl-scope: `gitUrl` alone is
 * repo-grained, not skill-grained (that mismatch is the P0 this cut fixes —
 * see its proposal.md "Why"). The server assembles the actual
 * `/tree/<branch>/<path>` URL itself (design.md "拼装放服务端"); the CLI's
 * only job is to forward the raw ingredients it already has. `path` mirrors
 * the manifest entry's own optional `path` field 1:1 — omitted under the
 * same "omit when empty" convention as `version` / `license` when the
 * published skill sits at the repo root. `branch` is always sent: it always
 * resolves to *something* (a real branch name, or the documented fallback in
 * `skillPublish.ts`'s `resolveCurrentBranch`), so unlike `path` there is no
 * "empty" case to omit. */
export interface RegistryIndexEntry {
  skillId: string
  gitUrl: string
  name: string
  description: string
  version?: string
  license?: string
  path?: string
  branch: string
}

export type RegistryIndexResult =
  | { indexed: true }
  | { indexed: false; reason: 'ANONYMOUS' }
  | { indexed: false; reason: 'REQUEST_FAILED'; message: string }

/**
 * Best-effort extraction of a server-supplied `message` from a non-2xx JSON
 * error body, falling back to the bare `HTTP <status>` when the body isn't
 * JSON, has no `message` string, or can't be read at all.
 *
 * This is the fix for cli-publish-giturl-scope tasks.md 1.3: before this
 * change, every non-2xx response collapsed to `HTTP ${status}` regardless of
 * what the server actually said — including a "your CLI is too old, upgrade
 * to X" message the server goes out of its way to send (design.md 方案 A).
 * Discarding that body and showing a bare status code is exactly the
 * non-actionable failure mode the adapters must not reproduce.
 */
async function extractErrorMessage(response: Response, status: number): Promise<string> {
  const fallback = `HTTP ${status}`
  try {
    const text = await response.text()
    if (!text) return fallback
    const parsed: unknown = JSON.parse(text)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof (parsed as { message: unknown }).message === 'string' &&
      (parsed as { message: string }).message.trim()
    ) {
      return (parsed as { message: string }).message
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Formats an `indexError` into a message a human (or an agent reading NDJSON
 * output) can act on, for use by both `adapters/skill/human.ts` and
 * `adapters/skill/agent.ts` (tasks.md 1.3 — both adapters must give an
 * actionable hint, not echo an HTTP status code).
 *
 * When the server already sent a real `message` (see `extractErrorMessage`
 * above), that message IS the actionable text — design.md 方案 A puts the
 * burden of saying "upgrade to >=X" on the server, so this function passes
 * it through unchanged. Only the bare `HTTP <status>` fallback (server gave
 * no usable message — old deployment, a proxy stripped the body, a genuine
 * network-level failure) gets an extra CLI-side hint appended, since a raw
 * status code alone is never actionable.
 */
export function describeIndexFailure(indexError: string | undefined): string {
  if (!indexError) return 'unknown error'
  if (/^HTTP \d+$/.test(indexError)) {
    return `${indexError} — this may mean your cogito CLI is out of date; try: npm install -g @cogito.ai/cc@latest`
  }
  return indexError
}

/** One-shot call, not a poll loop — 15s is generous for a JSON POST but still
 * a hard ceiling, per this cut's brief ("给这次请求设一个明确的超时"). */
export const REGISTRY_INDEX_TIMEOUT_MS = 15_000

export interface IndexToRegistryOptions {
  provider?: AuthProvider
  authEnv?: AuthEnvironment
  fetchImpl?: FetchLike
  /** Test seam only — production callers should rely on the default. */
  timeoutMs?: number
}

export async function indexToRegistry(
  entry: RegistryIndexEntry,
  options: IndexToRegistryOptions = {},
): Promise<RegistryIndexResult> {
  const authEnv = options.authEnv ?? {}
  const status = readCredentials(authEnv)
  if (!status.loggedIn) {
    // No request at all — an anonymous publish must not even attempt to
    // reach the endpoint (this cut's brief, reverse-check ①).
    return { indexed: false, reason: 'ANONYMOUS' }
  }

  const provider = options.provider ?? resolveProvider(authEnv)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REGISTRY_INDEX_TIMEOUT_MS
  const url = `${provider.webUrl.replace(/\/+$/, '')}/api/skills/publish`

  const body: Record<string, string> = {
    skill_id: entry.skillId,
    git_url: entry.gitUrl,
    name: entry.name,
    description: entry.description,
    branch: entry.branch,
  }
  if (entry.version) body.version = entry.version
  if (entry.license) body.license = entry.license
  if (entry.path) body.path = entry.path

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.credentials.accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const message = await extractErrorMessage(response, response.status)
      return { indexed: false, reason: 'REQUEST_FAILED', message }
    }
    return { indexed: true }
  } catch (err) {
    // Covers network errors AND the abort-on-timeout case above — both are
    // "the request failed", never a reason to retry or to hang `publish`.
    const message = err instanceof Error ? err.message : String(err)
    return { indexed: false, reason: 'REQUEST_FAILED', message }
  }
}
