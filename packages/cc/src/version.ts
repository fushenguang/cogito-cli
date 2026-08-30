// Bun inlines the JSON at build time, so this always reflects the published package version.
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version
