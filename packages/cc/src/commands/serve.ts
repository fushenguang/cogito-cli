import { defineCommand } from 'citty'
import { serveStart, serveStop } from '../core/serve.js'

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Artifact preview lifecycle: start (reclaim port 8080 by exact PID, verify ANY bind) / stop',
  },
  subCommands: {
    start: defineCommand({
      meta: { name: 'start', description: 'Reclaim the port, spawn pnpm preview detached, verify the bind is externally reachable' },
      args: {
        dir: { type: 'string', description: 'Project directory (absolute or relative to cwd)' },
        port: { type: 'string', description: 'Port (default 8080 — the template preview contract)' },
        'log-file': { type: 'string', description: 'Preview log file (default /tmp/cc-serve-preview.log)' },
        json: { type: 'boolean', description: 'NDJSON output (agent mode)', default: false },
      },
      async run({ args }) {
        const dir = typeof args.dir === 'string' ? args.dir : process.cwd()
        const logFile = typeof args['log-file'] === 'string' ? args['log-file'] : undefined
        const result = await serveStart({ dir, port: args.port ? Number(args.port) : undefined, logFile })
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
        if (!result.ok) process.exitCode = 1
      },
    }),
    stop: defineCommand({
      meta: { name: 'stop', description: 'Kill whatever listens on the port, by exact PID only' },
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
  },
})
