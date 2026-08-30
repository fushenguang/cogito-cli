import { defineCommand } from 'citty'
import { skillPublishCommand } from './publish.js'
import { skillValidateCommand } from './validate.js'

// `init` and `mcp` are both leaf commands — this is the first nested
// subCommand in the repo (recon.md 0.2 point 4). citty's `subCommands`
// accepts any CommandDef, including ones that themselves have subCommands,
// so no framework change was needed — just this parent wiring.
export const skillCommand = defineCommand({
  meta: {
    name: 'skill',
    description: 'Validate and publish Agent Skills',
  },
  subCommands: {
    validate: skillValidateCommand,
    publish: skillPublishCommand,
  },
})
