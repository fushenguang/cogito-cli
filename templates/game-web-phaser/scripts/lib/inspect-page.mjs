// Navigate a fresh CDP target to `pageUrl` and collect BH-1/BH-2 evidence —
// extracted out of verify.mjs's former `runCdpChecks` (ia-assertion-runner
// wave 3/4). Behaviour is unchanged from the original; the only real
// difference is that this version does NOT close the CDP client before
// returning.
//
// 🔴 That's not an oversight — it's design D7. `scripts/verify.mjs` needs the
// exact same session (same target, same load) to keep running IA assertions
// right after BH-2 without a second page load. `scripts/assert.mjs`'s
// standalone CLI entry is the only other caller, and it closes the client
// itself once it's done. Whoever calls `inspectPage()` owns the client and is
// responsible for closing it — this module never does that on your behalf.

import { createCdpClient } from './cdp.mjs'

const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 15_000
// Grace period after `Page.loadEventFired` before evidence is read — Phaser
// boots across Boot -> Preload -> Game scenes and generates its placeholder
// textures on the way; this gives that a moment to settle so BH-1 can also
// catch an exception thrown just after load, not only during it.
const DEFAULT_SETTLE_MS = 1000

/**
 * @param {string} browserWsUrl DevTools WebSocket endpoint for the whole browser.
 * @param {string} pageUrl URL to navigate the new target to.
 * @param {{ pageLoadTimeoutMs?: number, settleMs?: number }} [opts]
 * @returns {Promise<{
 *   client: ReturnType<typeof createCdpClient>,
 *   sessionId: string,
 *   exceptions: string[],
 *   failedRequests: { requestId: string, errorText: string, type: string }[],
 *   canvasWidth: number,
 *   canvasHeight: number,
 *   screenshotBase64: string,
 * }>}
 */
export async function inspectPage(browserWsUrl, pageUrl, opts = {}) {
  const pageLoadTimeoutMs = opts.pageLoadTimeoutMs ?? DEFAULT_PAGE_LOAD_TIMEOUT_MS
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS

  const client = createCdpClient(browserWsUrl)
  await client.ready

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })

  const exceptions = []
  const failedRequests = []

  client.on('Runtime.exceptionThrown', (params, sid) => {
    if (sid !== sessionId) return
    exceptions.push(params)
  })
  client.on('Network.loadingFailed', (params, sid) => {
    if (sid !== sessionId) return
    failedRequests.push(params)
  })

  // 🔴 These MUST be enabled before Page.navigate — an exception thrown
  // during the page's earliest script evaluation is otherwise missed
  // entirely, which silently turns BH-1 into "verified something, just not
  // the thing it claims to verify".
  await client.send('Runtime.enable', {}, sessionId)
  await client.send('Log.enable', {}, sessionId)
  await client.send('Network.enable', {}, sessionId)
  await client.send('Page.enable', {}, sessionId)

  const loadEventFired = new Promise((resolve) => {
    const unsubscribe = client.on('Page.loadEventFired', (params, sid) => {
      if (sid !== sessionId) return
      unsubscribe()
      resolve(undefined)
    })
  })

  await client.send('Page.navigate', { url: pageUrl }, sessionId)

  await Promise.race([
    loadEventFired,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for Page.loadEventFired (${pageLoadTimeoutMs}ms)`)),
        pageLoadTimeoutMs,
      ),
    ),
  ])

  await new Promise((resolve) => setTimeout(resolve, settleMs))

  const canvasEval = await client.send(
    'Runtime.evaluate',
    {
      expression:
        "(() => { const c = document.querySelector('canvas'); return c ? { w: c.clientWidth, h: c.clientHeight } : { w: 0, h: 0 } })()",
      returnByValue: true,
    },
    sessionId,
  )
  const canvasWidth = canvasEval.result?.value?.w ?? 0
  const canvasHeight = canvasEval.result?.value?.h ?? 0

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId)

  return {
    client,
    sessionId,
    exceptions: exceptions.map((e) => e.exception?.description ?? e.text ?? JSON.stringify(e)),
    failedRequests: failedRequests.map((f) => ({
      requestId: f.requestId,
      errorText: f.errorText,
      type: f.type,
    })),
    canvasWidth,
    canvasHeight,
    screenshotBase64: screenshot.data,
  }
}
