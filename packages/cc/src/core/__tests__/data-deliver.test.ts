import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deepDiff, parseTuningLog, syncBackTuning, watchPass, TUNING_LOG } from '../hot-reload.js'
import { runDataDeliver, MANIFEST_FILE, DATA_MODEL_DIR } from '../data-deliver.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-blade2-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('deepDiff (pure)', () => {
  it('reports only changed leaves with dotted paths', () => {
    const a = { rules: { speed: 260, jump: -420 }, levels: [{ id: 'l1' }] }
    const b = { rules: { speed: 300, jump: -420 }, levels: [{ id: 'l1' }] }
    expect(deepDiff(a, b)).toEqual([{ path: 'rules.speed', from: 260, to: 300 }])
  })

  it('reports added and removed subtrees collapsed to leaves', () => {
    const a = { rules: { speed: 1 }, keep: true }
    const b = { rules: { speed: 1, extra: 2 }, keep: true }
    const diffs = deepDiff(a, b)
    expect(diffs).toEqual([{ path: 'rules.extra', from: undefined, to: 2 }])
    expect(deepDiff(b, a)).toEqual([{ path: 'rules.extra', from: 2, to: undefined }])
  })

  it('compares arrays wholesale (order changes are diffs at the array node)', () => {
    expect(deepDiff({ xs: [1, 2] }, { xs: [2, 1] })).toEqual([{ path: 'xs', from: [1, 2], to: [2, 1] }])
    expect(deepDiff({ xs: [1, 2] }, { xs: [1, 2] })).toEqual([])
  })
})

describe('runDataDeliver (disk)', () => {
  it('publishes runtime nodes at consumedBy paths and writes the manifest', () => {
    const dir = join(root, 'd1')
    mkdirSync(join(dir, DATA_MODEL_DIR), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, DATA_MODEL_DIR, '01-mechanics.json'), JSON.stringify([
      {
        id: 'm-opportunity-window',
        type: 'runtime',
        name: '72 小时机会窗',
        description: '限时机会，抓住入罐',
        content: { base: { durationSec: 12 }, overrides: [] },
        consumedBy: ['game-data.json#rules.opportunityWindow'],
        assertions: ['m-mech-opportunity-window'],
      },
      {
        id: 'world-view',
        type: 'context',
        name: '世界观',
        description: '主题基调',
        content: { theme: '小镇理财' },
      },
    ]), 'utf-8')
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify({ levels: [{ id: 'l1' }], rules: { playerSpeed: 260 } }), 'utf-8')
    // The other two spines pre-exist in the deliver output format, so they
    // stay unchanged (a missing spine would be created → changed=true).
    writeFileSync(join(dir, 'public', 'game-assets.json'), '{}\n', 'utf-8')
    writeFileSync(join(dir, 'public', 'game-doc.json'), '{}\n', 'utf-8')

    const result = runDataDeliver(dir)
    expect(result.status).toBe('delivered')
    expect(result.ok).toBe(true)
    expect(result.files[0]!.nodes).toBe(2)
    expect(result.files[0]!.runtimeNodes).toBe(1)

    const spine = JSON.parse(readFileSync(join(dir, 'public', 'game-data.json'), 'utf-8'))
    // The untouched half survives; the runtime node landed at its path.
    expect(spine.rules.playerSpeed).toBe(260)
    expect(spine.rules.opportunityWindow).toEqual({ base: { durationSec: 12 }, overrides: [] })
    // context nodes never reach the spine.
    expect(JSON.stringify(spine)).not.toContain('世界观')

    // Manifest written, spine marked changed, hashes recorded.
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf-8'))
    expect(manifest.status).toBe('delivered')
    expect(manifest.spine.find((s: { file: string }) => s.file === 'game-data.json')!.changed).toBe(true)
    expect(manifest.spine.find((s: { file: string }) => s.file === 'game-assets.json')!.changed).toBe(false)
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips (not fails) when DATA_MODEL/ is absent — scaffold-only projects', () => {
    const dir = join(root, 'd2')
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify({ levels: [] }), 'utf-8')
    const result = runDataDeliver(dir)
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('no-data-model')
    expect(result.ok).toBe(true)
  })

  it('records malformed nodes as errors without blocking well-formed ones', () => {
    const dir = join(root, 'd3')
    mkdirSync(join(dir, DATA_MODEL_DIR), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, DATA_MODEL_DIR, 'bad.json'), JSON.stringify([
      { id: 'x', type: 'runtime', name: 'no consumedBy', description: '', content: {} }, // invalid runtime
      { id: 'y', type: 'context', description: 'missing name', content: {} }, // invalid
    ]), 'utf-8')
    writeFileSync(join(dir, DATA_MODEL_DIR, 'good.json'), JSON.stringify([
      { id: 'ok-node', type: 'runtime', name: 'ok', description: '', content: { v: 1 }, consumedBy: ['game-data.json#rules.ok'] },
    ]), 'utf-8')
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify({ levels: [{ id: 'l1' }] }), 'utf-8')

    const result = runDataDeliver(dir)
    expect(result.status).toBe('failed')
    expect(result.errors.length).toBe(2)
    // The good node still published.
    const spine = JSON.parse(readFileSync(join(dir, 'public', 'game-data.json'), 'utf-8'))
    expect(spine.rules.ok).toEqual({ v: 1 })
  })
})

describe('hot reload + sync-back (disk)', () => {
  it('watchPass copies public→dist and logs leaf diffs; syncBackTuning writes them into DATA_MODEL and archives the log', () => {
    const dir = join(root, 'h1')
    mkdirSync(join(dir, 'public'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })
    mkdirSync(join(dir, DATA_MODEL_DIR), { recursive: true })
    const initial = { levels: [{ id: 'l1' }], rules: { playerSpeed: 260 } }
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify(initial), 'utf-8')
    writeFileSync(join(dir, 'dist', 'game-data.json'), JSON.stringify(initial), 'utf-8')
    writeFileSync(join(dir, DATA_MODEL_DIR, '01-mechanics.json'), JSON.stringify([
      { id: 'm-speed', type: 'runtime', name: '速度', description: '', content: 260, consumedBy: ['game-data.json#rules.playerSpeed'] },
    ]), 'utf-8')

    // First pass: baseline capture, no diff. It DOES copy — aligning dist
    // with public is the point of a cold first pass.
    const baseline = new Map<string, string>()
    let pass = watchPass(dir, baseline)
    expect(pass.diffs).toEqual([])
    expect(pass.copied).toEqual(['game-data.json'])

    // Tune the number.
    const tuned = { levels: [{ id: 'l1' }], rules: { playerSpeed: 300 } }
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify(tuned), 'utf-8')
    pass = watchPass(dir, baseline)
    expect(pass.copied).toEqual(['game-data.json'])
    expect(pass.diffs).toEqual([{ at: expect.any(String), file: 'game-data.json', entries: [{ path: 'rules.playerSpeed', from: 260, to: 300 }] }])
    // dist now serves the tuned value — the hot reload itself.
    expect(JSON.parse(readFileSync(join(dir, 'dist', 'game-data.json'), 'utf-8')).rules.playerSpeed).toBe(300)

    // Record the diff the way the resident loop does.
    writeFileSync(join(dir, TUNING_LOG), JSON.stringify(pass.diffs[0]) + '\n', 'utf-8')

    // Broken JSON mid-edit: skipped, not copied, not logged.
    writeFileSync(join(dir, 'public', 'game-data.json'), '{"rules": ', 'utf-8')
    const brokenPass = watchPass(dir, baseline)
    expect(brokenPass.copied).toEqual([])
    expect(brokenPass.diffs).toEqual([])

    // Editor settles on valid JSON again (the broken write is transient).
    writeFileSync(join(dir, 'public', 'game-data.json'), JSON.stringify(tuned), 'utf-8')
    const settledPass = watchPass(dir, baseline)
    expect(settledPass.diffs).toEqual([])

    // Sync back: canonical picks up 300, log consumed exactly once.
    const sync = syncBackTuning(dir)
    expect(sync.applied).toBe(true)
    expect(sync.updatedNodes).toEqual(['m-speed'])
    expect(sync.archivedTo).toMatch(new RegExp(`^${TUNING_LOG}\\.\\d+\\.consumed$`))
    const model = JSON.parse(readFileSync(join(dir, DATA_MODEL_DIR, '01-mechanics.json'), 'utf-8'))
    expect(model[0].content).toBe(300)
    expect(existsSync(join(dir, TUNING_LOG))).toBe(false)
    // Second sync-back with no log: no-op.
    expect(syncBackTuning(dir).applied).toBe(false)
  })

  it('parseTuningLog drops malformed lines instead of throwing', () => {
    expect(parseTuningLog('not json\n{"at":"t","file":"f","entries":[]}\n')).toEqual([{ at: 't', file: 'f', entries: [] }])
  })
})
