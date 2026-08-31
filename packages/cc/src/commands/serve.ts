import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { defineCommand } from 'citty'
import { serveStart, serveStop } from '../core/serve.js'
import { serveWatchLoop } from '../core/hot-reload.js'

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Artifact preview lifecycle: start (reclaim port 8080 by exact PID, verify ANY bind, hot-reload watcher) / stop / watch',
  },
  subCommands: {
    start: defineCommand({
      meta: { name: 'start', description: 'Reclaim the port, spawn pnpm preview detached, verify the bind is externally reachable, then start the hot-reload watcher' },
      args: {
        dir: { type: 'string', description: 'Project directory (absolute or relative to cwd)' },
        port: { type: 'string', description: 'Port (default 8080 — the template preview contract)' },
        'log-file': { type: 'string', description: 'Preview log file (default /tmp/cc-serve-preview.log)' },
        'no-watch': { type: 'boolean', description: 'Skip the hot-reload watcher (plain preview, blade 2 default behavior)', default: false },
        json: { type: 'boolean', description: 'NDJSON output (agent mode)', default: false },
      },
      async run({ args }) {
        const dir = typeof args.dir === 'string' ? args.dir : process.cwd()
        const logFile = typeof args['log-file'] === 'string' ? args['log-file'] : undefined
        const port = args.port ? Number(args.port) : 8080
        const result = await serveStart({ dir, port, logFile })
        if (args.json) {
          process.stdout.write(JSON.stringify(result) + '\n')
        } else {
          const lines = [
            `serve start — ${result.ok ? 'OK' : 'FAILED'} url=${result.url} bind=${result.bindAddress ?? 'n/a'} pid=${result.pid ?? 'n/a'}`,
            ...(result.reclaimedPids.length > 0 ? [`  reclaimed (exact PID): ${result.reclaimedPids.join(', ')}`] : []),
            ...(result.error ? [`  error: ${result.error}`] : []),
          ]
          process.stdout.write(lines.join('\n') + '\n')
        }

        // Blade 2: hot reload. Only when the preview actually came up — a
        // failed start must not leave a watcher polling a dead port.
        if (result.ok && !args['no-watch']) {
          const watchLogFd = openSync('/tmp/cc-serve-watch.log', 'a')
          // Re-exec this very CLI (`node <argv[1]>` — works for both the
          // built dist bundle and the tsx dev entry) as a detached watcher.
          const watcher = spawn(process.execPath, [process.argv[1]!, 'serve', 'watch', '--dir', dir, '--port', String(port)], {
            detached: true,
            stdio: ['ignore', watchLogFd, watchLogFd],
            env: { ...process.env },
          })
          watcher.unref()
          const line = `hot-reload watcher detached (self-exits when the port dies; spine edits → dist copy + .tuning-log.jsonl; log: /tmp/cc-serve-watch.log)`
          if (args.json) {
            process.stdout.write(JSON.stringify({ type: 'hot-reload', ok: true, detail: line }) + '\n')
          } else {
            process.stdout.write(`  ${line}\n`)
          }
        }
        if (!result.ok) process.exitCode = 1
      },
    }),
    stop: defineCommand({
      meta: { name: 'stop', description: 'Kill whatever listens on the port, by exact PID only (the watcher notices the dead port and exits on its own)' },
      args: {
        port: { type: 'string', description: 'Port (default 8080)' },
        json: { type: 'boolean', description: 'NDJSON output (agent mode)', default: false },
      },
      run({ args }) {
        const result = serveStop(args.port ? Number(args.port) : undefined)
        if (args.json) {
          process.stdout.write(JSON.stringify(result) + '\n')
        } else {
          process.stdout.write(`serve stop — ${result.ok ? 'OK' : 'FAILED'}${result.killedPids.length > 0 ? ` killed: ${result.killedPids.join(', ')}` : ' (nothing listening)'}\n`)
          if (result.error) process.stdout.write(`  error: ${result.error}\n`)
        }
        if (!result.ok) process.exitCode = 1
      },
    }),
    watch: defineCommand({
      meta: {
        name: 'watch',
        description: 'Resident hot-reload watcher: spine edits in public/ → dist copy (live on next refresh) + tuning diff log. Self-exits when the preview port dies. Normally spawned by serve start — not for direct use.',
      },
      args: {
        dir: { type: 'string', description: 'Project directory' },
        port: { type: 'string', description: 'Preview port (default 8080)' },
        'poll-ms': { type: 'string', description: 'Poll interval in ms (default 1000)' },
      },
      run({ args }) {
        const dir = typeof args.dir === 'string' ? args.dir : process.cwd()
        const port = args.port ? Number(args.port) : 8080
        const pollMs = args['poll-ms'] ? Number(args['poll-ms']) : 1000
        const result = serveWatchLoop(dir, port, pollMs)
        process.stdout.write(`serve watch exit — ${result.reason} after ${result.passes} passes\n`)
      },
    }),
  },
})
