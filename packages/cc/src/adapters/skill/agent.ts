import { publishSkill } from '../../core/skillPublish.js'
import { describeIndexFailure } from '../../core/registryIndex.js'
import { validateSkill } from '../../core/skillValidate.js'

export interface SkillValidateAgentOptions {
  dir: string
  silent?: boolean
  json?: boolean
}

export interface SkillPublishAgentOptions extends SkillValidateAgentOptions {
  registry: string
}

function emit(obj: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }
}

export async function runSkillValidateAgentAdapter(opts: SkillValidateAgentOptions): Promise<void> {
  const { dir, silent = false, json = false } = opts
  const output = json || silent

  if (!dir) {
    const err = { ok: false, error: 'MISSING_ARG', field: 'dir' }
    if (output) {
      emit(err, true)
    } else {
      console.error('Error: <dir> is required')
    }
    process.exit(1)
  }

  const result = await validateSkill(dir)

  if (output) {
    emit(result, true)
  } else if (result.ok) {
    console.log(`✓ ${dir} is a valid skill`)
    for (const warning of result.warnings) {
      console.log(`  ⚠ ${warning}`)
    }
  } else {
    console.error(`✗ ${dir} failed validation`)
    for (const error of result.errors) {
      console.error(`  - ${error}`)
    }
  }

  if (!result.ok) {
    process.exit(1)
  }
}

export async function runSkillPublishAgentAdapter(opts: SkillPublishAgentOptions): Promise<void> {
  const { dir, registry, silent = false, json = false } = opts
  const output = json || silent

  if (!dir) {
    const err = { ok: false, error: 'MISSING_ARG', field: 'dir' }
    if (output) {
      emit(err, true)
    } else {
      console.error('Error: <dir> is required')
    }
    process.exit(1)
  }

  if (!registry) {
    const err = { ok: false, error: 'MISSING_ARG', field: 'registry' }
    if (output) {
      emit(err, true)
    } else {
      console.error('Error: --registry is required')
    }
    process.exit(1)
  }

  const result = await publishSkill(dir, registry)

  if (output) {
    emit(result, true)
  } else if (result.ok) {
    const verb = result.updated ? 'Updated' : 'Added'
    console.log(`✓ ${verb} "${result.entry.id}" in ${result.manifestPath}`)
    // Always say where the entry points — never left implicit. It comes from
    // the skill's OWN repo, not necessarily the `--registry` checkout it was
    // just written into (see skillPublish.ts `publishSkill` doc comment).
    console.log(
      `  source: ${result.entry.source}${result.entry.path ? ` (path: ${result.entry.path})` : ''}`,
    )
    if (result.sourceRepoDiffersFromRegistry) {
      console.warn(
        `⚠⚠ This entry points at ${result.entry.source} — NOT your --registry checkout (${result.registrySource}). ` +
          'Anyone installing this skill must be able to `git clone` that repository — make sure it is public. ' +
          'Publishing from a private repo on purpose is fine, just know that is what happened here.',
      )
    }
    if (result.anonymous) {
      console.warn('⚠ Published anonymously — run `cc auth login` to sign your skills.')
    }
    if (result.versionMissing) {
      console.warn('⚠ Published without a version — add `metadata.version: <semver>` to SKILL.md.')
    }
    if (!result.indexed) {
      console.warn(
        result.anonymous
          ? '⚠ Not indexed into the registry hub — sign in first so this entry can be found there.'
          : `⚠ Could not index into the registry hub: ${describeIndexFailure(result.indexError)}`,
      )
    }
  } else {
    console.error(`✗ ${result.message}`)
    if (result.errors) {
      for (const error of result.errors) {
        console.error(`  - ${error}`)
      }
    }
  }

  if (!result.ok) {
    process.exit(1)
  }
}
