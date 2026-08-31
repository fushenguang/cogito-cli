// hot-reload.ts — blade 2: spine hot reload + tuning diff, the playtest
// tuning loop's fixed pipeline.
//
// Scenario (from the 2026-08-31 finalization): the builder playtests, tunes
// numbers in `public/game-data.json`, and the change must be live on the
// NEXT browser refresh — no rebuild, no server restart. Then the tuning
// must not evaporate: every change is diffed against the served baseline
// into `.tuning-log.jsonl`, and `cc evidence` (the run-closing step)
// syncs the final values back into `DATA_MODEL/` (the canonical design
// layer) before the git anchor commits them. Tuning goes: edit → spine →
// log → canonical → git anchor → evidence bundle (判词材料).
//
// Mechanism, deliberately boring: `cc serve watch` (spawned detached by
// `cc serve start`) polls once a second. public/*.json changed → copy into
// dist/ (vite preview serves dist; public assets only reach dist at build
// time, so the copy IS the hot reload — sub-second, zero build) + append a
// diff line. Port dead (preview killed/crashed) → the watcher exits by
// itself; nothing leaks. No PID files, no name matching.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSsListen } from './serve.js'
import { SPINE_FILES, type DataModelNode, validateNode } from './data-deliver.js'

export const TUNING_LOG = '.tuning-log.jsonl'

export interface DiffEntry {
  path: string
  from: unknown
  to: unknown
}

/**
 * Leaf-level diff of two JSON values. Pure. Paths are dotted with array
 * indexes (`levels.0.rules.durationSec`). Only leaves that CHANGED are
 * reported; added subtrees collapse to their leaves, removed subtrees to
 * `{ to: undefined }` leaves.
 */
export function deepDiff(from: unknown, to: unknown, prefix = ''): DiffEntry[] {
  const bothObjects =
    typeof from === 'object' && from !== null && !Array.isArray(from) &&
    typeof to === 'object' && to !== null && !Array.isArray(to)
  if (bothObjects) {
    const out: DiffEntry[] = []
    const keys = new Set([...Object.keys(from as object), ...Object.keys(to as object)])
    for (const key of keys) {
      out.push(...deepDiff((from as Record<string, unknown>)[key], (to as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key))
    }
    return out
  }
  // Array-vs-array or scalar-vs-anything: compare wholesale at this node.
  if (JSON.stringify(from) !== JSON.stringify(to)) {
    return [{ path: prefix, from, to }]
  }
  return []
}

export interface TuningLogLine {
  at: string
  file: string
  entries: DiffEntry[]
}

export function parseTuningLog(text: string): TuningLogLine[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TuningLogLine]
      } catch {
        return []
      }
    })
}

/** One poll pass, disk-bound. Returns what it did so the caller can log. */
export function watchPass(dir: string, baseline: Map<string, string>): { copied: string[]; diffs: TuningLogLine[] } {
  const copied: string[] = []
  const diffs: TuningLogLine[] = []
  for (const name of SPINE_FILES) {
    const publicPath = join(dir, 'public', name)
    if (!existsSync(publicPath)) continue
    const now = readFileSync(publicPath, 'utf-8')
    const prev = baseline.get(name)
    if (prev === now) continue

    let parsedPrev: unknown = undefined
    let parsedNow: unknown = undefined
    try {
      parsedPrev = prev === undefined ? undefined : JSON.parse(prev)
      parsedNow = JSON.parse(now)
    } catch {
      // Broken JSON mid-edit (truncated write, partial save): do NOT copy a
      // broken spine into dist and do NOT record a diff — wait for the next
      // poll, editors save atomically enough in practice.
      continue
    }
    const entries = deepDiff(parsedPrev, parsedNow)
    if (prev !== undefined) {
      diffs.push({ at: new Date().toISOString(), file: name, entries })
    }

    // The hot reload itself: public → dist copy. dist may not exist yet
    // (preview not built) — copyFileSync would throw, which the caller
    // treats as "skip this pass".
    const distPath = join(dir, 'dist', name)
    if (existsSync(join(dir, 'dist'))) {
      copyFileSync(publicPath, distPath)
      copied.push(name)
    }
    baseline.set(name, now)
  }
  return { copied, diffs }
}

export interface WatchResult {
  reason: 'port-dead' | 'spine-gone' | 'initial-probe-failed'
  passes: number
}

/**
 * Resident loop for `cc serve watch`. Exits by itself when the preview port
 * goes dead — that is its ONLY shutdown path (no PID files, no name match).
 */
export function serveWatchLoop(dir: string, port: number, pollMs = 1000): WatchResult {
  const baseline = new Map<string, string>()
  let passes = 0
  for (;;) {
    const probe = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 10_000 })
    if (probe.error || probe.status !== 0) {
      return { reason: 'initial-probe-failed', passes }
    }
    if (!parseSsListen(probe.stdout, port).listening) {
      return { reason: 'port-dead', passes }
    }
    const { diffs } = watchPass(dir, baseline)
    if (diffs.length > 0) {
      const line = diffs.map((d) => JSON.stringify(d)).join('\n') + '\n'
      writeFileSync(join(dir, TUNING_LOG), line, { flag: 'a' })
    }
    passes++
    spawnSync('sleep', [String(pollMs / 1000)])
  }
}

export interface SyncBackResult {
  /** tuning lines consumed (0 = no log file / empty). */
  applied: boolean
  /** runtime nodes whose content changed in DATA_MODEL/. */
  updatedNodes: string[]
  archivedTo: string | null
  error?: string
}

/**
 * Sync tuned spine values back into DATA_MODEL/ runtime nodes — the
 * "回写 canonical" half. Called from the run-closing step (`cc evidence`)
 * BEFORE the git anchor, so the synced-back canonical is what gets
 * committed. The tuning log is archived (renamed) so it is consumed once.
 */
export function syncBackTuning(dir: string): SyncBackResult {
  const logPath = join(dir, TUNING_LOG)
  if (!existsSync(logPath)) {
    return { applied: false, updatedNodes: [], archivedTo: null }
  }
  const lines = parseTuningLog(readFileSync(logPath, 'utf-8'))
  if (lines.length === 0) {
    return { applied: false, updatedNodes: [], archivedTo: null, error: 'tuning log present but empty/malformed' }
  }

  const modelDir = join(dir, 'DATA_MODEL')
  if (!existsSync(modelDir)) {
    return { applied: false, updatedNodes: [], archivedTo: null, error: 'tuning happened but DATA_MODEL/ is absent — nothing to sync back into' }
  }

  const updatedNodes: string[] = []
  // Publish-in reverse: node.content := current spine value at consumedBy.
  const spineCache = new Map<string, unknown>()
  for (const entry of readdirSync(modelDir)) {
    if (!entry.endsWith('.json')) continue
    const filePath = join(modelDir, entry)
    let nodes: unknown
    try {
      nodes = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      continue // deliver already reports malformed files; sync-back skips them
    }
    if (!Array.isArray(nodes)) continue
    const errors: string[] = []
    let changed = false
    const updated = nodes.map((raw) => {
      if (!validateNode(raw, entry, errors)) return raw
      const node = raw as DataModelNode
      if (node.type !== 'runtime' || !node.consumedBy) return raw
      for (const target of node.consumedBy) {
        const hashIdx = target.indexOf('#')
        if (hashIdx <= 0) continue
        const spineFile = target.slice(0, hashIdx)
        const path = target.slice(hashIdx + 1)
        if (!spineCache.has(spineFile)) {
          const p = join(dir, 'public', spineFile)
          let parsed: unknown = null
          if (existsSync(p)) {
            try {
              parsed = JSON.parse(readFileSync(p, 'utf-8'))
            } catch {
              parsed = null // deliver reports broken spines; sync-back skips them
            }
          }
          spineCache.set(spineFile, parsed)
        }
        const current = deepGet(spineCache.get(spineFile), path.split('.'))
        if (current !== undefined && JSON.stringify(current) !== JSON.stringify(node.content)) {
          node.content = current
          changed = true
          if (!updatedNodes.includes(node.id)) updatedNodes.push(node.id)
        }
      }
      return node
    })
    if (changed) {
      writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
    }
  }

  const archivedTo = `${TUNING_LOG}.${Date.now()}.consumed`
  renameSync(logPath, join(dir, archivedTo))
  return { applied: true, updatedNodes, archivedTo }
}

function deepGet(value: unknown, path: string[]): unknown {
  let cursor: unknown = value
  for (const part of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}
