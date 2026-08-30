import Phaser from 'phaser'
import { gameConfig } from './config'
import { installHarness } from './debug/harness'

const game = new Phaser.Game(gameConfig)

// installHarness() runs unconditionally — in build:play AND build:learn.
// Unlike the debug panel below, `window.__gameHarness` is not gated on
// `import.meta.env.MODE`: ia-assertion-runner design D3 requires that the
// IA verification layer judge the exact artifact that ships, and letting
// the two build targets diverge here would let a real bug hide in whichever
// build the runner isn't looking at. See src/debug/harness.ts's module doc
// for the full trade-off writeup — the thing that keeps a public
// `window.__gameHarness` acceptable is its read-only/player-reachable API
// shape (design D3's allow/forbid table), not hiding it from one build.
installHarness(game)

// The debug panel is a build-target-gated feature, not a runtime switch —
// see src/debug/panel.ts and vite.config.ts's `build.outDir` branch (design
// D6). `import.meta.env.MODE` is a compile-time constant Vite substitutes
// per `--mode` flag (see package.json's build:play/build:learn scripts), so
// in a `build:play` bundle this whole branch — including the dynamic
// import — is dead code a player has no way to turn on from the browser.
if (import.meta.env.MODE === 'learn') {
  void import('./debug/panel').then(({ mountDebugPanel }) => mountDebugPanel())
}
