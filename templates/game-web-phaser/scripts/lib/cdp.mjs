// Minimal CDP (Chrome DevTools Protocol) client over Node's built-in
// `WebSocket` global (stable since Node 22 — see the engines bump in
// package.json and the self-check at the top of verify.mjs). Zero deps on
// purpose (Gate ②): no puppeteer-core, no `ws` package.
//
// This only implements the request/response + event-dispatch plumbing that
// verify.mjs actually needs. It is not a general CDP library.

/**
 * @param {string} wsUrl DevTools WebSocket endpoint (browser-level or a
 *   flattened session endpoint — both speak the same JSON-RPC-ish protocol).
 */
export function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
  const pending = new Map()
  /** @type {Map<string, Set<(params: unknown, sessionId: string | undefined) => void>>} */
  const eventHandlers = new Map()

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(undefined))
    ws.addEventListener('error', (event) => {
      reject(new Error(`CDP WebSocket error: ${event.message ?? String(event)}`))
    })
  })

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString()
    let msg
    try {
      msg = JSON.parse(raw)
    } catch (err) {
      console.error('[verify] Received a non-JSON CDP message, ignoring:', raw.slice(0, 200))
      return
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) {
        entry.reject(
          new Error(
            `CDP error for id ${msg.id} (${msg.method ?? 'unknown method'}): ${JSON.stringify(msg.error)}`,
          ),
        )
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    if (msg.method) {
      const handlers = eventHandlers.get(msg.method)
      if (handlers) {
        for (const handler of handlers) handler(msg.params, msg.sessionId)
      }
    }
  })

  /**
   * Send a CDP command and resolve with its `result` once the matching
   * response arrives. Pass `sessionId` for session-scoped domains
   * (Runtime/Page/Log/Network, ...) once a target has been attached with
   * `flatten: true`.
   */
  function send(method, params = {}, sessionId) {
    const id = nextId++
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(payload))
    })
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  function on(method, handler) {
    if (!eventHandlers.has(method)) eventHandlers.set(method, new Set())
    eventHandlers.get(method).add(handler)
    return () => eventHandlers.get(method)?.delete(handler)
  }

  function close() {
    try {
      ws.close()
    } catch {
      // already closed — fine
    }
  }

  return { ready, send, on, close }
}
