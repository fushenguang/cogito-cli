import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isVersionCompatible, checkVersion } from '../version.js'
import { scaffoldProject } from '../scaffold.js'
import { getTemplate, getTemplates } from '../registry.js'
import type { RegistryTemplate } from '../registry.js'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── version.ts tests ─────────────────────────────────────────────────────────

describe('isVersionCompatible', () => {
  it('returns true when cli version equals min version', () => {
    expect(isVersionCompatible('0.1.0', '0.1.0')).toBe(true)
  })

  it('returns true when cli version is higher (patch)', () => {
    expect(isVersionCompatible('0.1.1', '0.1.0')).toBe(true)
  })

  it('returns true when cli version is higher (minor)', () => {
    expect(isVersionCompatible('0.2.0', '0.1.0')).toBe(true)
  })

  it('returns true when cli version is higher (major)', () => {
    expect(isVersionCompatible('1.0.0', '0.9.9')).toBe(true)
  })

  it('returns false when cli version is lower (patch)', () => {
    expect(isVersionCompatible('0.1.0', '0.1.1')).toBe(false)
  })

  it('returns false when cli version is lower (minor)', () => {
    expect(isVersionCompatible('0.1.9', '0.2.0')).toBe(false)
  })

  it('returns false when cli version is lower (major)', () => {
    expect(isVersionCompatible('0.9.9', '1.0.0')).toBe(false)
  })
})

describe('checkVersion', () => {
  it('does not throw when version is compatible', () => {
    expect(() => checkVersion('0.2.0', '0.1.0', 'web-nextjs')).not.toThrow()
  })

  it('throws CLI_VERSION_OUTDATED error when outdated', () => {
    let thrown: unknown
    try {
      checkVersion('0.1.0', '0.2.0', 'web-nextjs')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect((thrown as { error: string }).error).toBe('CLI_VERSION_OUTDATED')
    expect((thrown as { context: { template: string } }).context.template).toBe('web-nextjs')
  })
})

// ─── registry.ts tests ────────────────────────────────────────────────────────

describe('registry — game-web-phaser template', () => {
  it('is discoverable via getTemplate(id)', () => {
    const template = getTemplate('game-web-phaser')

    expect(template).toBeDefined()
    expect(template?.id).toBe('game-web-phaser')
    expect(template?.source).toBe('templates/game-web-phaser')
    expect(template?.minCliVersion).toBe('0.1.0')
  })

  it('is listed among getTemplates()', () => {
    const ids = getTemplates().map((t) => t.id)
    expect(ids).toContain('game-web-phaser')
  })

  it('resolves its dependencies without leftover workspace:* entries', () => {
    const template = getTemplate('game-web-phaser')
    expect(template).toBeDefined()
    for (const ver of Object.values(template?.resolvedDependencies ?? {})) {
      expect(ver).not.toBe('workspace:*')
    }
  })
})

// ─── scaffold.ts tests ────────────────────────────────────────────────────────

const fakeTemplate: RegistryTemplate = {
  id: 'test-template',
  name: '@test/template',
  description: 'Test template',
  minCliVersion: '0.1.0',
  source: 'templates/test-template',
  resolvedDependencies: {
    '@cogito.ai/tsconfig': '^0.1.0',
    '@cogito.ai/eslint-config': '^0.1.0',
  },
}

describe('scaffoldProject', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cogito-test-${Date.now()}`)
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns TARGET_DIR_EXISTS when directory is non-empty', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'file.txt'), 'hello')

    const result = scaffoldProject({
      targetDir: tmpDir,
      name: 'my-app',
      template: fakeTemplate,
    })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('TARGET_DIR_EXISTS')
  })

  it('returns CLI_VERSION_OUTDATED when template requires newer cli', () => {
    const outdatedTemplate: RegistryTemplate = {
      ...fakeTemplate,
      minCliVersion: '99.0.0',
    }

    const result = scaffoldProject({
      targetDir: tmpDir,
      name: 'my-app',
      template: outdatedTemplate,
    })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('CLI_VERSION_OUTDATED')
  })

  // web-nextjs scaffold test: dropped in cogito-cli extraction — that template stays in AgentDock.

  it('scaffolds game-web-phaser template and rewrites package.json', () => {
    const targetDir = join(tmpDir, 'my-game')
    const template = getTemplate('game-web-phaser')
    expect(template).toBeDefined()
    if (!template) throw new Error('game-web-phaser template not found in registry')

    const result = scaffoldProject({
      targetDir,
      name: 'my-game',
      template,
      packageManager: 'pnpm',
    })

    expect(result.ok).toBe(true)

    // Boot/Preload/Game scenes copied, not collapsed into one file
    expect(existsSync(join(targetDir, 'src/main.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'src/config.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'src/scenes/BootScene.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'src/scenes/PreloadScene.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'src/scenes/GameScene.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'vite.config.ts'))).toBe(true)
    expect(existsSync(join(targetDir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'PROJECT_CONTEXT.md'))).toBe(true)
    expect(existsSync(join(targetDir, 'README.md'))).toBe(true)

    // .gitignore was renamed to _gitignore for npm publish, then restored on scaffold
    expect(existsSync(join(targetDir, '.gitignore'))).toBe(true)

    expect(existsSync(join(targetDir, 'package.json'))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8')) as {
      name: string
      private?: boolean
      cogito?: unknown
      dependencies?: Record<string, string>
      scripts?: Record<string, string>
    }

    expect(pkg.name).toBe('my-game')
    expect(pkg.private).toBeUndefined()
    expect(pkg.cogito).toBeUndefined()
    expect(pkg.dependencies?.['phaser']).toBeDefined()

    // Preview/dev server must stay pinned to port 8080 — the outer platform
    // builds share links against this exact port (see template AGENTS.md).
    expect(pkg.scripts?.['dev']).toContain('8080')
    expect(pkg.scripts?.['preview']).toContain('8080')
  })
})

// ─── workspace:* resolution (via generate-registry logic) ─────────────────────

describe('resolvedDependencies (workspace:* replacement)', () => {
  it('resolved deps contain no workspace:* entries', () => {
    const deps = fakeTemplate.resolvedDependencies
    for (const ver of Object.values(deps)) {
      expect(ver).not.toBe('workspace:*')
    }
  })

  it('resolved deps use semver caret ranges', () => {
    const deps = fakeTemplate.resolvedDependencies
    for (const ver of Object.values(deps)) {
      expect(ver).toMatch(/^\^?\d+\.\d+\.\d+/)
    }
  })
})
