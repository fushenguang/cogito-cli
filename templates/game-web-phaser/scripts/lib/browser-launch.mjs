// Chromium process launcher — extracted out of verify.mjs (ia-assertion-runner
// wave 3/4) so scripts/assert.mjs's standalone CLI entry (design D7: "assert.mjs
// 仍然可以单独 node scripts/assert.mjs 跑，那条路径自己起浏览器") can reuse the
// exact same launch sequence instead of a second hand-copied one. Behaviour is
// unchanged from the original inline version in verify.mjs — this is a move, not
// a rewrite.

import { spawn } from 'node:child_process'

const DEVTOOLS_LISTEN_TIMEOUT_MS = 10_000

/**
 * Launch the resolved browser headless, and resolve once it prints its
 * DevTools WebSocket endpoint to stderr (design D3 in game-template-verification:
 * "从 stderr 抓 ws 地址").
 *
 * @param {{ path: string, isHeadlessShell: boolean }} browser
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, wsUrl: string }>}
 */
export function launchBrowser(browser) {
  const args = [
    '--no-sandbox', // the guest runs as root; the sandbox can't start
    // The guest image has no /dev/shm — Chromium FATALs on startup without
    // this flag. Filed as fushenguang/tarit#34; once that's fixed this flag
    // can be dropped, but it's harmless to keep either way.
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
  ]
  // chrome-headless-shell is inherently headless and doesn't understand
  // --headless; a full chrome/chromium binary needs it explicitly.
  if (!browser.isHeadlessShell) {
    args.unshift('--headless=new')
  }

  const proc = spawn(browser.path, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  return new Promise((resolve, reject) => {
    let stderrBuf = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(
        new Error(
          `Timed out waiting for Chromium to print its DevTools listening address ` +
            `(${DEVTOOLS_LISTEN_TIMEOUT_MS}ms). stderr so far:\n${stderrBuf}`,
        ),
      )
    }, DEVTOOLS_LISTEN_TIMEOUT_MS)

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString()
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(timeout)
        resolve({ proc, wsUrl: match[1] })
      }
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Failed to launch Chromium at ${browser.path}: ${err.message}`))
    })

    proc.on('exit', (code) => {
      if (settled) return
      if (code !== null && code !== 0) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Chromium exited early (code ${code}). stderr:\n${stderrBuf}`))
      }
    })
  })
}
