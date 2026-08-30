import type Phaser from 'phaser'
import type { GameDoc } from './game-doc.ts'
import { resolveLevelDoc } from './game-doc.ts'

/**
 * In-game documentation panel — the DOM half of the feature whose Phaser
 * half (the entry button) lives in `./scenes/UiScene.ts`. See
 * `./game-doc.ts`'s header doc for *why* this exists: a human reviewer
 * deciding "is this game good" needs the game's premise, controls, and
 * current-build scope in hand before that judgement means anything, and a
 * README in the repo is not somewhere a player looks.
 *
 * 🔴 DOM overlay, not Phaser GameObjects, on purpose. The content this
 * renders (background story, a controls list, per-level notes, a
 * not-doing list) is prose a player scrolls and reads, not game HUD —
 * Phaser's Text objects have no text wrapping/scrolling worth using for
 * this, and building it that way would mean re-implementing basic
 * document layout on top of a canvas. `debug/panel.ts` already establishes
 * the "create your own container node, don't rely on markup in
 * index.html" pattern this follows — same reasoning: index.html must not
 * carry a trace of build-target-specific or feature-specific markup that
 * isn't there unconditionally.
 *
 * Unlike `debug/panel.ts`, this is NOT build-mode-gated — it's a
 * player-facing feature meant to ship in `build:play` too (see
 * `src/main.ts`), so it always mounts when `game-doc.json` is present.
 */

const OVERLAY_ID = 'game-doc-overlay'

/**
 * Full-viewport mask CSS for the overlay backdrop — pulled out to a named
 * constant (rather than inlined into `buildOverlay()`) specifically so
 * `tests/doc-panel.test.mjs` can assert on it as a string: that's the
 * "面板打开时全屏遮罩" half of this change's placement contract (the other
 * half, the closed-state button staying inside the HUD band, is
 * `doc-panel-geometry.ts`'s job). A real DOM/layout assertion would need a
 * browser; this is the honest bare-Node substitute — see that test file's
 * header comment for the trade-off.
 */
export const DOC_OVERLAY_STYLE = [
  'position:fixed',
  'inset:0',
  'top:0',
  'left:0',
  'width:100%',
  'height:100%',
  'z-index:2000',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'background:rgba(10,11,18,0.82)',
  'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
].join(';')

let overlayEl: HTMLDivElement | null = null
let activeGame: Phaser.Game | null = null
let pausedLevelKey: string | null = null

/** True while the panel is on screen — lets `UiScene` avoid stacking a second open() on top of an already-open one. */
export function isDocPanelOpen(): boolean {
  return overlayEl !== null
}

/**
 * Opens the panel for `doc`/`levelKey`, and pauses the gameplay scene
 * `levelKey` names so a player can't keep moving/falling while reading —
 * see `./scenes/GameScene.ts`'s class doc for why "the player got hurt
 * while the panel covered the screen" is exactly the kind of bug this
 * template's other structural fixes exist to prevent. `closeDocPanel()` is
 * the only path back; it resumes the same scene.
 *
 * Idempotent: calling this while already open is a no-op (does not
 * re-pause / stack a second overlay).
 */
export function openDocPanel(game: Phaser.Game, doc: GameDoc, levelKey: string): void {
  if (overlayEl) return

  activeGame = game
  pausedLevelKey = levelKey
  // A Scene that isn't currently running (e.g. the harness jumped
  // elsewhere) is a documented no-op for pause()/resume() — safe to call
  // unconditionally.
  game.scene.pause(levelKey)

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.style.cssText = DOC_OVERLAY_STYLE
  overlay.addEventListener('click', (event) => {
    // Click on the backdrop (not the card itself) closes — a common,
    // discoverable dismiss gesture that needs no reading ability.
    if (event.target === overlay) closeDocPanel()
  })

  overlay.appendChild(buildCard(doc, levelKey))
  document.body.appendChild(overlay)
  overlayEl = overlay

  document.addEventListener('keydown', onKeyDown)
}

/** Closes the panel (if open) and resumes whichever scene `openDocPanel()` paused. */
export function closeDocPanel(): void {
  if (!overlayEl) return

  overlayEl.remove()
  overlayEl = null
  document.removeEventListener('keydown', onKeyDown)

  if (activeGame && pausedLevelKey) {
    activeGame.scene.resume(pausedLevelKey)
  }
  activeGame = null
  pausedLevelKey = null
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeDocPanel()
}

/**
 * The scrollable white card inside the backdrop. Font sizes and structure
 * here follow AGENTS.md's brief for this change directly: large type, flat
 * sections (no accordions/nested collapsing) — this is a document a child
 * reads once before or during play, not a settings UI.
 */
function buildCard(doc: GameDoc, levelKey: string): HTMLDivElement {
  const level = resolveLevelDoc(doc, levelKey)

  const card = document.createElement('div')
  card.style.cssText = [
    'background:#f8fafc',
    'color:#111827',
    'width:min(640px, 92vw)',
    'max-height:min(720px, 88vh)',
    'overflow-y:auto',
    'border-radius:20px',
    'padding:28px 28px 32px',
    'box-shadow:0 20px 60px rgba(0,0,0,0.45)',
    'box-sizing:border-box',
  ].join(';')

  card.appendChild(buildHeader(doc.title))
  card.appendChild(buildSection('游戏背景', paragraph(doc.background)))
  card.appendChild(buildSection('怎么玩', buildHowToPlay(doc.controls, doc.overallGoal)))
  card.appendChild(buildSection(`当前这一关：${level.name}`, paragraph(level.goal)))
  card.appendChild(buildSection('这个版本还没有做的事', buildList(doc.notDoing)))

  return card
}

function buildHeader(title: string): HTMLDivElement {
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:8px'

  const heading = document.createElement('h1')
  heading.textContent = title
  heading.style.cssText = 'margin:0;font-size:26px;line-height:1.3;font-weight:700;color:#111827'

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '✕'
  closeButton.setAttribute('aria-label', '关闭说明')
  closeButton.style.cssText = [
    'flex:0 0 auto',
    'width:44px',
    'height:44px',
    'border-radius:12px',
    'border:none',
    'background:#e5e7eb',
    'color:#111827',
    'font-size:20px',
    'line-height:1',
    'cursor:pointer',
  ].join(';')
  closeButton.addEventListener('click', () => closeDocPanel())

  header.appendChild(heading)
  header.appendChild(closeButton)
  return header
}

function buildSection(heading: string, body: HTMLElement): HTMLDivElement {
  const section = document.createElement('div')
  section.style.cssText = 'margin-top:22px'

  const h2 = document.createElement('h2')
  h2.textContent = heading
  h2.style.cssText = 'margin:0 0 8px;font-size:19px;font-weight:700;color:#1f2937'

  section.appendChild(h2)
  section.appendChild(body)
  return section
}

function buildHowToPlay(controls: readonly string[], overallGoal: string): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.appendChild(buildList(controls))
  wrapper.appendChild(paragraph(overallGoal))
  return wrapper
}

function buildList(items: readonly string[]): HTMLUListElement {
  const list = document.createElement('ul')
  list.style.cssText = 'margin:0 0 10px;padding-left:22px;font-size:18px;line-height:1.7;color:#1f2937'
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item
    list.appendChild(li)
  }
  return list
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement('p')
  p.textContent = text
  p.style.cssText = 'margin:0;font-size:18px;line-height:1.7;color:#1f2937'
  return p
}
