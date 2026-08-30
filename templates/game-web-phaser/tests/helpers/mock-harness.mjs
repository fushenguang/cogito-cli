// A pure-JS stand-in for `window.__gameHarness` (the `GameHarness` shape from
// `src/debug/harness-types.ts`), used only by tests/assert.test.mjs to drive
// scripts/assert.mjs's judge functions without a real browser or Phaser
// instance. This is NOT a general Phaser simulator — each test configures
// only the narrow slice of behaviour it needs via the `on*` hooks below.
//
// It implements the exact method surface `scripts/assert.mjs`'s `RemoteHarness`
// exposes (`listStates/listTriggers/applyState/getSnapshot/press/fire/wait`,
// plus `exists`/`version` for the top-level `runAssertions()` gate), so a
// judge function or `runAssertions()` cannot tell this apart from the real
// CDP-backed transport.

export class MockHarness {
  constructor({
    states = [],
    triggers = [],
    entities = [],
    hudTexts = [],
    values = {},
    score = 0,
    // game-data-spine: the `data` evidence `judgeDataFromFiles` reads.
    // Default null = "never declared a data layer" (the V2 pure-code shape);
    // tests for the other two gaps pass partial three-layer snapshots.
    data = null,
    keyTable = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyR']),
    exists = true,
    version = 1,
    onApplyState, // (id, self) => boolean | undefined — return false to simulate isValidStart() rejecting it
    onPress, // (key, self) => void — mutate entities/hudTexts/score as the test needs
    onFire, // (trigger, self) => void
  } = {}) {
    this.states = states
    this.triggerSet = new Set(triggers)
    this.entities = entities.map((e) => ({ ...e }))
    this.hudTexts = [...hudTexts]
    this.values = { ...values }
    this.score = score
    this.data = data
    this.stateId = states[0]?.id ?? ''
    this.keyTable = keyTable
    this._exists = exists
    this._version = version
    this.onApplyStateHook = onApplyState
    this.onPressHook = onPress
    this.onFireHook = onFire
    /** Every call made against this mock, in order — assertable by tests that care about *how* a judge drove the harness, not just the outcome. */
    this.calls = []
  }

  async exists() {
    return this._exists
  }

  async version() {
    return this._version
  }

  async listStates() {
    return this.states
  }

  async listTriggers() {
    return [...this.triggerSet]
  }

  async applyState(id) {
    this.calls.push({ fn: 'applyState', id })
    if (!this.states.some((s) => s.id === id)) return false
    if (this.onApplyStateHook) {
      const ok = this.onApplyStateHook(id, this)
      if (ok === false) return false
    }
    this.stateId = id
    return true
  }

  async getSnapshot() {
    return {
      stateId: this.stateId,
      score: this.score,
      entities: this.entities.map((e) => ({ ...e })),
      hudTexts: [...this.hudTexts],
      values: { ...this.values },
      data: this.data,
    }
  }

  async press(key, opts) {
    this.calls.push({ fn: 'press', key, opts })
    if (!this.keyTable.has(key)) {
      throw new Error(`harness.press: unknown key "${key}" (not in KEY_TABLE)`)
    }
    if (this.onPressHook) this.onPressHook(key, this)
  }

  async fire(trigger) {
    this.calls.push({ fn: 'fire', trigger })
    if (!this.triggerSet.has(trigger)) {
      throw new Error(`harness.fire: unknown trigger "${trigger}" (not in listTriggers())`)
    }
    if (this.onFireHook) this.onFireHook(trigger, this)
  }

  async wait(ms) {
    this.calls.push({ fn: 'wait', ms })
  }
}

/**
 * A slightly richer preset that mimics this template's actual reference
 * implementation closely enough to exercise design D6's order-independence
 * property and D5's precondition-vs-defect distinction realistically:
 * two states (Game/gameplay, GameOver/gameover), a player entity, a score
 * HUD text, two triggers ('score'/'gameover'), and a `highScore` value that
 * — like the real GameScene — persists across `applyState()` and restart,
 * unlike `score` which always resets to 0.
 */
export function createReferenceLikeHarness() {
  const harness = new MockHarness({
    states: [
      { id: 'Game', role: 'gameplay' },
      { id: 'GameOver', role: 'gameover' },
    ],
    triggers: ['score', 'gameover'],
    keyTable: new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyR']),
    // What the real reference implementation's evidence looks like after one
    // GameScene build: the manifest declares level-1 + rules, PreloadScene
    // initialized the loader (loaded = declared), and the scene build took
    // both through the accessors (usedInScene = declared).
    data: {
      declared: [
        { id: 'levels:level-1', section: 'levels' },
        { id: 'rules', section: 'rules' },
      ],
      loaded: [
        { id: 'levels:level-1', section: 'levels' },
        { id: 'rules', section: 'rules' },
      ],
      usedInScene: [
        { id: 'levels:level-1', section: 'levels' },
        { id: 'rules', section: 'rules' },
      ],
    },
  })
  harness.highScore = 0

  const resetToGame = (self) => {
    self.stateId = 'Game'
    self.score = 0
    self.entities = [{ name: 'player', x: 200, y: 400 }]
    self.hudTexts = [`Score: ${self.score}`]
    self.values = { highScore: self.highScore }
  }
  const switchToGameOver = (self) => {
    self.stateId = 'GameOver'
    self.entities = []
    self.hudTexts = ['Game Over', `Score: ${self.score}`, 'Press R to restart']
    self.values = { highScore: self.highScore }
  }
  const bumpScore = (self) => {
    self.score += 1
    self.highScore = Math.max(self.highScore, self.score)
    self.hudTexts = [`Score: ${self.score}`]
    self.values = { highScore: self.highScore }
  }

  harness.onApplyStateHook = (id, self) => {
    if (id === 'Game') resetToGame(self)
    else if (id === 'GameOver') switchToGameOver(self)
  }
  harness.onPressHook = (key, self) => {
    if (key === 'ArrowRight' && self.stateId === 'Game') {
      self.entities = self.entities.map((e) => (e.name === 'player' ? { ...e, x: e.x + 10 } : e))
    } else if (key === 'Space' && self.stateId === 'Game') {
      bumpScore(self)
    } else if (key === 'KeyR') {
      resetToGame(self) // both GameScene's `scene.restart()` and GameOverScene's `keydown-R` land here
    }
  }
  harness.onFireHook = (trigger, self) => {
    if (trigger === 'score' && self.stateId === 'Game') bumpScore(self)
    else if (trigger === 'gameover' && self.stateId === 'Game') switchToGameOver(self)
  }

  // Establish the initial snapshot the same way applyState('Game') would.
  resetToGame(harness)
  return harness
}
