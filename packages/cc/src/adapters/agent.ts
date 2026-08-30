import { join, isAbsolute, resolve } from 'path'
import { getTemplate } from '../core/registry.js'
import { scaffoldProject } from '../core/scaffold.js'

export interface AgentAdapterOptions {
  name: string
  template: string
  pm?: string
  silent?: boolean
  json?: boolean
  /** Explicit target directory. Absolute or relative to cwd. Defaults to ./<name>. */
  dir?: string
  /** Data layer selection: 'supabase' | 'drizzle'. Defaults to undefined (no SQL schema replacement). */
  dataLayer?: 'supabase' | 'drizzle' | undefined
  /** Supabase schema name. Defaults to 'public' when dataLayer is 'supabase'. */
  schema?: string
  /**
   * Human-facing title substituted for {{PROJECT_NAME}} in generated source
   * (e.g. <title>, in-game strings). Can be non-ASCII. `name` (the npm
   * package name) is unaffected either way. Omitted => falls back to `name`.
   */
  displayName?: string
}

function emit(obj: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }
}

export async function runAgentAdapter(opts: AgentAdapterOptions): Promise<void> {
  const {
    name,
    template: templateId,
    pm,
    silent = false,
    json = false,
    dir,
    dataLayer,
    schema,
    displayName,
  } = opts

  const output = json || silent

  if (!name) {
    const err = { ok: false, error: 'MISSING_ARG', field: 'name' }
    if (output) {
      emit(err, true)
    } else {
      console.error('Error: --name is required in agent mode')
    }
    process.exit(1)
  }

  if (!templateId) {
    const err = { ok: false, error: 'MISSING_ARG', field: 'template' }
    if (output) {
      emit(err, true)
    } else {
      console.error('Error: --template is required in agent mode')
    }
    process.exit(1)
  }

  const template = getTemplate(templateId)
  if (!template) {
    const err = { ok: false, error: 'TEMPLATE_NOT_FOUND', template: templateId }
    if (output) {
      emit(err, true)
    } else {
      console.error(`Error: template "${templateId}" not found`)
    }
    process.exit(1)
  }

  const targetDir = dir
    ? isAbsolute(dir)
      ? dir
      : resolve(process.cwd(), dir)
    : join(process.cwd(), name)

  if (!silent && !json) {
    console.log(`Scaffolding project "${name}" using template "${templateId}"...`)
  }

  const effectiveDataLayer = dataLayer ?? 'supabase'
  const result = scaffoldProject({
    targetDir,
    name,
    template,
    packageManager: (pm as 'pnpm' | 'npm' | 'yarn' | 'bun') ?? 'pnpm',
    ...(effectiveDataLayer === 'supabase' ? { schema: schema ?? 'public' } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  })

  if (output) {
    emit(result, true)
  } else if (result.ok) {
    console.log(`✓ Project created at ${targetDir}`)
  } else {
    console.error(`✗ ${result.message}`)
  }

  if (!result.ok) {
    process.exit(1)
  }
}
