import { defineCommand } from 'citty'

export const skillValidateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate a skill directory against the Agent Skills spec',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Path to the skill directory',
      // Not required at the citty parse level (would short-circuit with citty's
      // own usage error before our command runs) — the agent/human adapters
      // perform their own MISSING_ARG check, same convention as `init`
      // (packages/cli/src/commands/init.ts), so --json mode can still emit a
      // structured error.
      required: false,
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

    if (isAgentMode) {
      const { runSkillValidateAgentAdapter } = await import('../../adapters/skill/agent.js')
      await runSkillValidateAgentAdapter({
        dir: args.dir ?? '',
        silent: args.silent,
        json: args.json,
      })
    } else {
      const { runSkillValidateHumanAdapter } = await import('../../adapters/skill/human.js')
      await runSkillValidateHumanAdapter({ dir: args.dir ?? '' })
    }
  },
})
