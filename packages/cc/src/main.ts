import { defineCommand } from 'citty'
import { authCommand } from './commands/auth/index.js'
import { initCommand } from './commands/init.js'
import { mcpCommand } from './commands/mcp.js'
import { skillCommand } from './commands/skill/index.js'
import { VERSION } from './version.js'

export const main = defineCommand({
  meta: {
    name: 'cc',
    description: 'Cogito CLI – scaffold projects for humans and AI agents',
    version: VERSION,
  },
  subCommands: {
    auth: authCommand,
    init: initCommand,
    mcp: mcpCommand,
    skill: skillCommand,
  },
})
