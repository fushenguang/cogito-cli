// generate-registry
//
// Scans templates/[name]/package.json, resolves workspace:* deps to actual versions
// from packages/[name]/package.json, and writes packages/cli/src/registry.json.

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readdirSync, statSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '../..')

interface PackageJson {
  name?: string
  version?: string
  description?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  cogito?: {
    minCliVersion?: string
  }
}

interface RegistryTemplate {
  id: string
  name: string
  description: string
  minCliVersion: string
  source: string
  resolvedDependencies: Record<string, string>
}

interface Registry {
  version: '1'
  templates: RegistryTemplate[]
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T
}

/** Build a map of @cogito.ai/* package name -> version from packages/ dir */
function buildPackageVersionMap(): Record<string, string> {
  const packagesDir = join(repoRoot, 'packages')
  const entries = readdirSync(packagesDir)
  const map: Record<string, string> = {}

  for (const entry of entries) {
    const pkgJsonPath = join(packagesDir, entry, 'package.json')
    try {
      if (!statSync(pkgJsonPath).isFile()) continue
      const pkg = readJson<PackageJson>(pkgJsonPath)
      if (pkg.name && pkg.version) {
        map[pkg.name] = pkg.version
      }
    } catch {
      // skip entries without package.json
    }
  }

  return map
}

/** Resolve workspace:* entries using the version map */
function resolveWorkspaceDeps(
  deps: Record<string, string> | undefined,
  versionMap: Record<string, string>,
): Record<string, string> {
  if (!deps) return {}
  const resolved: Record<string, string> = {}
  for (const [name, version] of Object.entries(deps)) {
    if (version === 'workspace:*') {
      const resolvedVersion = versionMap[name]
      if (!resolvedVersion) {
        throw new Error(`Cannot resolve workspace:* for "${name}": package not found in packages/`)
      }
      resolved[name] = `^${resolvedVersion}`
    } else {
      resolved[name] = version
    }
  }
  return resolved
}

function main(): void {
  const versionMap = buildPackageVersionMap()
  const templatesDir = join(repoRoot, 'templates')
  const templateDirs = readdirSync(templatesDir).filter((d) => {
    try {
      return statSync(join(templatesDir, d)).isDirectory()
    } catch {
      return false
    }
  })

  const templates: RegistryTemplate[] = []

  for (const dir of templateDirs) {
    const pkgJsonPath = join(templatesDir, dir, 'package.json')
    let pkg: PackageJson
    try {
      pkg = readJson<PackageJson>(pkgJsonPath)
    } catch {
      console.warn(`Skipping ${dir}: no package.json found`)
      continue
    }

    const allDeps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }

    const resolvedDependencies = resolveWorkspaceDeps(allDeps, versionMap)

    templates.push({
      id: dir,
      name: pkg.name ?? dir,
      description: pkg.description ?? '',
      minCliVersion: pkg.cogito?.minCliVersion ?? '0.1.0',
      source: `templates/${dir}`,
      resolvedDependencies,
    })
  }

  const registry: Registry = {
    version: '1',
    templates,
  }

  const outputDir = join(repoRoot, 'packages/cli/src')
  mkdirSync(outputDir, { recursive: true })

  const outputPath = join(outputDir, 'registry.json')
  writeFileSync(outputPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')

  console.log(`[generate-registry] Written ${templates.length} template(s) to ${outputPath}`)
}

main()
