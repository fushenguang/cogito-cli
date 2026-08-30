import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, it, expect, afterEach } from 'vitest'
import { validateSkill, extractNonSpecFields, UNKNOWN_FIELDS_PREFIX } from '../skillValidate.js'

function makeSkillDir(name: string, frontmatter: string): string {
  const dir = join(
    tmpdir(),
    `cogito-skill-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n\nBody.\n`, 'utf-8')
  return dir
}

describe('validateSkill', () => {
  let dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      try {
        rmSync(join(dir, '..'), { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    dirs = []
  })

  it('returns ok:true with no warnings for a fully spec-compliant skill', async () => {
    const dir = makeSkillDir('valid-skill', 'name: valid-skill\ndescription: A valid test skill.')
    dirs.push(dir)

    const result = await validateSkill(dir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([])
    }
  })

  // ★ Pinned per task instruction: skills-ref's exact "Unexpected fields in
  // frontmatter:" message text is the fail-closed hinge design.md §3.1 relies
  // on to downgrade non-spec top-level keys to warnings instead of hard
  // errors. If skills-ref ever changes this wording, THIS test goes red
  // instead of the downgrade silently stopping working (which would flip
  // publish's behavior from "warn" to "reject lesson-prep").
  it('downgrades "Unexpected fields in frontmatter:" to a warning, not a hard error', async () => {
    // Mirrors the real lesson-prep sample (thefoolai apps/electron-app/SKILLs/lesson-prep):
    // valid name/description plus a non-spec top-level `pipeline` key.
    const dir = makeSkillDir(
      'pipeline-skill',
      [
        'name: pipeline-skill',
        'description: A test skill with a non-spec top-level key.',
        'pipeline:',
        '  post_processor: md2pptx',
      ].join('\n'),
    )
    dirs.push(dir)

    const result = await validateSkill(dir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain(UNKNOWN_FIELDS_PREFIX)
      expect(result.warnings[0]).toContain('pipeline')
    }
  })

  it('returns ok:false with SKILL_INVALID for a genuinely broken skill (missing required field)', async () => {
    const dir = makeSkillDir('broken-skill', 'description: Missing the name field.')
    dirs.push(dir)

    const result = await validateSkill(dir)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('SKILL_INVALID')
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.some((e) => e.includes('name'))).toBe(true)
    }
  })

  it('returns ok:false when SKILL.md is missing entirely', async () => {
    const dir = join(
      tmpdir(),
      `cogito-skill-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'no-skill-md',
    )
    mkdirSync(dir, { recursive: true })
    dirs.push(dir)

    const result = await validateSkill(dir)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('SKILL_INVALID')
      expect(result.errors.some((e) => e.includes('SKILL.md'))).toBe(true)
    }
  })
})

describe('extractNonSpecFields', () => {
  it('parses a single offending field out of the skills-ref message', () => {
    const warnings = [
      'Unexpected fields in frontmatter: pipeline. Only allowed-tools, compatibility, description, license, metadata, name are allowed.',
    ]

    expect(extractNonSpecFields(warnings)).toEqual(['pipeline'])
  })

  it('parses multiple comma-separated offending fields', () => {
    const warnings = [
      'Unexpected fields in frontmatter: extra, pipeline. Only allowed-tools, compatibility, description, license, metadata, name are allowed.',
    ]

    expect(extractNonSpecFields(warnings)).toEqual(['extra', 'pipeline'])
  })

  it('falls back to the raw warning text when the format is unrecognized (never drops the signal)', () => {
    const warnings = ['Some future differently-worded warning about foo']

    expect(extractNonSpecFields(warnings)).toEqual([
      'Some future differently-worded warning about foo',
    ])
  })

  it('returns an empty array for no warnings', () => {
    expect(extractNonSpecFields([])).toEqual([])
  })
})
