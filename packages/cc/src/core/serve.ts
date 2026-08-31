// serve.ts — artifact preview lifecycle, the #137 fix as a command.
//
// Real incident (platform cogito-lib #137, 2026-08-30): an executor's
// self-check left a `vite preview` bound to 127.0.0.1:8080; the platform's
// own `pnpm preview` then died on EADDRINUSE; its port scan only grepped
// `:8080`, recorded `listening: true`, and the share URL said
// {"error":"share unavailable"} for an hour. Two rules here are the cure:
//
//   1. RECLAIM BEFORE SERVE — anything already on the port is killed by
//      exact PID (read from `ss -ltnp`, never matched by name), TERM then
//      KILL. If the PID column is missing we fail loudly instead of
//      killing by guesswork.
//   2. VERIFY THE BIND ADDRESS — "something listens on :8080" is not
//      reachability. The listener must bind `*`/`0.0.0.0`/`[::]`. A
//      loopback bind is a red result even though the port answers.
//
// Kept dependency-free and split pure/impure so the bind-kind judgment —
// the line of defense the incident was actually about — is unit-tested
// without a Linux host. `ss`/`setsid` exist in the guest VMs this runs in;
// on macOS dev boxes `ss` is absent and we say so instead of degrading.

import { spawn, spawnSync } from 'node:child_process'

export type BindKind = 'any' | 'loopback' | 'specific'

export interface ListenProbe {
  listening: boolean
  bindKind: BindKind | null
  bindAddress: string | null
  pids: number[]
}

/**
 * Parse `ss -ltnp` output for one port. Pure.
 *
 * Lines look like (whitespace-separated):
 *   LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=1234,fd=20))
 *   LISTEN 0 511 *:8080 *:*
 *   LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*
 *   LISTEN 0 511 [::]:8080 [::]:*
 *
 * The bind-kind classification is the entire point (see header): `*`,
 * `0.0.0.0` and `[::]` are externally reachable; `127.0.0.1` is the
 * loopback trap; anything else (a specific NIC address) is reported as
 * `specific` so callers can decide.
 */
export function parseSsListen(ssStdout: string, port: number): ListenProbe {
  const probe: ListenProbe = { listening: false, bindKind: null, bindAddress: null, pids: [] }
  for (const rawLine of ssStdout.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('LISTEN') && !line.startsWith('State')) continue
    const cols = line.split(/\s+/)
    // ss columns: State Recv-Q Send-Q LocalAddr:Port PeerAddr:Port [Process]
    const local = cols[3] ?? ''
    if (!local.endsWith(`:${port}`)) continue
    probe.listening = true
    const addr = local.slice(0, local.length - `:${port}`.length)
    probe.bindAddress = addr
    probe.bindKind =
      addr === '*' || addr === '0.0.0.0' || addr === '[::]' ? 'any' : addr === '127.0.0.1' || addr === '::1' || addr === '[::1]' ? 'loopback' : 'specific'
    const users = line.match(/pid=(\d+)/g) ?? []
    for (const m of users) {
      const pid = Number(m.slice('pid='.length))
      if (Number.isInteger(pid)) probe.pids.push(pid)
    }
  }
  return probe
}

/** Kill PIDs exactly (TERM, short grace, KILL). Never by name. */
export function killExactPids(pids: number[], graceMs = 1500): void {
  const uniq = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 1)
  for (const pid of uniq) process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  const survivors = () => uniq.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  while (survivors().length > 0 && Date.now() < deadline) {
    spawnSync('sleep', ['0.1'])
  }
  for (const pid of survivors()) process.kill(pid, 'SIGKILL')
}

export interface ServeStartResult {
  ok: boolean
  pid: number | null
  bindAddress: string | null
  url: string
  logFile: string
  reclaimedPids: number[]
  error?: string
}

export interface ServeStartOptions {
  dir: string
  port?: number | undefined
  logFile?: string | undefined
  pollTimeoutMs?: number
}

function ssProbe(port: number): ListenProbe {
  const r = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 10_000 })
  if (r.error || r.status !== 0) {
    throw new Error(`\`ss -ltnp\` unavailable (exit ${r.status}) — cc serve runs inside guest VMs; on this host: ${r.error?.message ?? 'n/a'}`)
  }
  return parseSsListen(r.stdout, port)
}

/**
 * `cc serve start`: reclaim the port by exact PID, spawn `pnpm preview`
 * detached (setsid + own log), then poll until the port is bound to ANY
 * address — the loopback bind is a FAILURE, not a pass.
 */
export async function serveStart(opts: ServeStartOptions): Promise<ServeStartResult> {
  const port = opts.port ?? 8080
  const logFile = opts.logFile ?? '/tmp/cc-serve-preview.log'
  const url = `http://127.0.0.1:${port}/`
  const reclaimedPids: number[] = []

  const before = ssProbe(port)
  if (before.listening) {
    if (before.pids.length === 0) {
      return { ok: false, pid: null, bindAddress: before.bindAddress, url, logFile, reclaimedPids, error: `port ${port} is occupied but \`ss -ltnp\` shows no pid — refusing to guess; inspect manually` }
    }
    killExactPids(before.pids)
    reclaimedPids.push(...before.pids)
  }

  const child = spawn('setsid', ['sh', '-c', `cd "${opts.dir}" && pnpm preview >> "${logFile}" 2>&1`], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const deadline = Date.now() + (opts.pollTimeoutMs ?? 30_000)
  for (;;) {
    await new Promise((r) => setTimeout(r, 500))
    const probe = ssProbe(port)
    if (probe.listening) {
      if (probe.bindKind === 'any') {
        return { ok: true, pid: probe.pids[0] ?? null, bindAddress: probe.bindAddress, url, logFile, reclaimedPids }
      }
      // Bound, but not reachable from outside — the exact #137 shape. Kill
      // the loopback listener we just created and report.
      if (probe.pids.length > 0) killExactPids(probe.pids)
      return { ok: false, pid: probe.pids[0] ?? null, bindAddress: probe.bindAddress, url, logFile, reclaimedPids, error: `preview bound ${probe.bindAddress}:${port} (loopback/specific) — externally unreachable; see ${logFile}` }
    }
    if (Date.now() > deadline) {
      return { ok: false, pid: null, bindAddress: null, url, logFile, reclaimedPids, error: `preview did not listen on ${port} within ${opts.pollTimeoutMs ?? 30_000}ms; see ${logFile}` }
    }
  }
}

export interface ServeStopResult {
  ok: boolean
  killedPids: number[]
  error?: string
}

/** `cc serve stop`: kill whoever listens on the port, by exact PID only. */
export function serveStop(port?: number): ServeStopResult {
  const p = port ?? 8080
  const probe = ssProbe(p)
  if (!probe.listening) return { ok: true, killedPids: [] }
  if (probe.pids.length === 0) {
    return { ok: false, killedPids: [], error: `port ${p} is listening but \`ss -ltnp\` shows no pid — refusing to guess` }
  }
  killExactPids(probe.pids)
  const after = ssProbe(p)
  return after.listening
    ? { ok: false, killedPids: probe.pids, error: `port ${p} still listening after kill` }
    : { ok: true, killedPids: probe.pids }
}
