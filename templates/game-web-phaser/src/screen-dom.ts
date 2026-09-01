import type Phaser from 'phaser'
import type { GameDoc } from './game-doc.ts'
import { resolveScreens, resolveTheme, type GameDocScreens, type GameDocTheme } from './game-doc.ts'

/**
 * Fixed auxiliary pages (Start / GameOver / Settings) as a DOM overlay —
 * issue #11 (2026-09-01), the structural fix for the 小小财迷 M1 verdict
 * ("开始页无文字、结束页三色块"): these pages are TEMPLATE-owned
 * infrastructure driven by `game-doc.json`, never AI-authored per project,
 * and their critical copy renders through the browser's DOM text pipeline
 * instead of Phaser Text.
 *
 * 🔴 Why DOM and not Phaser Text/BitmapText, recorded 2026-09-01:
 *
 *  - Measured on this template's own scaffold (macOS chrome-headless-shell,
 *    Playwright 1234, Phaser 4.2.1): Phaser Text rendered BOTH Latin and CJK
 *    fine — the old note "Phaser Text 在 headless 不出像素" (which a prior
 *    run treated as a license not to investigate) is NOT supported here. The
 *    honest statement is narrower: Phaser Text depends on the whole
 *    Canvas2D→texture-upload chain AND on the running environment's font
 *    coverage, and the 小小财迷 text failure was never diagnosed in the
 *    environment that shipped it. DOM text is the browser's primary text
 *    pipeline — one dependency fewer — and `scripts/selfcheck.mjs`
 *    pixel-asserts it in the REAL delivery environment on every build.
 *  - BitmapText (the classic offline-safe alternative) needs a pre-rendered
 *    glyph atlas; there is no sane CJK atlas at scaffold size, and rule 4
 *    (AGENTS.md) forbids shipping font files.
 *  - DOM buttons give real hit targets, hover/focus states and keyboard
 *    activation for free.
 *
 * `src/doc-panel.ts` established the "create your own container node, don't
 * rely on markup in index.html" pattern this follows; this module keeps the
 * same discipline (index.html stays feature-free), with the addition that
 * every interactive element carries a `data-cogito="<role>"` attribute —
 * that stable selector is what `scripts/verify.mjs`'s FD gate and
 * `scripts/selfcheck.mjs` click, so the front door is always the real
 * button, never a guessed coordinate.
 *
 * Page composition follows the official examples this template's docs index
 * catalogs (see ../../docs/phaser-examples-pattern-index.md at the cogito-cli
 * repo root):
 *  - title / subtitle / start-prompt layout roles —
 *    phaserdeno/games/mars/scenes/splash.ts (官方书《Mars》标题页)
 *  - score read from the shared registry + "restart" and "back to title"
 *    as two separate exits — phaserdeno/games/runner/scenes/gameover.ts and
 *    examples/public/src/games/my first game/scenes/GameOver.js
 *    (`input.once('pointerdown') => scene.start('MainMenu')`)
 *  - settings/mute as a small in-page panel — the same role
 *    `src/scenes/UiScene.ts`'s `mountMuteToggle()` plays during gameplay.
 */

/** Stable selectors the verification scripts click / assert on. */
export const SCREENS_HOST_ID = 'cogito-screens'
export const DATA_COGITO = 'data-cogito'
/** Values of `data-cogito`: one per interactive element the pages expose. */
export const SCREEN_BUTTON_ROLES = [
  'start',
  'settings',
  'settings-close',
  'mute',
  'retry',
  'back-title',
] as const
/** `data-cogito-result` value on the GameOver host — `cleared` vs `lost`. */
export const RESULT_ATTR = 'data-cogito-result'
/**
 * `data-cogito-copy` — stable locator for the CRITICAL copy nodes
 * (`scripts/selfcheck.mjs` screenshot-rects these headings for its pixel
 * assertion, and `scripts/verify.mjs`'s FD gate could not hit a guessed
 * coordinate). Roles: 'start-title' / 'gameover-title'.
 */
export const COPY_ATTR = 'data-cogito-copy'

/** Theme + copy both resolved (defaults filled) — what every mount fn below takes. */
export interface ScreenOptions {
  readonly doc: GameDoc | null
}

let hostEl: HTMLDivElement | null = null

function ensureHost(): HTMLDivElement {
  if (hostEl !== null && document.body.contains(hostEl)) return hostEl
  hostEl = document.createElement('div')
  hostEl.id = SCREENS_HOST_ID
  // Full-viewport, above the canvas (doc-panel uses z-index 2000; screens
  // sit just under it so the doc panel stays reachable on top).
  hostEl.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1500',
    // The host itself never eats clicks — only its screen containers do.
    'pointer-events:none',
    'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    'user-select:none',
  ].join(';')
  document.body.appendChild(hostEl)
  return hostEl
}

/**
 * Screen-teardown handle. The mounting scene OWNS calling this on its
 * SHUTDOWN event (`this.events.once(Phaser.Scenes.Events.SHUTDOWN, teardown)`)
 * — same ownership discipline as GameScene's UI-scene stop — so a page can
 * never outlive the scene that mounted it. This module stays free of a
 * value-level Phaser import on purpose (only the doc/`scene.sound` types
 * below reference it), keeping its pure helpers cheap to unit-test.
 */
export type ScreenTeardown = () => void

function el<K extends 'div' | 'button'>(tag: K, styles: string): HTMLElement {
  const node = document.createElement(tag)
  node.style.cssText = styles
  return node
}

/** Flex-centered full-screen page container with the themed backdrop. */
function pageBackdrop(theme: Required<GameDocTheme>): HTMLElement {
  const page = el('div', [
    'position:absolute',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:18px',
    'pointer-events:auto',
    // Slight translucency so the flat canvas background (issue #10) shows
    // through — the page is "over the game", not "instead of the game".
    `background:${theme.backdrop}f2`,
  ].join(';'))
  return page
}

/** Themed heading (`data-hud-text` so harness/selfcheck can read it). */
function heading(
  text: string,
  theme: Required<GameDocTheme>,
  fontSize: string,
  copyRole?: string,
): HTMLElement {
  const node = el('div', [
    `color:${theme.heading}`,
    `font-size:${fontSize}`,
    'font-weight:700',
    'letter-spacing:2px',
    'margin:0',
    'text-align:center',
  ].join(';'))
  if (copyRole !== undefined) node.setAttribute(COPY_ATTR, copyRole)
  node.setAttribute('data-hud-text', text)
  node.textContent = text
  return node
}

/** Themed secondary line. */
function subline(text: string, theme: Required<GameDocTheme>): HTMLElement {
  const node = el('div', [`color:${theme.text}`, 'font-size:17px', 'margin:0', 'text-align:center'].join(';'))
  node.setAttribute('data-hud-text', text)
  node.textContent = text
  return node
}

/** Themed primary button carrying its stable `data-cogito` role. */
function primaryButton(label: string, role: string, theme: Required<GameDocTheme>): HTMLButtonElement {
  const button = el('button', [
    `background:${theme.accent}`,
    `color:${theme.accentText}`,
    'border:none',
    'border-radius:10px',
    'padding:12px 44px',
    'font-size:20px',
    'font-weight:700',
    'cursor:pointer',
    'font-family:inherit',
  ].join(';')) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute(DATA_COGITO, role)
  button.setAttribute('data-hud-text', label)
  button.textContent = label
  return button
}

/** Small secondary (ghost) button. */
function ghostButton(label: string, role: string, theme: Required<GameDocTheme>): HTMLButtonElement {
  const button = el('button', [
    'background:transparent',
    `color:${theme.text}`,
    `border:1px solid ${theme.text}66`,
    'border-radius:10px',
    'padding:10px 28px',
    'font-size:15px',
    'cursor:pointer',
    'font-family:inherit',
  ].join(';')) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute(DATA_COGITO, role)
  button.setAttribute('data-hud-text', label)
  button.textContent = label
  return button
}

export interface StartScreenInput extends ScreenOptions {
  /** The game-level SoundManager the mute toggle flips (`scene.sound`). */
  readonly sound: Phaser.Sound.BaseSoundManager
  /** Called from the real pointer gesture — the one moment BGM may start (autoplay policy, AGENTS.md rule 8). */
  readonly onStart: () => void
}

/**
 * The Start page: title (project display name), subtitle, controls list,
 * 开始游戏 (primary), 设置 (opens the settings panel). Layout roles mirror
 * mars/splash.ts; the start-prompt as an explicit button (rather than
 * "press SPACE") keeps the front door a single, clickable, pixel-visible
 * target for the FD gate and selfcheck.
 */
export function mountStartScreen(input: StartScreenInput): ScreenTeardown {
  const screens = resolveScreens(input.doc)
  const theme = resolveTheme(input.doc)
  const host = ensureHost()
  const page = pageBackdrop(theme)

  page.appendChild(heading(screens.startTitle, theme, '44px', 'start-title'))
  page.appendChild(subline(screens.startSubtitle, theme))

  // Controls list — the same `doc.controls` the in-game doc panel shows,
  // surfaced up front so a first-time player never needs the panel to move.
  if (input.doc !== null) {
    const list = el('div', [`color:${theme.text}`, 'font-size:15px', 'line-height:1.9', 'margin:0', 'opacity:0.9'].join(';'))
    for (const line of input.doc.controls) {
      const item = document.createElement('div')
      item.textContent = line
      item.setAttribute('data-hud-text', line)
      list.appendChild(item)
    }
    page.appendChild(list)
  }

  const startButton = primaryButton(screens.startButton, 'start', theme)
  startButton.addEventListener('pointerdown', () => input.onStart())
  page.appendChild(startButton)

  const settingsButton = ghostButton(screens.settingsButton, 'settings', theme)
  page.appendChild(settingsButton)

  // ── Settings panel (hidden until 设置 is clicked) ─────────────────────
  const settingsPanel = el('div', [
    'position:absolute',
    'inset:0',
    'display:none',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:16px',
    'pointer-events:auto',
    `background:${theme.backdrop}fa`,
  ].join(';'))
  settingsPanel.appendChild(heading(screens.settingsTitle, theme, '30px'))

  const sound = input.sound
  const muteButton = ghostButton(
    sound.mute ? screens.unmuteLabel : screens.muteLabel,
    'mute',
    theme,
  )
  muteButton.addEventListener('click', () => {
    sound.mute = !sound.mute
    muteButton.textContent = sound.mute ? screens.unmuteLabel : screens.muteLabel
    muteButton.setAttribute('data-hud-text', muteButton.textContent)
  })
  settingsPanel.appendChild(muteButton)

  const closeButton = ghostButton(screens.settingsClose, 'settings-close', theme)
  settingsPanel.appendChild(closeButton)

  settingsButton.addEventListener('click', () => {
    settingsPanel.style.display = 'flex'
  })
  closeButton.addEventListener('click', () => {
    settingsPanel.style.display = 'none'
  })

  page.appendChild(settingsPanel)
  host.appendChild(page)

  return () => {
    page.remove()
  }
}

export interface GameOverScreenInput extends ScreenOptions {
  /** Win vs lose variant — decides title/subtitle copy. */
  readonly cleared: boolean
  readonly score: number
  /** Retry → back into gameplay (runner/gameover.ts's `scene.start('game')`). */
  readonly onRetry: () => void
  /** Back to the title page (my-first-game GameOver.js's `scene.start('MainMenu')`). */
  readonly onBackToTitle: () => void
}

/**
 * The GameOver page in two variants — 过关 (`cleared: true`, reached the
 * goal) and 游戏结束 (`cleared: false`, hit a hazard). Two exits, matching
 * the official pattern pair: retry (runner/gameover.ts restarts the game
 * scene) and back-to-title (my-first-game GameOver.js restarts MainMenu).
 * The variant is also exposed as `data-cogito-result` so selfcheck asserts
 * WHICH ending it reached, not just that some scene swap happened.
 */
export function mountGameOverScreen(input: GameOverScreenInput): ScreenTeardown {
  const screens = resolveScreens(input.doc)
  const theme = resolveTheme(input.doc)
  const host = ensureHost()
  const page = pageBackdrop(theme)
  page.setAttribute(RESULT_ATTR, input.cleared ? 'cleared' : 'lost')

  const title = input.cleared ? screens.winTitle : screens.loseTitle
  const subtitle = input.cleared ? screens.winSubtitle : screens.loseSubtitle
  page.appendChild(heading(title, theme, '40px', 'gameover-title'))
  page.appendChild(subline(subtitle, theme))

  const scoreLine = el('div', [
    `color:${theme.heading}`,
    'font-size:26px',
    'font-weight:700',
    'margin:0',
  ].join(';'))
  const scoreText = `${screens.scoreLabel}：${input.score}`
  scoreLine.setAttribute('data-hud-text', scoreText)
  scoreLine.textContent = scoreText
  page.appendChild(scoreLine)

  const retryButton = primaryButton(screens.retryButton, 'retry', theme)
  retryButton.addEventListener('click', () => input.onRetry())
  page.appendChild(retryButton)

  const backButton = ghostButton(screens.backToTitleButton, 'back-title', theme)
  backButton.addEventListener('click', () => input.onBackToTitle())
  page.appendChild(backButton)

  host.appendChild(page)

  return () => {
    page.remove()
  }
}

/**
 * Reads every `[data-hud-text]` string currently mounted — the honest
 * supplement `src/debug/harness.ts`'s `collectHudTexts()` uses so
 * `hud_text_present` still sees on-screen copy after the fixed pages moved
 * from Phaser Text to DOM (DOM text is invisible to a scene-children scan —
 * the same fact that made canvas text invisible to DOM queries).
 */
export function collectScreenTexts(): string[] {
  if (hostEl === null || !document.body.contains(hostEl)) return []
  const out: string[] = []
  for (const node of hostEl.querySelectorAll('[data-hud-text]')) {
    const text = node.getAttribute('data-hud-text')
    if (text !== null && text.length > 0) out.push(text)
  }
  return out
}

/** Reads the live `data-cogito-result` value, if a GameOver page is mounted. */
export function activeResultKind(): 'cleared' | 'lost' | null {
  if (hostEl === null || !document.body.contains(hostEl)) return null
  const node = hostEl.querySelector(`[${RESULT_ATTR}]`)
  if (node === null) return null
  const value = node.getAttribute(RESULT_ATTR)
  return value === 'cleared' || value === 'lost' ? value : null
}

/** Tests-only: drops any mounted screens. Never call from game code. */
export function __unmountAllScreensForTests(): void {
  if (hostEl !== null) {
    hostEl.remove()
    hostEl = null
  }
}

export type { GameDocScreens, GameDocTheme }
