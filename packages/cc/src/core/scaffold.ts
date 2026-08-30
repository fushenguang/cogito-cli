import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import type { RegistryTemplate } from './registry.js'
import { checkVersion } from './version.js'
import { VERSION as CLI_VERSION } from '../version.js'

/** Single source of truth for the placeholder templates use for the project name. */
export const PROJECT_NAME_PLACEHOLDER = '{{PROJECT_NAME}}'

// Extensions eligible for {{PROJECT_NAME}} substitution — a whitelist, not a
// blacklist. Templates ship binary assets (audio, images, fonts) that a
// byte-level string replace would corrupt, and the set of binary extensions
// a future template might add is unbounded, so only known-text extensions
// are opted in.
const TEXT_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.md',
  '.mdx',
  '.css',
  '.yml',
  '.yaml',
  '.txt',
])

// Directories never walked into during placeholder substitution: VCS
// metadata and build/dependency output. These can be large, may contain
// third-party files that coincidentally match, and are regenerated or
// reinstalled by the user anyway.
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist'])

// `name` is written verbatim into generated HTML (<title> text content) and
// TS/JS string literals (StartScene.ts) via a plain string replace, not a
// template engine that understands where it lands syntactically. Rather than
// writing per-context escaping (HTML-entity-encode here, JS-string-escape
// there) -- which has to be re-derived for every new file/context a template
// adds and silently breaks if one is missed -- we validate the character set
// up front and reject names that could break out of any of those contexts.
// This is the simpler and safer of the two options the fix must document.
//
// Blocks: HTML/XML-significant chars (< > &), quote/backtick chars that
// close out of a string literal (" ' `), a literal backslash (which would
// alter escaping in the file it lands in), and C0 control characters
// (0x00-0x1F, e.g. a raw newline breaking a single-line JSON/TS string).
export function validateProjectName(name: string): string | null {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    const char = name[i]
    const isControlChar = code <= 0x1f
    const isSyntaxChar = char === '<' || char === '>' || char === '&' ||
      char === '"' || char === "'" || char === '`' || char === '\\'
    if (isControlChar || isSyntaxChar) {
      return `Project name contains characters that are unsafe to embed in generated source files (< > & " ' \` \\ or control characters): "${name}"`
    }
  }
  return null
}

export interface ScaffoldOptions {
  /** Target directory path (absolute or relative to cwd) */
  targetDir: string
  /** Project name written into generated package.json. Must be a valid npm
   *  package name / filesystem-safe slug — this is NOT substituted for
   *  {@link PROJECT_NAME_PLACEHOLDER}, see `displayName`. */
  name: string
  /** Template entry from the registry */
  template: RegistryTemplate
  /** Package manager hint written into generated README / lock hint */
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun'
  /** Schema name to substitute for __SCHEMA__ in .sql files. Undefined = skip substitution. */
  schema?: string | undefined
  /**
   * Human-facing title substituted for {@link PROJECT_NAME_PLACEHOLDER}
   * (e.g. the generated `<title>`, in-game strings). Unlike `name`, this can
   * be any display string, including non-ASCII text — it never becomes an
   * npm package name. When omitted, `name` is used for substitution instead
   * (unchanged, pre-existing behavior).
   */
  displayName?: string | undefined
}

export interface ScaffoldResult {
  ok: true
  targetDir: string
  name: string
  template: string
}

export interface ScaffoldError {
  ok: false
  error: 'TARGET_DIR_EXISTS' | 'CLI_VERSION_OUTDATED' | 'SCAFFOLD_FAILED' | 'INVALID_NAME'
  message: string
}

function getTemplateSourceDir(templateSource: string): string {
  const runtimeDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Built package layout: dist/templates/<id>
    join(runtimeDir, templateSource),
    // Monorepo source layout when running from src/core
    join(runtimeDir, '../../../..', templateSource),
    // Monorepo source layout fallback: <repo>/templates/<id>
    join(runtimeDir, '../../..', templateSource),
  ]

  const sourceDir = candidates.find((p) => existsSync(p))
  if (!sourceDir) {
    throw new Error(
      `Template source not found: ${templateSource}. Looked in: ${candidates.join(', ')}`,
    )
  }

  return sourceDir
}

function rewritePackageJson(
  pkgJsonPath: string,
  name: string,
  resolvedDependencies: Record<string, string>,
): void {
  const raw = readFileSync(pkgJsonPath, 'utf-8')
  const pkg = JSON.parse(raw) as Record<string, unknown>

  pkg['name'] = name
  pkg['version'] = '0.1.0'
  delete pkg['private']
  // Remove the cogito meta field from generated projects
  delete pkg['cogito']
  // Remove packageManager — Corepack enforcement on a pinned old version causes
  // PATH errors for users on newer pnpm versions. engines.pnpm already documents
  // the version requirement without enforcing a specific patch version.
  delete pkg['packageManager']

  // Rewrite workspace:* deps with resolved versions
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[key] as Record<string, string> | undefined
    if (!deps) continue
    for (const [dep, ver] of Object.entries(deps)) {
      if (ver === 'workspace:*' && resolvedDependencies[dep]) {
        deps[dep] = resolvedDependencies[dep]
      }
    }
  }

  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
}

/**
 * Detects the user's installed pnpm version and writes it as the
 * `packageManager` field in the project's root package.json.
 *
 * This allows Turborepo to validate the package manager without requiring
 * `dangerouslyDisablePackageManagerCheck: true` in turbo.json.
 * If pnpm is not in PATH, the field is left unchanged (template keeps its own value).
 */
/**
 * npm hardcodes exclusion of .gitignore and .npmrc from published tarballs.
 * During build we rename them to _gitignore / _npmrc so they survive publish.
 * This function renames them back after the template is copied to the target.
 */
function restoreDotfiles(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      restoreDotfiles(fullPath)
    } else if (entry.name === '_gitignore') {
      renameSync(fullPath, join(dir, '.gitignore'))
    } else if (entry.name === '_npmrc') {
      renameSync(fullPath, join(dir, '.npmrc'))
    }
  }
}

function replaceSchemaPlaceholder(dir: string, schema: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      replaceSchemaPlaceholder(fullPath, schema)
    } else if (entry.name.endsWith('.sql')) {
      const content = readFileSync(fullPath, 'utf-8')
      writeFileSync(fullPath, content.replace(/__SCHEMA__/g, schema), 'utf-8')
    }
  }
}

/**
 * Replaces every occurrence of {@link PROJECT_NAME_PLACEHOLDER} with `name`
 * across text files in `dir`. Walks the whole tree except SKIP_DIR_NAMES,
 * and only opens files whose extension is in TEXT_FILE_EXTENSIONS so binary
 * assets are never read/written.
 */
export function replaceProjectNamePlaceholder(dir: string, name: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      replaceProjectNamePlaceholder(fullPath, name)
      continue
    }
    if (!TEXT_FILE_EXTENSIONS.has(extname(entry.name))) continue

    const content = readFileSync(fullPath, 'utf-8')
    if (!content.includes(PROJECT_NAME_PLACEHOLDER)) continue
    writeFileSync(fullPath, content.split(PROJECT_NAME_PLACEHOLDER).join(name), 'utf-8')
  }
}

function injectPackageManager(pkgJsonPath: string): void {
  if (!existsSync(pkgJsonPath)) return
  try {
    const pnpmVersion = execSync('pnpm --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!pnpmVersion) return
    const raw = readFileSync(pkgJsonPath, 'utf-8')
    const pkg = JSON.parse(raw) as Record<string, unknown>
    pkg['packageManager'] = `pnpm@${pnpmVersion}`
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  } catch {
    // pnpm not found in PATH — skip silently, template's own value remains
  }
}

export function scaffoldProject(options: ScaffoldOptions): ScaffoldResult | ScaffoldError {
  const { targetDir, name, template, packageManager: _pm, schema, displayName } = options

  // Reject names that would break out of the HTML/JS/JSON contexts the name
  // gets substituted into below, before touching the filesystem at all.
  const nameError = validateProjectName(name)
  if (nameError) {
    return {
      ok: false,
      error: 'INVALID_NAME',
      message: nameError,
    }
  }

  // displayName lands in the exact same HTML/JS/JSON contexts as `name`
  // (see replaceProjectNamePlaceholder below), so it is subject to the same
  // character-set gate.
  if (displayName !== undefined) {
    const displayNameError = validateProjectName(displayName)
    if (displayNameError) {
      return {
        ok: false,
        error: 'INVALID_NAME',
        message: displayNameError,
      }
    }
  }

  // Version compatibility check
  try {
    checkVersion(CLI_VERSION, template.minCliVersion, template.id)
  } catch (err) {
    return {
      ok: false,
      error: 'CLI_VERSION_OUTDATED',
      message: JSON.stringify(err),
    }
  }

  // Guard: don't overwrite existing directory
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    return {
      ok: false,
      error: 'TARGET_DIR_EXISTS',
      message: `Target directory "${targetDir}" already exists and is not empty.`,
    }
  }

  try {
    const sourceDir = getTemplateSourceDir(template.source)
    mkdirSync(targetDir, { recursive: true })
    cpSync(sourceDir, targetDir, { recursive: true })

    // Restore dotfiles that were renamed to survive npm publish
    restoreDotfiles(targetDir)

    // Rewrite root package.json (name, version, remove internal fields)
    const pkgJsonPath = join(targetDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      rewritePackageJson(pkgJsonPath, name, template.resolvedDependencies)
    }

    // Inject detected pnpm version so Turborepo can validate the package manager
    // without needing dangerouslyDisablePackageManagerCheck in turbo.json.
    injectPackageManager(pkgJsonPath)

    // Substitute {{PROJECT_NAME}} placeholder across generated text files
    // (e.g. index.html <title>, StartScene.ts, README.md). displayName, when
    // provided, is the human-facing title (can be non-ASCII); `name` must
    // stay a valid npm package name and is never used for this substitution
    // when displayName is present. Omitted => falls back to `name`, byte-for
    // -byte the pre-existing behavior.
    replaceProjectNamePlaceholder(targetDir, displayName ?? name)

    // Substitute __SCHEMA__ placeholder in .sql files
    if (schema) {
      replaceSchemaPlaceholder(targetDir, schema)
    }

    return {
      ok: true,
      targetDir,
      name,
      template: template.id,
    }
  } catch (err) {
    return {
      ok: false,
      error: 'SCAFFOLD_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
