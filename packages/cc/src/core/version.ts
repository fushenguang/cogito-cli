/**
 * Version compatibility check.
 * Uses simple semver comparison (major.minor.patch) without external deps.
 */

export interface VersionOutdatedError {
  ok: false
  error: 'CLI_VERSION_OUTDATED'
  context: {
    cli_version: string
    min_required: string
    template: string
  }
  suggested_action: string
}

function parseSemver(version: string): [number, number, number] {
  const parts = version
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/**
 * Returns true if cliVersion satisfies minCliVersion (cliVersion >= minCliVersion).
 */
export function isVersionCompatible(cliVersion: string, minCliVersion: string): boolean {
  const [cMaj, cMin, cPatch] = parseSemver(cliVersion)
  const [mMaj, mMin, mPatch] = parseSemver(minCliVersion)

  if (cMaj !== mMaj) return cMaj > mMaj
  if (cMin !== mMin) return cMin > mMin
  return cPatch >= mPatch
}

/**
 * Throws a structured error object if the CLI version is outdated.
 */
export function checkVersion(cliVersion: string, minCliVersion: string, templateId: string): void {
  if (!isVersionCompatible(cliVersion, minCliVersion)) {
    const err: VersionOutdatedError = {
      ok: false,
      error: 'CLI_VERSION_OUTDATED',
      context: {
        cli_version: cliVersion,
        min_required: minCliVersion,
        template: templateId,
      },
      suggested_action: 'npm install -g @cogito.ai/cc@latest',
    }
    throw err
  }
}
