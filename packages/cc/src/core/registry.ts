import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface RegistryTemplate {
  id: string
  name: string
  description: string
  minCliVersion: string
  source: string
  resolvedDependencies: Record<string, string>
}

export interface Registry {
  version: '1'
  templates: RegistryTemplate[]
}

function loadRegistry(): Registry {
  const runtimeDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // Built artifact layout: dist/registry.json
    join(runtimeDir, 'registry.json'),
    // Source layout during local development: src/registry.json
    join(runtimeDir, '..', 'registry.json'),
  ]

  const registryPath = candidates.find((p) => existsSync(p))
  if (!registryPath) {
    throw new Error(`Registry file not found. Looked in: ${candidates.join(', ')}`)
  }

  const raw = readFileSync(registryPath, 'utf-8')
  return JSON.parse(raw) as Registry
}

let _registry: Registry | null = null

function getRegistry(): Registry {
  if (!_registry) {
    _registry = loadRegistry()
  }
  return _registry
}

export function getTemplates(): RegistryTemplate[] {
  return getRegistry().templates
}

export function getTemplate(id: string): RegistryTemplate | undefined {
  return getRegistry().templates.find((t) => t.id === id)
}
