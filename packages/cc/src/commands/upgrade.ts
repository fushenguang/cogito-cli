import { defineCommand } from 'citty'

export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Move a scaffolded project onto the template version this CLI ships (issue #22)',
  },
  args: {
    dir: {
      type: 'string',
      description: 'Project directory (absolute or relative to cwd). Defaults to cwd.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite template-owned files the project has edited (conflicts)',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would happen without touching anything',
      default: false,
    },
    silent: {
      type: 'boolean',
      description: 'Suppress human output (agent mode)',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output the report as NDJSON (agent mode)',
      default: false,
    },
  },
  async run({ args }) {
    const { resolve } = await import('node:path')
    const { upgradeProject } = await import('../core/upgrade.js')
    const { getTemplate } = await import('../core/registry.js')
    const { getTemplateSourceDir } = await import('../core/scaffold.js')
    const { VERSION } = await import('../version.js')

    // citty puts bare positionals in args._; --dir is the explicit form.
    const positional = Array.isArray(args._) ? String(args._[0] ?? '') : ''
    const projectDir = resolve(args.dir || positional || '.')
    const template = getTemplate('game-web-phaser')
    if (!template) {
      console.error('game-web-phaser template not found in registry')
      process.exitCode = 1
      return
    }

    const report = upgradeProject({
      projectDir,
      templateDir: getTemplateSourceDir(template.source),
      force: args.force,
      dryRun: args['dry-run'],
      // The CLI's own version IS the template's version — the CLI is the
      // template's only delivery vehicle (check:template proves the pair).
      templateVersion: VERSION,
    })

    if (args.json) {
      console.log(JSON.stringify(report))
    } else if (!args.silent) {
      const tag = `[cc upgrade → ${VERSION}]`
      if (!report.ok) {
        console.error(`${tag} failed: ${report.reason ?? 'unknown reason'}`)
      } else if (report.action === 'no-change') {
        console.log(`${tag} ${report.reason ?? 'no changes needed'}`)
      } else {
        console.log(
          `${tag} ${report.replaced.length} template file(s) replaced${report.action === 'upgraded' ? ' and committed as one upgrade commit' : ''}${args['dry-run'] ? ' (dry run — nothing written)' : ''}`,
        )
        for (const f of report.replaced) console.log(`  replaced  ${f}`)
      }
      for (const f of report.conflicts) console.log(`  conflict  ${f} (project-edited; rerun with --force to overwrite)`)
      if (report.ok && report.action === 'upgraded' && report.reason) console.log(`  note: ${report.reason}`)
    }
    if (!report.ok) process.exitCode = 1
  },
})
