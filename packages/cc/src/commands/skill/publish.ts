import { defineCommand } from 'citty'

export const skillPublishCommand = defineCommand({
  meta: {
    name: 'publish',
    description: 'Validate a skill and write its manifest entry into a local registry checkout',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'Path to the skill directory',
      // See validate.ts for why this stays unrequired at the citty level.
      required: false,
    },
    registry: {
      type: 'string',
      description: 'Path to a local registry git checkout',
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
      const { runSkillPublishAgentAdapter } = await import('../../adapters/skill/agent.js')
      await runSkillPublishAgentAdapter({
        dir: args.dir ?? '',
        registry: args.registry ?? '',
        silent: args.silent,
        json: args.json,
      })
    } else {
      const { runSkillPublishHumanAdapter } = await import('../../adapters/skill/human.js')
      await runSkillPublishHumanAdapter({
        dir: args.dir ?? '',
        registry: args.registry ?? '',
      })
    }
  },
})
