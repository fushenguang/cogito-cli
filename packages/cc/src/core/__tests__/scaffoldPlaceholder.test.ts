import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  replaceProjectNamePlaceholder,
  validateProjectName,
  PROJECT_NAME_PLACEHOLDER,
  scaffoldProject,
} from '../scaffold.js'
import { getTemplate } from '../registry.js'
import type { RegistryTemplate } from '../registry.js'

// A minimal fake PNG: real magic bytes followed by non-UTF8 bytes and, in
// the middle, the literal placeholder text as raw bytes. A byte-level bug
// (e.g. reading the file as utf-8 and writing it back) would corrupt this.
function fakePngBuffer(): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const placeholderBytes = Buffer.from(PROJECT_NAME_PLACEHOLDER, 'utf-8')
  const junk = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef])
  return Buffer.concat([magic, placeholderBytes, junk])
}

describe('replaceProjectNamePlaceholder', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cogito-placeholder-test-${Date.now()}-${Math.random()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('substitutes the placeholder in whitelisted text files and leaves binaries byte-for-byte untouched', () => {
    // Text files across the whitelisted extensions, mirroring real template files.
    writeFileSync(join(tmpDir, 'index.html'), `<title>${PROJECT_NAME_PLACEHOLDER}</title>`)
    mkdirSync(join(tmpDir, 'src', 'scenes'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'src', 'scenes', 'StartScene.ts'),
      `const title = '${PROJECT_NAME_PLACEHOLDER}'\n`,
    )
    writeFileSync(join(tmpDir, 'README.md'), `# ${PROJECT_NAME_PLACEHOLDER}\n`)

    // A binary file with the placeholder bytes embedded — must NOT be touched
    // because its extension (.png) is not in the text whitelist.
    const pngPath = join(tmpDir, 'public', 'logo.png')
    mkdirSync(join(tmpDir, 'public'), { recursive: true })
    const originalPng = fakePngBuffer()
    writeFileSync(pngPath, originalPng)

    replaceProjectNamePlaceholder(tmpDir, 'My Cool Game')

    expect(readFileSync(join(tmpDir, 'index.html'), 'utf-8')).toBe('<title>My Cool Game</title>')
    expect(readFileSync(join(tmpDir, 'src', 'scenes', 'StartScene.ts'), 'utf-8')).toBe(
      "const title = 'My Cool Game'\n",
    )
    expect(readFileSync(join(tmpDir, 'README.md'), 'utf-8')).toBe('# My Cool Game\n')

    // Binary file must be byte-for-byte identical — not just "still contains
    // the placeholder text", but literally unchanged.
    const afterPng = readFileSync(pngPath)
    expect(Buffer.compare(afterPng, originalPng)).toBe(0)
  })

  it('does not descend into node_modules, .git, or dist', () => {
    for (const dir of ['node_modules', '.git', 'dist']) {
      mkdirSync(join(tmpDir, dir), { recursive: true })
      writeFileSync(join(tmpDir, dir, 'file.js'), PROJECT_NAME_PLACEHOLDER)
    }
    writeFileSync(join(tmpDir, 'index.html'), `<title>${PROJECT_NAME_PLACEHOLDER}</title>`)

    replaceProjectNamePlaceholder(tmpDir, 'My Cool Game')

    expect(readFileSync(join(tmpDir, 'node_modules', 'file.js'), 'utf-8')).toBe(
      PROJECT_NAME_PLACEHOLDER,
    )
    expect(readFileSync(join(tmpDir, '.git', 'file.js'), 'utf-8')).toBe(PROJECT_NAME_PLACEHOLDER)
    expect(readFileSync(join(tmpDir, 'dist', 'file.js'), 'utf-8')).toBe(PROJECT_NAME_PLACEHOLDER)
    // Sanity: the sibling file OUTSIDE those directories was substituted, so
    // the skip is specific to those directories, not a global no-op.
    expect(readFileSync(join(tmpDir, 'index.html'), 'utf-8')).toBe('<title>My Cool Game</title>')
  })

  it('is a no-op on files without the placeholder', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Untouched\n')
    replaceProjectNamePlaceholder(tmpDir, 'Whatever')
    expect(readFileSync(join(tmpDir, 'README.md'), 'utf-8')).toBe('# Untouched\n')
  })
})

describe('validateProjectName', () => {
  it('accepts ordinary names, including non-ASCII/unicode', () => {
    expect(validateProjectName('my-cool-game')).toBeNull()
    expect(validateProjectName('金鹅小镇')).toBeNull()
    expect(validateProjectName('My Cool Game 2')).toBeNull()
  })

  it.each([
    ['<script>alert(1)</script>', '<'],
    ['a & b', '&'],
    [`say "hi"`, '"'],
    [`it's mine`, "'"],
    ['`rm -rf /`', '`'],
    ['back\\slash', '\\'],
    ['line\nbreak', 'newline'],
  ])('rejects names containing unsafe characters: %s (%s)', (name) => {
    expect(validateProjectName(name)).not.toBeNull()
  })
})

describe('scaffoldProject — name validation gate', () => {
  const fakeTemplate: RegistryTemplate = {
    id: 'test-template',
    name: '@test/template',
    description: 'Test template',
    minCliVersion: '0.1.0',
    source: 'templates/test-template',
    resolvedDependencies: {},
  }

  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cogito-scaffold-name-test-${Date.now()}-${Math.random()}`)
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns INVALID_NAME and never touches the filesystem when the name is unsafe', () => {
    const targetDir = join(tmpDir, 'my-app')
    const result = scaffoldProject({
      targetDir,
      name: '<script>alert(1)</script>',
      template: fakeTemplate,
    })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('INVALID_NAME')
    // Validation must happen before any directory is created.
    expect(existsSync(targetDir)).toBe(false)
  })
})

// ─── end-to-end wiring: scaffoldProject → replaceProjectNamePlaceholder ──────
//
// The tests above exercise replaceProjectNamePlaceholder() directly, which
// proves the function itself is correct but says nothing about whether
// scaffoldProject() actually calls it. This block scaffolds the REAL
// game-web-phaser template (the one with the reported bug) end-to-end and
// asserts zero {{PROJECT_NAME}} occurrences survive — this is the test that
// must go red if the call site in scaffoldProject is ever removed.
describe('scaffoldProject — end-to-end placeholder substitution (real template)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cogito-scaffold-e2e-test-${Date.now()}-${Math.random()}`)
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('leaves no {{PROJECT_NAME}} in the scaffolded game-web-phaser project and sets the title', () => {
    const template = getTemplate('game-web-phaser')
    expect(template).toBeDefined()
    if (!template) throw new Error('game-web-phaser template not found in registry')

    const targetDir = join(tmpDir, 'my-game')
    const result = scaffoldProject({
      targetDir,
      name: 'My Cool Game',
      template,
      packageManager: 'pnpm',
    })

    expect(result.ok).toBe(true)

    const indexHtml = readFileSync(join(targetDir, 'index.html'), 'utf-8')
    expect(indexHtml).toContain('<title>My Cool Game</title>')
    expect(indexHtml).not.toContain(PROJECT_NAME_PLACEHOLDER)

    const readme = readFileSync(join(targetDir, 'README.md'), 'utf-8')
    expect(readme).not.toContain(PROJECT_NAME_PLACEHOLDER)

    const startScene = readFileSync(
      join(targetDir, 'src', 'scenes', 'StartScene.ts'),
      'utf-8',
    )
    expect(startScene).not.toContain(PROJECT_NAME_PLACEHOLDER)
  })

  // ─── displayName: package name (ASCII slug) vs. display title (any text) ──
  //
  // `--name` is used both as the npm package name AND, historically, as the
  // {{PROJECT_NAME}} substitution value. A non-ASCII project name slugifies
  // to '' upstream (cogito-lib's slugifyProjectName), which used to fall
  // back to the literal string "project" ending up in the generated
  // <title>. displayName decouples the two: `name` stays package-name-safe,
  // displayName (when given) is what actually lands in generated source.

  it('golden: displayName omitted falls back byte-for-byte to using name for substitution', () => {
    const template = getTemplate('game-web-phaser')
    if (!template) throw new Error('game-web-phaser template not found in registry')

    const targetDir = join(tmpDir, 'my-game-omitted')
    const result = scaffoldProject({
      targetDir,
      name: 'My Cool Game',
      template,
      packageManager: 'pnpm',
    })

    expect(result.ok).toBe(true)
    const indexHtml = readFileSync(join(targetDir, 'index.html'), 'utf-8')
    expect(indexHtml).toContain('<title>My Cool Game</title>')
  })

  it('displayName provided: substitutes displayName instead of name, and can be non-ASCII (Chinese)', () => {
    const template = getTemplate('game-web-phaser')
    if (!template) throw new Error('game-web-phaser template not found in registry')

    const targetDir = join(tmpDir, 'star')
    const result = scaffoldProject({
      targetDir,
      name: 'star', // npm-package-safe slug
      displayName: '星星收集', // human-facing title, non-ASCII
      template,
      packageManager: 'pnpm',
    })

    expect(result.ok).toBe(true)

    // package.json name must stay the ASCII slug — displayName never
    // touches it.
    const pkgJson = JSON.parse(
      readFileSync(join(targetDir, 'package.json'), 'utf-8'),
    ) as { name: string }
    expect(pkgJson.name).toBe('star')

    const indexHtml = readFileSync(join(targetDir, 'index.html'), 'utf-8')
    expect(indexHtml).toContain('<title>星星收集</title>')
    expect(indexHtml).not.toContain('project')
    expect(indexHtml).not.toContain(PROJECT_NAME_PLACEHOLDER)

    const readme = readFileSync(join(targetDir, 'README.md'), 'utf-8')
    expect(readme).not.toContain(PROJECT_NAME_PLACEHOLDER)

    const startScene = readFileSync(
      join(targetDir, 'src', 'scenes', 'StartScene.ts'),
      'utf-8',
    )
    expect(startScene).not.toContain(PROJECT_NAME_PLACEHOLDER)
    expect(startScene).toContain('星星收集')
  })

  it('rejects a displayName containing unsafe characters, even when name is valid', () => {
    const template = getTemplate('game-web-phaser')
    if (!template) throw new Error('game-web-phaser template not found in registry')

    const targetDir = join(tmpDir, 'unsafe-display-name')
    const result = scaffoldProject({
      targetDir,
      name: 'star',
      displayName: '<script>alert(1)</script>',
      template,
      packageManager: 'pnpm',
    })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('INVALID_NAME')
    // Validation must happen before any directory is created.
    expect(existsSync(targetDir)).toBe(false)
  })
})
