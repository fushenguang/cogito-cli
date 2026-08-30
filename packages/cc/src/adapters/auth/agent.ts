import {
  buildDeviceAuthUrl,
  clearCredentials,
  deprecatedEnvNotices,
  newDeviceCode,
  openBrowser,
  pollForSession,
  readCredentials,
  resolveProvider,
  writeCredentials,
} from '../../core/auth.js'

/**
 * Agent-mode adapter: NDJSON on stdout, no prompts, no spinners.
 * Mirrors the skill adapters' contract so agents can parse either the same way.
 */
const emit = (record: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify(record) + '\n')
}

export interface AuthAgentOptions {
  provider?: string
  json?: boolean
  silent?: boolean
}

export async function runAuthLoginAgentAdapter(opts: AuthAgentOptions = {}): Promise<void> {
  const provider = resolveProvider(opts.provider ? { providerName: opts.provider } : {})

  if (!opts.silent) {
    for (const notice of deprecatedEnvNotices()) emit({ event: 'notice', message: notice })
  }

  const deviceCode = newDeviceCode()
  const url = buildDeviceAuthUrl(provider, deviceCode)
  if (!opts.silent) emit({ event: 'authorize', url })
  openBrowser(url)

  const outcome = await pollForSession({ provider, deviceCode })
  if (!outcome.ok) {
    if (!opts.silent) emit({ event: 'error', error: outcome.error, message: outcome.message })
    process.exit(1)
  }

  writeCredentials(outcome.credentials)
  if (!opts.silent) {
    emit({
      event: 'signed-in',
      provider: provider.name,
      userId: outcome.credentials.userId,
      displayName: outcome.credentials.displayName ?? null,
    })
  }
}

export async function runAuthLogoutAgentAdapter(opts: AuthAgentOptions = {}): Promise<void> {
  const had = clearCredentials()
  if (!opts.silent) emit({ event: 'signed-out', hadCredentials: had })
}

export async function runAuthStatusAgentAdapter(opts: AuthAgentOptions = {}): Promise<void> {
  const status = readCredentials()
  if (!status.loggedIn) {
    if (!opts.silent) emit({ event: 'status', signedIn: false, reason: status.reason })
    process.exit(1)
  }
  if (!opts.silent) {
    // Identity only — never the token (design.md §7).
    emit({
      event: 'status',
      signedIn: true,
      provider: status.credentials.provider,
      userId: status.credentials.userId,
      displayName: status.credentials.displayName ?? null,
      savedAt: status.credentials.savedAt,
    })
  }
}
