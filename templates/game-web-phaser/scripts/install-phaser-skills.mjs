#!/usr/bin/env node
// postinstall — copies node_modules/phaser/skills/* into
// ${HOME}/.config/shelley/ so Shelley (the coding agent running unattended
// in a VM) can see Phaser's 28 official skills instead of only its 7
// built-ins. Runs after every `pnpm install`, since that's the one moment
// node_modules/phaser/skills/ is guaranteed to exist and this template's
// postinstall is guaranteed to run.
//
// See scripts/lib/skill-injection.mjs for the pure logic (path derivation,
// the guard, the copy plan) and
// openspec/changes/phaser-skill-injection/design.md (D1-D4) in the
// AgentDock platform repo for the full rationale.
//
// 🔴 Guard: no-ops (exit 0, writes nothing) unless ${HOME}/.config/shelley
// already exists. On a developer's own machine that directory doesn't
// exist, so `pnpm install` there must not create it or write under $HOME —
// see tasks.md 3.2 for the real-machine no-op check this script has to
// satisfy.
//
// 🔴 This script does not "announce success" as the acceptance signal —
// design D4 is explicit that only `shelley skill ls` reading the result
// back counts. The console.log lines below are for a human skimming
// `pnpm install` output, not proof of anything.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveHome, resolveShelleyDir, shouldInject, listSkillDirNames, planCopy } from './lib/skill-injection.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function main() {
  const home = resolveHome(process.env)
  const shelleyDir = resolveShelleyDir(home)

  if (!shelleyDir) {
    // $HOME unset — cannot derive a path at all. Never fall back to a
    // hardcoded /root/.config or /.config (design D2).
    console.log('[install-phaser-skills] $HOME is not set — skipping')
    return
  }

  const shelleyDirExists = fs.existsSync(shelleyDir)
  if (!shouldInject({ home, shelleyDirExists })) {
    console.log(`[install-phaser-skills] ${shelleyDir} does not exist — not a Shelley environment, skipping`)
    return
  }

  // 🔴 Two sources, not one. The second was the whole point of writing a
  // skill of our own and is easy to forget:
  //
  //   1. node_modules/phaser/skills/  — Phaser's own 28 official skills
  //   2. <template>/skills/           — the skills THIS template ships
  //
  // Source 2 exists because the official 28 leave real gaps (HUD
  // architecture decision, level progression structure — there is no
  // official `level-progression` skill at all). Writing that file is not
  // enough: Shelley only ever reads ${HOME}/.config/shelley/<name>/SKILL.md,
  // so a skill that never gets copied there is a dead file. Verified
  // 2026-08-21 by string-scanning the shelley binary: it has no path
  // constants for scanning node_modules/*/skills, only its own config dir
  // and its 7 built-ins.
  const sources = [
    path.join(here, '..', 'node_modules', 'phaser', 'skills'),
    path.join(here, '..', 'skills'),
  ].filter((dir) => fs.existsSync(dir))

  if (sources.length === 0) {
    console.log('[install-phaser-skills] no skill source directory found — skipping')
    return
  }

  let injected = 0
  for (const skillsDir of sources) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    const names = listSkillDirNames(entries)

    for (const name of names) {
      const { src, dest } = planCopy({ phaserSkillsDir: skillsDir, shelleyDir, name })
      // Idempotent: drop any previous copy of this skill before re-copying,
      // so re-running `pnpm install` (or a Phaser version bump that changes a
      // skill's contents) never leaves stale files behind.
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(src, dest, { recursive: true })
      injected += 1
    }
  }

  console.log(`[install-phaser-skills] injected ${injected} skill(s) into ${shelleyDir}`)
}

main()
