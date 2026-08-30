import { defineCommand } from 'citty'
import { authLoginCommand } from './login.js'
import { authLogoutCommand } from './logout.js'
import { authStatusCommand } from './status.js'

// Shape deliberately mirrors `claude auth` (login/logout/status) — an agent or a
// human who knows one knows the other.
export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Manage authentication',
  },
  subCommands: {
    login: authLoginCommand,
    logout: authLogoutCommand,
    status: authStatusCommand,
  },
})
