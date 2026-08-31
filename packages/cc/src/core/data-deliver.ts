// data-deliver.ts — blade 2: publish the design-layer data model into the
// runtime spine, with hashes recorded but never gating (blade 2 spec:
// “哈希记 Run 事件只记录不阻断”).
//
// Two layers, one tree (2026-08-31 finalization, see cogito-lib
// game-dev/data-model.mdx):
//
//   DATA_MODEL/*.json          design layer — milestone artifacts, nodes
//                              { id, type, name, description, content }
//   public/game-{data,assets,doc}.json   runtime spine — what the engine reads
//
// This module is the publish leg: context nodes stay put (AI reads them via
// read-list), runtime nodes (which additionally carry consumedBy + assertions)
// are written into the spine at their `consumedBy` path, and everything gets
// hashed into a manifest (.data-deliver.json) that `cc evidence` / the
// platform's pollRun can pick up. Hashes are RECORDS, not gates — a failed
// hash check must never fail a run.
//
// v0 semantics, deliberately dumb: a runtime node's `content` is published
// AS-IS at the consumedBy path. No semantic compilation (base/override
// merging stays the engine's business). Authority over what belongs in the
// spine stays with game-dsl v5; DATA_MODEL is the container + provenance
// layer and does not invent spine semantics.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type NodeType = 'context' | 'runtime' | 'forbidden'

export interface DataModelNode {
  id: string
  type: NodeType
  name: string
  description: string
  content: unknown
  /** runtime only: spine target like "game-data.json#rules.opportunityWindow" */
  consumedBy?: string[]
  /** runtime only: assertion itemId references */
  assertions?: string[]
}

export interface DeliverFileReport {
  file: string
  sha256: string
  nodes: number
  runtimeNodes: number
}

export interface DeliverSpineReport {
  file: string
  sha256: string
  changed: boolean
}

export interface DeliverResult {
  ok: boolean
  /** 'no-data-model' = nothing to deliver (scaffold-only project) — not an error. */
  status: 'delivered' | 'skipped' | 'failed'
  reason?: string
  files: DeliverFileReport[]
  /** Spine writes actually performed (unchanged writes are still hashed here). */
  spine: DeliverSpineReport[]
  errors: string[]
  deliveredAt: string
}

export const DATA_MODEL_DIR = 'DATA_MODEL'
export const SPINE_FILES = ['game-data.json', 'game-assets.json', 'game-doc.json'] as const
export const MANIFEST_FILE = '.data-deliver.json'

const SPINE_SET = new Set<string>(SPINE_FILES)

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * schema v0 validation. Nodes failing this are recorded and skipped —
 * a malformed design file must not abort publishing the well-formed ones.
 */
export function validateNode(node: unknown, file: string, errors: string[]): node is DataModelNode {
  if (typeof node !== 'object' || node === null) {
    errors.push(`${file}: node is not an object`)
    return false
  }
  const n = node as Record<string, unknown>
  for (const key of ['id', 'type', 'name', 'description', 'content'] as const) {
    if (!(key in n)) {
      errors.push(`${file}: node missing required key "${key}"`)
      return false
    }
  }
  if (typeof n['id'] !== 'string' || n['id'].length === 0) {
    errors.push(`${file}: node.id must be a non-empty string`)
    return false
  }
  if (n['type'] !== 'context' && n['type'] !== 'runtime' && n['type'] !== 'forbidden') {
    errors.push(`${file}: ${String(n['id'])}: type must be context|runtime|forbidden`)
    return false
  }
  if (n['type'] === 'runtime') {
    if (!Array.isArray(n['consumedBy']) || n['consumedBy'].length === 0) {
      errors.push(`${file}: ${String(n['id'])}: runtime node requires non-empty consumedBy`)
      return false
    }
  }
  return true
}

/** Writes `value` at a dot path inside a plain object, creating intermediates. */
function deepSet(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]!] = value
}

/**
 * Publish DATA_MODEL/ runtime nodes into the spine. Pure with respect to the
 * caller-supplied fs via parameters — see `runDataDeliver` for the disk-bound
 * wrapper. Exposed for tests.
 */
export function deliverFromBuffers(
  modelFiles: Map<string, string>, // file name -> raw JSON text
  spineBuffers: Map<string, string>, // spine file name -> current raw text ('' if absent)
): { result: Omit<DeliverResult, 'deliveredAt'>; spineWrites: Map<string, string> } {
  const errors: string[] = []
  const files: DeliverFileReport[] = []
  const spineWrites = new Map<string, string>()
  let runtimeTotal = 0

  // Parse + validate every design file first; only then touch the spine.
  const runtimeNodes: Array<{ node: DataModelNode; file: string }> = []
  for (const [file, raw] of modelFiles) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      errors.push(`${file}: not valid JSON (${String(e)})`)
      files.push({ file, sha256: sha256(raw), nodes: 0, runtimeNodes: 0 })
      continue
    }
    if (!Array.isArray(parsed)) {
      errors.push(`${file}: top level must be a node array`)
      files.push({ file, sha256: sha256(raw), nodes: 0, runtimeNodes: 0 })
      continue
    }
    let runtimeCount = 0
    for (const node of parsed) {
      if (!validateNode(node, file, errors)) continue
      if (node.type === 'runtime') {
        runtimeNodes.push({ node, file })
        runtimeCount++
      }
    }
    files.push({ file, sha256: sha256(raw), nodes: parsed.length, runtimeNodes: runtimeCount })
  }

  // Working copies of the spine.
  const spine: Map<string, Record<string, unknown>> = new Map()
  const spineReports: DeliverSpineReport[] = []
  for (const name of SPINE_FILES) {
    const raw = spineBuffers.get(name) ?? ''
    let obj: Record<string, unknown>
    if (raw.trim().length === 0) {
      obj = {}
    } else {
      try {
        obj = JSON.parse(raw) as Record<string, unknown>
      } catch {
        errors.push(`public/${name}: not valid JSON, refusing to overwrite a broken spine`)
        obj = null as unknown as Record<string, unknown>
      }
    }
    spine.set(name, obj)
    spineReports.push({ file: name, sha256: raw ? sha256(raw) : '', changed: false })
  }

  // Publish each runtime node at every consumedBy path.
  for (const { node, file } of runtimeNodes) {
    for (const target of node.consumedBy ?? []) {
      // Format: "<spine-file>#<dotted.path>"
      const hashIdx = target.indexOf('#')
      if (hashIdx <= 0) {
        errors.push(`${file}: ${node.id}: consumedBy "${target}" must be "<file>#<path>"`)
        continue
      }
      const spineFile = target.slice(0, hashIdx)
      const path = target.slice(hashIdx + 1)
      if (!SPINE_SET.has(spineFile)) {
        errors.push(`${file}: ${node.id}: consumedBy targets unknown spine file "${spineFile}"`)
        continue
      }
      const obj = spine.get(spineFile)
      if (obj == null) {
        continue // broken spine already recorded above
      }
      if (path.length === 0 || path.includes('#')) {
        errors.push(`${file}: ${node.id}: consumedBy path "${target}" is malformed`)
        continue
      }
      deepSet(obj, path, node.content)
      runtimeTotal++
    }
  }

  // Diff each spine against its previous text to set `changed`.
  for (let i = 0; i < SPINE_FILES.length; i++) {
    const name = SPINE_FILES[i]!
    const obj = spine.get(name)
    if (obj === null) {
      continue
    }
    const next = JSON.stringify(obj, null, 2) + '\n'
    const prev = spineBuffers.get(name) ?? ''
    const report = spineReports[i]!
    report.changed = next !== prev
    report.sha256 = sha256(next)
    spineWrites.set(name, next)
  }

  return {
    result: {
      ok: errors.length === 0,
      status: modelFiles.size === 0 ? 'skipped' : errors.length === 0 ? 'delivered' : 'failed',
      ...(modelFiles.size === 0 ? { reason: 'no-data-model' } : {}),
      files,
      spine: spineReports,
      errors,
    },
    spineWrites,
  }
}

/** Disk-bound wrapper used by the `cc data deliver` command. */
export function runDataDeliver(dir: string): DeliverResult {
  const modelDirPath = join(dir, DATA_MODEL_DIR)
  const modelFiles = new Map<string, string>()
  if (existsSync(modelDirPath)) {
    for (const entry of readdirSync(modelDirPath)) {
      if (!entry.endsWith('.json')) continue
      modelFiles.set(entry, readFileSync(join(modelDirPath, entry), 'utf-8'))
    }
  }

  const spineBuffers = new Map<string, string>()
  for (const name of SPINE_FILES) {
    const p = join(dir, 'public', name)
    spineBuffers.set(name, existsSync(p) ? readFileSync(p, 'utf-8') : '')
  }

  const { result, spineWrites } = deliverFromBuffers(modelFiles, spineBuffers)

  // Only write spines that actually changed — never touch an unchanged file
  // (keeps mtime meaningful for the hot-reload watcher).
  for (const [name, text] of spineWrites) {
    const prev = spineBuffers.get(name) ?? ''
    if (text !== prev) {
      writeFileSync(join(dir, 'public', name), text, 'utf-8')
    }
  }

  const full: DeliverResult = { ...result, deliveredAt: new Date().toISOString() }
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(full, null, 2) + '\n', 'utf-8')
  return full
}
