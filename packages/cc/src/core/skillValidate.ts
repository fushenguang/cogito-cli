import { validate } from 'skills-ref'

/**
 * Validation rules are entirely delegated to `skills-ref` (the official Agent
 * Skills reference implementation) — this module does not implement any
 * SKILL.md rule of its own. See openspec/changes/cli-skill-publish/design.md §3.
 */

/**
 * `skills-ref` returns a flat `string[]` with no error/warning classification
 * (see recon.md 0.1 — `validateMetadataFields` is an internal, unexported
 * function). Messages starting with this exact prefix are downgraded to
 * warnings per design.md §3.1 ("方案甲"): the host's L2 convention is to move
 * non-spec top-level keys into `metadata:`, and v0 only reports this, it does
 * not block publish on it.
 *
 * ⚠️ This constant is intentionally coupled to the upstream message text. If
 * `skills-ref` changes the wording, the downgrade stops matching and the
 * error falls back to "hard" (fail-closed — see design.md §3.1). The test
 * pinning this string is what makes that drift loud instead of silent.
 */
export const UNKNOWN_FIELDS_PREFIX = 'Unexpected fields in frontmatter:'

export interface SkillValidateResult {
  ok: true
  warnings: string[]
}

export interface SkillValidateError {
  ok: false
  error: 'SKILL_INVALID'
  errors: string[]
}

/**
 * Validates a skill directory against the Agent Skills spec via `skills-ref`.
 *
 * Pure: does not write stdout, does not call `process.exit`. Callers (agent /
 * human adapters) own presentation and process exit codes.
 */
export async function validateSkill(
  dir: string,
): Promise<SkillValidateResult | SkillValidateError> {
  const errors = await validate(dir)

  const warnings = errors.filter((e) => e.startsWith(UNKNOWN_FIELDS_PREFIX))
  const hard = errors.filter((e) => !e.startsWith(UNKNOWN_FIELDS_PREFIX))

  if (hard.length > 0) {
    return { ok: false, error: 'SKILL_INVALID', errors: hard }
  }

  return { ok: true, warnings }
}

/**
 * Pulls the offending top-level field names out of `skills-ref`'s
 * "Unexpected fields in frontmatter: <a>, <b>. Only <allowed> are allowed."
 * message, so `publish` can record them explicitly on the manifest entry
 * (design.md §3.1 附带要求 — never silently swallow a downgraded field).
 *
 * This does NOT hardcode the set of allowed keys (that was the rejected
 * "方案乙" — see recon.md open decision). It only parses the field names back
 * out of skills-ref's own diff. If the message format ever changes such that
 * this regex stops matching, the raw warning text is kept as-is rather than
 * dropped, so the signal is never lost even if it becomes less structured.
 */
export function extractNonSpecFields(warnings: string[]): string[] {
  const pattern = /^Unexpected fields in frontmatter: ([^.]+)\./
  const fields = new Set<string>()

  for (const warning of warnings) {
    const match = pattern.exec(warning)
    const captured = match?.[1]
    if (captured) {
      for (const field of captured.split(',')) {
        const trimmed = field.trim()
        if (trimmed) fields.add(trimmed)
      }
    } else {
      fields.add(warning)
    }
  }

  return [...fields]
}
