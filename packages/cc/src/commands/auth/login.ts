import { defineCommand } from 'citty'

export const authLoginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Sign in to your account via the browser',
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
      const { runAuthLoginAgentAdapter } = await import('../../adapters/auth/agent.js')
      await runAuthLoginAgentAdapter({ ...opts, silent: args.silent, json: args.json })
    } else {
      const { runAuthLoginHumanAdapter } = await import('../../adapters/auth/human.js')
      await runAuthLoginHumanAdapter(opts)
    }
  },
})
