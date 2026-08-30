// Browser resolution chain — design D1.
//
// Zero-dep (Gate ②): we never install a browser ourselves, we find one that
// already exists in the environment. The order below is deliberate — see
// openspec/changes/game-template-verification/design.md § D1 in the
// AgentDock platform repo for the full rationale. Summary:
//
//   1. process.env.CHROME_PATH               — explicit escape hatch for a human/CI
//   2. process.env.PLAYWRIGHT_BROWSERS_PATH   — respects a non-default Playwright install
//   3. $HOME/.cache/ms-playwright             — Playwright's normal default location
//   4. /.cache/ms-playwright                  — the guest-specific case: Shelley runs as
//                                                root with HOME=/, so Playwright installed
//                                                browsers under the filesystem root instead
//                                                of a real home directory.
//   5. PATH (google-chrome / chromium / chromium-browser)
//
// If none of these resolve to a real binary, this prints every path it
// looked at and exits non-zero. It MUST NOT print "skipping" and exit 0 —
// a check that can be silently skipped is not a check.

import { existsSync, readdirSync, statSync, accessSync, constants } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'

// Prefer chrome-headless-shell first: it's the dedicated headless binary
// (lighter, no --headless flag needed). Fall back to a full chrome/chromium
// binary run with --headless=new.
const EXECUTABLE_NAMES = ['chrome-headless-shell', 'chrome', 'chromium', 'headless_shell']
const PATH_CANDIDATE_NAMES = ['google-chrome', 'chromium', 'chromium-browser']

/**
 * Recursively look for one of EXECUTABLE_NAMES under `dir`, up to `depth`
 * levels deep. Playwright's install layout is
 * `<root>/<browser>-<buildId>/<platform-dir>/<executable>` — two levels
 * below the scan root — so depth=3 gives headroom without scanning the
 * whole disk.
 */
function findExecutableRecursive(dir, depth) {
  if (depth < 0) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (entry.isFile() && EXECUTABLE_NAMES.includes(entry.name)) {
      const full = join(dir, entry.name)
      try {
        accessSync(full, constants.X_OK)
        return full
      } catch {
        // exists but not executable — keep looking
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findExecutableRecursive(join(dir, entry.name), depth - 1)
      if (found) return found
    }
  }

  return null
}

/** Scan a Playwright browsers root (e.g. ~/.cache/ms-playwright), headless-shell dirs first. */
function scanPlaywrightRoot(root) {
  if (!existsSync(root)) return null
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }

  const sorted = [...entries].sort((a, b) => {
    const aShell = a.includes('headless_shell') ? 0 : 1
    const bShell = b.includes('headless_shell') ? 0 : 1
    return aShell - bShell
  })

  for (const entry of sorted) {
    const entryPath = join(root, entry)
    let stat
    try {
      stat = statSync(entryPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const found = findExecutableRecursive(entryPath, 2)
    if (found) return found
  }

  return null
}

function findOnPath(names) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here — keep looking
      }
    }
  }
  return null
}

function finalize(path, source) {
  return { path, source, isHeadlessShell: /headless[-_]shell/i.test(path) }
}

/**
 * Resolve a browser binary per the D1 chain. On success returns
 * `{ path, source, isHeadlessShell }`. On failure, prints every path it
 * looked at and calls `process.exit(1)` — it never returns in the failure
 * case, so callers don't need an else-branch to stay honest about the gate.
 */
export function resolveBrowser() {
  const attempts = []

  if (process.env.CHROME_PATH) {
    attempts.push(`$CHROME_PATH = ${process.env.CHROME_PATH}`)
    if (existsSync(process.env.CHROME_PATH)) {
      return finalize(process.env.CHROME_PATH, 'CHROME_PATH env var')
    }
  } else {
    attempts.push('$CHROME_PATH (not set)')
  }

  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    attempts.push(`$PLAYWRIGHT_BROWSERS_PATH = ${process.env.PLAYWRIGHT_BROWSERS_PATH}`)
    const found = scanPlaywrightRoot(process.env.PLAYWRIGHT_BROWSERS_PATH)
    if (found) return finalize(found, 'PLAYWRIGHT_BROWSERS_PATH env var')
  } else {
    attempts.push('$PLAYWRIGHT_BROWSERS_PATH (not set)')
  }

  const homeCache = join(homedir(), '.cache', 'ms-playwright')
  attempts.push(homeCache)
  const foundHome = scanPlaywrightRoot(homeCache)
  if (foundHome) return finalize(foundHome, '$HOME/.cache/ms-playwright')

  const rootCache = '/.cache/ms-playwright'
  if (rootCache !== homeCache) {
    attempts.push(`${rootCache}  (guest case: root-run process with HOME=/)`)
    const foundRoot = scanPlaywrightRoot(rootCache)
    if (foundRoot) return finalize(foundRoot, '/.cache/ms-playwright')
  }

  attempts.push(`PATH entries for: ${PATH_CANDIDATE_NAMES.join(', ')}`)
  const foundPath = findOnPath(PATH_CANDIDATE_NAMES)
  if (foundPath) return finalize(foundPath, 'PATH')

  console.error('[verify] Could not find a Chromium/Chrome binary. Looked at:')
  for (const attempt of attempts) {
    console.error(`  - ${attempt}`)
  }
  console.error(
    '[verify] Set CHROME_PATH to an explicit binary path, or install a Playwright chromium ' +
      '(`npx playwright install chromium` / `chromium-headless-shell`).',
  )
  process.exit(1)
}
