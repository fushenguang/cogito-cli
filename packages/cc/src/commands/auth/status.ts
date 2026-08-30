import { defineCommand } from 'citty'

export const authStatusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show authentication status',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Named provider from ~/.cogito/config.json',
    },
    silent: {
      type: 'boolean',
      description: 'Suppress output (agent mode)',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output NDJSON results (agent mode)',
      default: false,
    },
  },
  async run({ args }) {
    const isTTY = Boolean(process.stdout.isTTY)
    const isAgentMode = args.silent || args.json || !isTTY
    const opts = args.provider ? { provider: args.provider } : {}

    if (isAgentMode) {
      const { runAuthStatusAgentAdapter } = await import('../../adapters/auth/agent.js')
      await runAuthStatusAgentAdapter({ ...opts, silent: args.silent, json: args.json })
    } else {
      const { runAuthStatusHumanAdapter } = await import('../../adapters/auth/human.js')
      await runAuthStatusHumanAdapter(opts)
    }
  },
})
