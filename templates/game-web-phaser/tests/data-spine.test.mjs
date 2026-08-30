// Structural tests for the data spine (game-data-spine spec's own
// review-criteria scenarios, mechanized). The spec says the reference
// implementation's scene classes must contain NO per-level content
// constants — that is literally a source-review criterion ("WHEN 审查参考
//实现的场景类 THEN 找不到逐关卡的内容常量"), so scanning the source is the
// honest form of the test, not a workaround. If one of these breaks because
// you added content back into a scene class, move the content to
// public/game-data.json — do not weaken the test.
//
// The built-artifact halves of these claims ("干净安装 8/8 全绿",
// "换数据即换关 on the real build") are covered by `pnpm verify` on the
// template itself — see AGENTS.md's acceptance checklist.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAndValidateGameData } from '../src/game-data.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (relative) => readFileSync(join(__dirname, '..', relative), 'utf-8')

test('clean install ships a usable data layer: public/game-data.json exists and passes strict validation', () => {
  const manifest = parseAndValidateGameData(read('public/game-data.json'))
  assert.ok(manifest.levels.length > 0, 'the template must ship at least one real level, not an empty shell')
  assert.ok(manifest.rules, 'the reference scene consumes rules, so the template ships them')
})

test('GameScene has no per-level content constants — it is an interpreter, not a data file (spec scenario)', () => {
  const source = read('src/scenes/GameScene.ts')
  // Content that used to live here as constants, moved to game-data.json by
  // this change. If a forbidden pattern matches, content crept back into
  // the interpreter — the trial-09 shape (3985 lines, 0 data files).
  const forbidden = [
    /const PLAYER_SPEED/,
    /const BULLET_SPEED/,
    /const LEVEL_NUMBER/,
    /PLAYER_SPEED\s*=\s*\d/,
    /BULLET_SPEED\s*=\s*\d/,
    /PLAYFIELD_HEIGHT - 80/, // the old hardcoded player spawn
    /GAME_WIDTH \/ 2,\s*PLAYFIELD_HEIGHT/, // the old hardcoded spawn pair
    /setVelocityX\(-?\d/, // a speed literal would defeat rules.playerSpeed
  ]
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `GameScene.ts must not contain content constant matching ${pattern} — level content belongs in public/game-data.json`)
  }
  // And the scene must actually be wired to the data layer.
  assert.match(source, /from '\.\.\/game-data'/)
  assert.match(source, /getActiveLevel\(\)/)
  assert.match(source, /this\.rules\.playerSpeed/)
  assert.match(source, /this\.level\.playerSpawn/)
  assert.match(source, /this\.level\.initialCoins/)
})

test('PreloadScene initializes the data layer at load time — the required-manifest contract, not the optional game-assets one', () => {
  const source = read('src/scenes/PreloadScene.ts')
  assert.match(source, /this\.load\.text\(GAME_DATA_RAW_CACHE_KEY/)
  assert.match(source, /initGameData\(/)
})

test('harness exposes the data evidence read-only: buildSnapshot derives it from the cache + module registry', () => {
  const source = read('src/debug/harness.ts')
  assert.match(source, /data: readDataUsage\(game\)/)
  const types = read('src/debug/harness-types.ts')
  assert.match(types, /readonly data: DataUsageSnapshot \| null/)
  // No setter ever: the only game-data import in harness.ts is the pure
  // evidence builder — not initGameData, not any accessor.
  assert.ok(!/initGameData|getActiveLevel|getGameRules/.test(source), 'harness.ts must not consume or initialize the data layer itself')
})
