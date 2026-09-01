#!/usr/bin/env node
// check-template-playable.mjs — the factory-playable pre-release check.
//
// 🔴 WHY — since 2026-09-01 the game-web-phaser template ships a playable
// FLOOR (factory-playable: title page → real click → tutorial level → ending
// page → restart) and `pnpm build:play` inside a scaffolded project re-proves
// that floor through real input on every build (postbuild selfcheck). The
// half that was missing: nothing on the RELEASE path of @cogito.ai/cc proved
// the template still has that floor at the moment of publishing. A template
// edit that breaks the tutorial level would otherwise ride a green CI all the
// way to npm, and the next scaffolded project would be factory-BROKEN.
//
// So this script exercises the exact product path a user gets:
//   1. run the JUST-BUILT CLI (packages/cc/dist/index.js — the artifact
//      publish actually ships) with `cc init` into a fresh temp dir,
//   2. `pnpm install --frozen-lockfile` (a user's first install; lock drift
//      is a release defect too),
//   3. `pnpm build:play` — whose postbuild selfcheck drives real headless
//      Chromium: real click on 开始游戏, real keyboard through level 1 to the
//      goal, pixel-asserted Start/GameOver copy, back-to-title. 8 steps,
//      no applyState shortcuts.
// Any step red → this script exits non-zero → the release workflow must not
// publish. Requires a Chromium on the machine (same discovery as the
// template's find-browser.mjs: Playwright cache / CHROME_PATH / PATH).
//
// Run: `pnpm check:template` from the repo root (after `pnpm build`).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cc', 'dist', 'index.js')
const PROJECT_NAME = 'factory-playable-check'

function fail(message) {
  console.error(`[check-template-playable] FAIL — ${message}`)
  process.exit(1)
}

if (!existsSync(CLI_ENTRY)) {
  fail(`${CLI_ENTRY} not found — run \`pnpm build\` first (this check must exercise the built artifact, not tsx sources)`)
}

const workdir = mkdtempSync(join(tmpdir(), 'cc-factory-check-'))
const projectDir = join(workdir, PROJECT_NAME)

const run = (label, command, args, opts = {}) => {
  process.stdout.write(`[check-template-playable] ${label}...\n`)
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
    ...opts.spawn,
  })
  if (result.status !== 0) {
    fail(`${label} exited ${result.status} — the factory-playable floor is broken on the release path; do not publish @cogito.ai/cc`)
  }
}

try {
  // 1. cc init — the real scaffold path, into a directory that did not exist
  run(
    `cc init ${PROJECT_NAME} (fresh dir, zero AI participation)`,
    process.execPath,
    [CLI_ENTRY, 'init', '--name', PROJECT_NAME, '--template', 'game-web-phaser', '--dir', projectDir, '--silent', '--pm', 'pnpm'],
  )

  // 2. a user's first install — frozen: lock drift is a release defect
  run('pnpm install --frozen-lockfile', 'pnpm', ['install', '--frozen-lockfile'], { cwd: projectDir })

  // 3. build + the full-journey selfcheck (real click, real keyboard, pixels)
  run('pnpm build:play (includes the 8-step selfcheck)', 'pnpm', ['build:play'], { cwd: projectDir })

  console.log(`[check-template-playable] PASS — scaffolded from the built CLI, installed frozen, and the full journey (Start → real click → tutorial level → goal → GameOver → back to title) played green in headless Chromium.`)
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
