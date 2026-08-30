import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONFIG_DIR_NAME,
  DEFAULT_PROVIDER,
  buildDeviceAuthUrl,
  clearCredentials,
  consumeDeviceAuth,
  credentialsPath,
  deprecatedEnvNotices,
  pollForSession,
  readCredentials,
  resolveProvider,
  writeCredentials,
  type AuthProvider,
  type ConsumeResult,
  type StoredCredentials,
} from '../auth.js'

const created: string[] = []

function makeHome(label: string): string {
  const dir = join(
    tmpdir(),
    `cogito-auth-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true })
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

const CREDS: StoredCredentials = {
  provider: 'thefoolai',
  userId: '0b317c04-b86d-4652-9625-bf648e6e1257',
  displayName: 'someone@example.com',
  accessToken: 'token-value-that-must-never-be-printed',
  refreshToken: 'refresh-value',
  savedAt: '2026-08-19T00:00:00.000Z',
}

const PROVIDER: AuthProvider = {
  name: 'test',
  webUrl: 'https://web.example',
}

type FetchOutcome = ConsumeResult | 'network-error' | { httpError: number }

/** A fetch stub that replays a fixed sequence of endpoint results, one per poll. */
function fetchSequence(results: FetchOutcome[]) {
  let i = 0
  return async (): Promise<Response> => {
    const next = results[Math.min(i, results.length - 1)]
    i += 1
    if (next === 'network-error') throw new Error('ECONNRESET')
    if (typeof next === 'object' && next !== null && 'httpError' in next) {
      return new Response(JSON.stringify({ error: 'server_error' }), { status: next.httpError })
    }
    return new Response(JSON.stringify(next), { status: 200 })
  }
}

/** Never sleeps for real — poll tests must not spend wall-clock time. */
const noSleep = async (): Promise<void> => {}

describe('resolveProvider', () => {
  it('falls back to the built-in default when nothing is configured', () => {
    const home = makeHome('default')
    const provider = resolveProvider({ homeDir: home, env: {} })
    expect(provider.webUrl).toBe(DEFAULT_PROVIDER.webUrl)
    expect(provider.name).toBe(DEFAULT_PROVIDER.name)
  })

  it('reads a named provider out of ~/.cogito/config.json', () => {
    const home = makeHome('config')
    writeFileSync(
      join(home, CONFIG_DIR_NAME, 'config.json'),
      JSON.stringify({
        auth: {
          defaultProvider: 'selfhosted',
          providers: { selfhosted: { webUrl: 'https://hub.internal' } },
        },
      }),
    )
    const provider = resolveProvider({ homeDir: home, env: {} })
    expect(provider.name).toBe('selfhosted')
    expect(provider.webUrl).toBe('https://hub.internal')
  })

  it('lets env vars win over the config file', () => {
    const home = makeHome('env')
    writeFileSync(
      join(home, CONFIG_DIR_NAME, 'config.json'),
      JSON.stringify({ auth: { providers: { thefoolai: { webUrl: 'https://from-config' } } } }),
    )
    const provider = resolveProvider({
      homeDir: home,
      env: { COGITO_AUTH_WEB_URL: 'https://from-env' },
    })
    expect(provider.webUrl).toBe('https://from-env')
  })

  it('lets an explicit provider name win over the config default', () => {
    const home = makeHome('explicit')
    writeFileSync(
      join(home, CONFIG_DIR_NAME, 'config.json'),
      JSON.stringify({
        auth: {
          defaultProvider: 'a',
          providers: { a: { webUrl: 'https://a' }, b: { webUrl: 'https://b' } },
        },
      }),
    )
    expect(resolveProvider({ homeDir: home, env: {}, providerName: 'b' }).webUrl).toBe('https://b')
  })
})

describe('credential storage', () => {
  it('round-trips credentials and writes the file 0600', () => {
    const home = makeHome('roundtrip')
    const path = writeCredentials(CREDS, { homeDir: home })
    expect(path).toBe(credentialsPath({ homeDir: home }))

    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    const status = readCredentials({ homeDir: home })
    expect(status.loggedIn).toBe(true)
    if (status.loggedIn) expect(status.credentials.userId).toBe(CREDS.userId)
  })

  it('reports NO_CREDENTIALS when the file is absent', () => {
    const home = makeHome('absent')
    expect(readCredentials({ homeDir: home })).toEqual({
      loggedIn: false,
      reason: 'NO_CREDENTIALS',
    })
  })

  // Reverse control: the three ways a credentials file can be useless must all
  // degrade to "not signed in" — never a stack trace at the user (design.md §7).
  it.each([
    ['empty file', ''],
    ['corrupt json', '{not json at all'],
    ['valid json, missing fields', '{"provider":"x"}'],
  ])('reports not-signed-in for %s instead of throwing', (_label, content) => {
    const home = makeHome('corrupt')
    writeFileSync(join(home, CONFIG_DIR_NAME, 'credentials.json'), content)
    const status = readCredentials({ homeDir: home })
    expect(status.loggedIn).toBe(false)
  })

  it('clearCredentials removes the file and is idempotent', () => {
    const home = makeHome('clear')
    writeCredentials(CREDS, { homeDir: home })
    expect(clearCredentials({ homeDir: home })).toBe(true)
    expect(existsSync(credentialsPath({ homeDir: home }))).toBe(false)
    expect(clearCredentials({ homeDir: home })).toBe(false)
  })

  it('never leaves the token behind after logout', () => {
    const home = makeHome('scrub')
    const path = writeCredentials(CREDS, { homeDir: home })
    expect(readFileSync(path, 'utf-8')).toContain(CREDS.accessToken)
    clearCredentials({ homeDir: home })
    expect(existsSync(path)).toBe(false)
  })
})

describe('buildDeviceAuthUrl', () => {
  it('points at the provider web app and carries the device code', () => {
    const url = new URL(buildDeviceAuthUrl(PROVIDER, 'code-123'))
    expect(url.origin).toBe('https://web.example')
    expect(url.pathname).toBe('/device-auth')
    expect(url.searchParams.get('code')).toBe('code-123')
    expect(url.searchParams.get('device_name')).toContain('cogito CLI')
  })

  it('does not emit a double slash when webUrl has a trailing slash', () => {
    const url = buildDeviceAuthUrl({ ...PROVIDER, webUrl: 'https://web.example/' }, 'c')
    expect(url).not.toContain('example//')
  })
})

describe('consumeDeviceAuth', () => {
  // tasks.md 2.1: assert the transport shape, not just that "some fetch happened" —
  // this is the one function the whole endpoint migration lives in.
  it('POSTs {webUrl}/api/device-auth/consume with a { device_code } body and no auth headers', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
    }

    await consumeDeviceAuth(PROVIDER, 'device-code-xyz', fetchImpl)

    expect(capturedUrl).toBe('https://web.example/api/device-auth/consume')
    expect(capturedInit?.method).toBe('POST')
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ device_code: 'device-code-xyz' })
    // Zero-config means zero secrets on the wire — no apikey/Authorization header.
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers.apikey).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
  })

  it('does not emit a double slash when webUrl has a trailing slash', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = async (url: string): Promise<Response> => {
      capturedUrl = url
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
    }
    await consumeDeviceAuth({ ...PROVIDER, webUrl: 'https://web.example/' }, 'c', fetchImpl)
    expect(capturedUrl).not.toContain('example//')
  })

  it('turns a network throw into an { error } result instead of propagating', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('ECONNRESET')
    }
    const result = await consumeDeviceAuth(PROVIDER, 'c', fetchImpl)
    expect('error' in result).toBe(true)
  })

  it('turns a non-2xx HTTP status into an { error } result instead of throwing', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    const result = await consumeDeviceAuth(PROVIDER, 'c', fetchImpl)
    expect('error' in result).toBe(true)
  })
})

describe('deprecatedEnvNotices', () => {
  it('is empty when neither deprecated var is set', () => {
    expect(deprecatedEnvNotices({})).toEqual([])
  })

  it('flags AGENTDOCK_AUTH_ANON_KEY and AGENTDOCK_AUTH_SUPABASE_URL without erroring', () => {
    const notices = deprecatedEnvNotices({
      AGENTDOCK_AUTH_ANON_KEY: 'stale-key',
      AGENTDOCK_AUTH_SUPABASE_URL: 'https://db.example',
    })
    expect(notices).toHaveLength(2)
    expect(notices.join(' ')).toContain('AGENTDOCK_AUTH_ANON_KEY')
    expect(notices.join(' ')).toContain('AGENTDOCK_AUTH_SUPABASE_URL')
    // Never a secret value in the notice text.
    expect(notices.join(' ')).not.toContain('stale-key')
  })
})

describe('pollForSession', () => {
  const approved: ConsumeResult = {
    status: 'approved',
    user_id: CREDS.userId,
    session: { access_token: 'at', refresh_token: 'rt', user: { email: 'a@b.c' } },
  }

  it('returns credentials when the first poll is already approved', async () => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([approved]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.credentials.userId).toBe(CREDS.userId)
      expect(outcome.credentials.displayName).toBe('a@b.c')
    }
  })

  it('keeps polling through pending and transient network errors', async () => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ status: 'pending' }, 'network-error', approved]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
  })

  it('keeps polling through 4xx/5xx endpoint errors and still succeeds once it recovers', async () => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ httpError: 500 }, { httpError: 429 }, approved]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
  })

  it('never throws on sustained 5xx — rides out to the timeout instead of crashing', async () => {
    let clock = 0
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ httpError: 503 }]),
      sleep: async () => {
        clock += 2000
      },
      now: () => clock,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('TIMEOUT')
  })

  it('prefers the server-resolved display_name over the session email', async () => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ ...approved, display_name: 'Ada Lovelace' }]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.credentials.displayName).toBe('Ada Lovelace')
  })

  it('falls back to the session email when the endpoint has no display_name (pre-#201 providers)', async () => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([approved]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.credentials.displayName).toBe('a@b.c')
  })

  it('omits displayName entirely when neither display_name nor session email is present', async () => {
    const bare: ConsumeResult = {
      status: 'approved',
      user_id: CREDS.userId,
      session: { access_token: 'at' },
    }
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([bare]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect('displayName' in outcome.credentials).toBe(false)
  })

  it.each([
    ['denied', 'DENIED'],
    ['expired', 'EXPIRED'],
    ['consumed', 'ALREADY_CONSUMED'],
  ])('stops immediately on %s', async (status, expected) => {
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ status }]),
      sleep: noSleep,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe(expected)
  })

  it('gives up at the five-minute ceiling instead of waiting forever', async () => {
    // Virtual clock: every poll advances time by the poll interval, so the loop
    // hits its ceiling without a single real millisecond passing.
    let clock = 0
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([{ status: 'pending' }]),
      sleep: async () => {
        clock += 2000
      },
      now: () => clock,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('TIMEOUT')
  })

  it('honours an abort signal', async () => {
    const signal = { aborted: true }
    const outcome = await pollForSession({
      provider: PROVIDER,
      deviceCode: 'c',
      fetchImpl: fetchSequence([approved]),
      sleep: noSleep,
      signal,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('CANCELLED')
  })
})
