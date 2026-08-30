import { defineCommand } from 'citty'

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Scaffold a new Cogito project',
  },
  args: {
    name: {
      type: 'string',
      description: 'Project name (npm package name / directory slug; ASCII only)',
    },
    'display-name': {
      type: 'string',
      description:
        'Human-facing title substituted into generated source (e.g. <title>). Can be non-ASCII. Defaults to --name.',
    },
    template: {
      type: 'string',
      description: 'Template ID (e.g. web-nextjs)',
    },
    pm: {
      type: 'string',
      description: 'Package manager: pnpm (default), npm, yarn, bun',
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
    dir: {
      type: 'string',
      description: 'Target directory (absolute or relative to cwd). Defaults to ./<name>',
    },
    'data-layer': {
      type: 'string',
      description: 'Data layer: supabase (default) | drizzle',
    },
    schema: {
      type: 'string',
      description: 'Supabase schema name (default: public). Only used when data-layer is supabase.',
    },
  },
  async run({ args }) {
    const isTTY = Boolean(process.stdout.isTTY)
    const isAgentMode = args.silent || args.json || !isTTY

    if (isAgentMode) {
      const { runAgentAdapter } = await import('../adapters/agent.js')
      await runAgentAdapter({
        name: args.name ?? '',
        template: args.template ?? '',
        pm: args.pm,
        silent: args.silent,
        json: args.json,
        dir: args.dir,
        dataLayer: args['data-layer'] as 'supabase' | 'drizzle' | undefined,
        schema: args.schema,
        displayName: args['display-name'],
      })
    } else {
      const { runHumanAdapter } = await import('../adapters/human.js')
      await runHumanAdapter({ dir: args.dir })
    }
  },
})
