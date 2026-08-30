import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir, hostname, platform } from 'os'
import { join } from 'path'
import { VERSION } from '../version.js'

/**
 * Browser-delegated login for the CLI (`cc auth`).
 *
 * The flow is deliberately identical to the one TheFoolAI's desktop app already
 * runs, because that path is proven in production (design.md §1):
 *
 *   1. generate a `device_code` (uuid)
 *   2. open the system browser at `{webUrl}/device-auth?code=…`
 *   3. poll `{webUrl}/api/device-auth/consume` until approved
 *
 * ★ The client does NOT create the pending row — the *web page* does, in its own
 * server function. So the only backend interaction this module needs is a single
 * HTTP call. That is why `consumeDeviceAuth()` below is the one and only network
 * touch point (design.md §2.2): the CLI used to call the PostgREST RPC directly
 * with a public anon key, and now calls a provider HTTP endpoint instead — the
 * whole client-side migration was changing the body of that one function.
 * Keep it that way: the next transport change should again touch only this
 * function.
 *
 * The endpoint wraps a SECURITY DEFINER *one-shot* RPC on the server: it returns
 * the session and clears `session_data` in the same statement, so a token can be
 * read at most once, by whoever calls first.
 */

/** A login target. One provider = one hub, one base URL — nothing else. */
export interface AuthProvider {
  name: string
  /**
   * Web app origin. The browser is sent to `{webUrl}/device-auth`, and polling
   * posts to `{webUrl}/api/device-auth/consume`. This is the only address the
   * CLI needs — no key, no PostgREST origin, no RPC name (design.md §2.2).
   */
  webUrl: string
}

export interface StoredCredentials {
  provider: string
  /** Stable id. This — not the display name — is what attribution keys on. */
  userId: string
  /** Redundant human-readable label; may change over time (design.md §4). */
  displayName?: string
  accessToken: string
  refreshToken?: string
  savedAt: string
}

export type AuthStatus =
  | { loggedIn: true; credentials: StoredCredentials }
  | { loggedIn: false; reason: 'NO_CREDENTIALS' | 'CORRUPT_CREDENTIALS' }

/**
 * Built-in default provider.
 *
 * A single public base URL — no key. This is what makes `login` zero-config:
 * there is nothing to set up before the first `cc auth login`.
 *
 * Fork this CLI to point at a self-hosted hub by overriding `webUrl` via
 * `COGITO_AUTH_WEB_URL` or `~/.cogito/config.json` — no code change
 * needed (design.md §2).
 */
export const DEFAULT_PROVIDER: AuthProvider = {
  name: 'thefoolai',
  webUrl: 'https://www.fujia.site',
}

/**
 * Env vars from the pre-endpoint transport (PostgREST + anon key). No longer
 * read for anything — `resolveProvider` ignores them — but still worth telling
 * the user about instead of silently ignoring, so an old shell profile doesn't
 * leave them wondering why the key they set has no effect.
 */
export const DEPRECATED_AUTH_ENV_VARS = ['AGENTDOCK_AUTH_ANON_KEY', 'AGENTDOCK_AUTH_SUPABASE_URL'] as const

/**
 * Returns a human-readable notice for each deprecated env var that is still
 * set, or `[]` when none are. Never throws, never exits — callers just print
 * whatever comes back (tasks.md 1.4: notice, not an error).
 */
export function deprecatedEnvNotices(env: NodeJS.ProcessEnv = process.env): string[] {
  return DEPRECATED_AUTH_ENV_VARS.filter((key) => env[key]).map(
    (key) =>
      `${key} is no longer needed — the CLI now talks to the provider's HTTP endpoint and never sees a key.`,
  )
}

export const CONFIG_DIR_NAME = '.cogito'
export const CREDENTIALS_FILENAME = 'credentials.json'
export const CONFIG_FILENAME = 'config.json'

/** Poll cadence and hard ceiling — mirrors the desktop app, and is never unbounded. */
export const POLL_INTERVAL_MS = 2000
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface AuthEnvironment {
  /** Injected so tests never touch the real `~/.cogito`. */
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

const configDir = (env: AuthEnvironment = {}): string =>
  join(env.homeDir ?? homedir(), CONFIG_DIR_NAME)

export const credentialsPath = (env: AuthEnvironment = {}): string =>
  join(configDir(env), CREDENTIALS_FILENAME)

export const configPath = (env: AuthEnvironment = {}): string =>
  join(configDir(env), CONFIG_FILENAME)

const readJsonFile = <T>(path: string): T | null => {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch {
    // Callers treat null as "absent". A corrupt file must never throw a stack at
    // the user — `status` reports "not logged in" and `login` just overwrites it.
    return null
  }
}

/**
 * Resolve the provider to use. Precedence (high → low), design.md §2:
 * explicit name → env vars → `~/.cogito/config.json` → built-in default.
 *
 * There is only one field to resolve now (`webUrl`) — the provider abstraction
 * shrank from "URL + key + RPC name" to "one URL" when the transport moved
 * behind the provider's own HTTP endpoint (design.md §2.2).
 */
export function resolveProvider(
  options: { providerName?: string } & AuthEnvironment = {},
): AuthProvider {
  const env = options.env ?? process.env
  const config = readJsonFile<{
    auth?: { providers?: Record<string, Partial<AuthProvider>>; defaultProvider?: string }
  }>(configPath(options))

  const name = options.providerName ?? config?.auth?.defaultProvider ?? DEFAULT_PROVIDER.name
  const fromConfig = config?.auth?.providers?.[name] ?? {}

  return {
    name,
    webUrl: env.COGITO_AUTH_WEB_URL || fromConfig.webUrl || DEFAULT_PROVIDER.webUrl,
  }
}

export function readCredentials(env: AuthEnvironment = {}): AuthStatus {
  const path = credentialsPath(env)
  if (!existsSync(path)) return { loggedIn: false, reason: 'NO_CREDENTIALS' }

  const parsed = readJsonFile<StoredCredentials>(path)
  if (!parsed || !parsed.userId || !parsed.accessToken) {
    return { loggedIn: false, reason: 'CORRUPT_CREDENTIALS' }
  }
  return { loggedIn: true, credentials: parsed }
}

export function writeCredentials(
  credentials: StoredCredentials,
  env: AuthEnvironment = {},
): string {
  const dir = configDir(env)
  // 0700/0600: the CLI's threat model assumes anyone who can read your home dir
  // has already won (~/.npmrc, ~/.gitconfig, ssh keys all live there), but there
  // is no reason to be looser than the neighbours.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = credentialsPath(env)
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  })
  return path
}

export function clearCredentials(env: AuthEnvironment = {}): boolean {
  const path = credentialsPath(env)
  if (!existsSync(path)) return false
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 })
  try {
    // Best-effort unlink after truncation, so a failure to remove still leaves
    // nothing readable behind.
    unlinkSync(path)
  } catch {
    /* truncated already — nothing sensitive remains */
  }
  return true
}

export function buildDeviceAuthUrl(provider: AuthProvider, deviceCode: string): string {
  const params = new URLSearchParams({
    code: deviceCode,
    device_name: `${hostname()} (cogito CLI)`,
    os: platform(),
    version: VERSION,
  })
  return `${provider.webUrl.replace(/\/+$/, '')}/device-auth?${params.toString()}`
}

export interface ConsumeResult {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'not_found' | string
  session?: { access_token?: string; refresh_token?: string; user?: { email?: string } } | string
  user_id?: string
  /**
   * Server-resolved human-readable name (nickname → username → email
   * fallback), present only on `approved`. Introduced by thefoolai PR #201
   * — not yet live in production as of this cut, so callers must tolerate its
   * absence and fall back to `session.user?.email`.
   */
  display_name?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The ONE backend touch point (design.md §1 / §2.2). This used to POST straight
 * to PostgREST with a public anon key; it now posts to the provider's own HTTP
 * endpoint, which does that RPC call server-side. The package carries zero
 * secrets either way, but this version doesn't carry a key at all.
 */
export async function consumeDeviceAuth(
  provider: AuthProvider,
  deviceCode: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ConsumeResult | { error: string }> {
  const url = `${provider.webUrl.replace(/\/+$/, '')}/api/device-auth/consume`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
    if (!response.ok) {
      return { error: `HTTP ${response.status}` }
    }
    return (await response.json()) as ConsumeResult
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export type LoginOutcome =
  | { ok: true; credentials: StoredCredentials }
  | {
      ok: false
      error: 'DENIED' | 'EXPIRED' | 'ALREADY_CONSUMED' | 'TIMEOUT' | 'CANCELLED'
      message: string
    }

export interface PollOptions {
  provider: AuthProvider
  deviceCode: string
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: { aborted: boolean }
  onAttempt?: (attempt: number) => void
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until approved, refused, or the 5-minute ceiling.
 *
 * The ceiling is not decoration: an unbounded wait is exactly how a stalled
 * network turns into a CLI that looks hung with no way to tell "slow" from
 * "broken".
 */
export async function pollForSession(options: PollOptions): Promise<LoginOutcome> {
  const {
    provider,
    deviceCode,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    now = Date.now,
    signal,
    onAttempt,
  } = options

  const startedAt = now()
  let attempt = 0

  while (now() - startedAt < LOGIN_TIMEOUT_MS) {
    if (signal?.aborted) return { ok: false, error: 'CANCELLED', message: 'Login cancelled' }
    await sleep(POLL_INTERVAL_MS)
    if (signal?.aborted) return { ok: false, error: 'CANCELLED', message: 'Login cancelled' }

    attempt += 1
    onAttempt?.(attempt)

    const result = await consumeDeviceAuth(provider, deviceCode, fetchImpl)
    if ('error' in result) continue // transient — keep polling until the ceiling

    if (result.status === 'approved' && result.session) {
      const session =
        typeof result.session === 'string' ? safeParse(result.session) : result.session
      if (!session?.access_token || !result.user_id) {
        return {
          ok: false,
          error: 'EXPIRED',
          message: 'Authorization returned an unusable session',
        }
      }
      // Prefer the server-resolved display_name (thefoolai PR #201) over the
      // session's raw email — it exists specifically because the session blob
      // never carried a `user` object (skill-semver-and-author-name, root
      // cause). Fall back to the email for providers that haven't shipped it.
      const displayName = result.display_name || session.user?.email
      return {
        ok: true,
        credentials: {
          provider: provider.name,
          userId: result.user_id,
          accessToken: session.access_token,
          ...(displayName ? { displayName } : {}),
          ...(session.refresh_token ? { refreshToken: session.refresh_token } : {}),
          savedAt: new Date(now()).toISOString(),
        },
      }
    }

    if (result.status === 'denied') {
      return { ok: false, error: 'DENIED', message: 'Authorization was denied in the browser' }
    }
    if (result.status === 'expired') {
      return { ok: false, error: 'EXPIRED', message: 'Authorization request expired' }
    }
    if (result.status === 'consumed') {
      // One-shot RPC: someone already took this token. Polling on would wait out
      // the full five minutes for a guaranteed failure.
      return {
        ok: false,
        error: 'ALREADY_CONSUMED',
        message: 'This authorization was already used — start the login again',
      }
    }
  }

  return { ok: false, error: 'TIMEOUT', message: 'Timed out waiting for browser authorization' }
}

const safeParse = (
  raw: string,
): { access_token?: string; refresh_token?: string; user?: { email?: string } } | null => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function newDeviceCode(): string {
  return randomUUID()
}

/** Opens a URL in the system browser. Failure is non-fatal — we print the URL too. */
export function openBrowser(url: string): void {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
      shell: platform() === 'win32',
    }).unref()
  } catch {
    /* caller prints the URL as a fallback */
  }
}
