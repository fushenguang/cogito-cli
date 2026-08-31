import { defineCommand } from 'citty'
import { runDataDeliver } from '../core/data-deliver.js'

export const dataCommand = defineCommand({
  meta: {
    name: 'data',
    description: 'Data model pipeline: deliver (publish DATA_MODEL runtime nodes into the spine, hash manifest, never gating)',
  },
  subCommands: {
    deliver: defineCommand({
      meta: {
        name: 'deliver',
        description: 'Publish DATA_MODEL/ runtime nodes into public/game-*.json and write the .data-deliver.json hash manifest',
      },
      args: {
        dir: { type: 'string', description: 'Project directory (defaults to cwd)' },
        json: { type: 'boolean', description: 'NDJSON/JSON output (agent mode)', default: false },
      },
      async run({ args }) {
        const dir = typeof args.dir === 'string' ? args.dir : process.cwd()
        const result = runDataDeliver(dir)
        if (args.json) {
          process.stdout.write(JSON.stringify(result) + '\n')
        } else {
          const lines = [
            `data deliver — ${result.status}${result.reason ? ` (${result.reason})` : ''}`,
            ...result.files.map((f) => `  ${f.file}: ${f.nodes} nodes (${f.runtimeNodes} runtime) sha256=${f.sha256.slice(0, 12)}…`),
            ...result.spine.filter((s) => s.changed).map((s) => `  spine ${s.file}: CHANGED sha256=${s.sha256.slice(0, 12)}…`),
            ...result.errors.map((e) => `  error: ${e}`),
            `  manifest: ${dir}/.data-deliver.json`,
          ]
          process.stdout.write(lines.join('\n') + '\n')
        }
        // Hashes are records, not gates: a skipped delivery (no DATA_MODEL/)
        // exits 0; only malformed input that FAILED to deliver exits 1.
        if (result.status === 'failed') process.exitCode = 1
      },
    }),
  },
})
