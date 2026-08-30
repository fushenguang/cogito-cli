import { defineCommand } from 'citty'
import { collectEvidence } from '../core/evidence.js'

export const evidenceCommand = defineCommand({
  meta: {
    name: 'evidence',
    description: 'Collect the standard evidence bundle: verify-result, data files, git state, optional per-state playtest screenshots',
  },
  args: {
    dir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    shots: { type: 'string', description: 'Comma-separated harness states to photograph via scripts/playtest.mjs (e.g. Start,Game)' },
    out: { type: 'string', description: 'Write bundle JSON to this file (default: stdout)' },
  },
  async run({ args }) {
    const dir = typeof args.dir === 'string' ? args.dir : process.cwd()
    const states = (args.shots ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const bundle = collectEvidence(dir, states.length > 0 ? states : undefined)
    const text = JSON.stringify(bundle, null, 2)
    if (args.out) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(args.out, text + '\n', 'utf8')
      process.stdout.write(`evidence — wrote ${args.out} (${bundle.errors.length} error(s))\n`)
    } else {
      process.stdout.write(text + '\n')
    }
    if (bundle.errors.length > 0) process.exitCode = 1
  },
})
