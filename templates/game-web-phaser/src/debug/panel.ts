import { listStates, jump, isValidStart, type StateId } from './state-jump'

/**
 * Mounts a tiny debug overlay, creating its own container element.
 *
 * 🔴 **It creates the node itself instead of reusing a `<div>` in
 * index.html — on purpose.** The first version declared
 * `<div id="debug-panel">` in index.html, which meant that div shipped in
 * the `build:play` bundle too: an empty node, harmless in behaviour, but
 * still a visible trace in the public artifact (view-source shows
 * "debug-panel") and *not* something the build target decided — the markup
 * was unconditional. D6's claim is that the play build carries **zero**
 * trace of the panel, so the markup had to go where the code already is:
 * behind the build-time gate.
 *
 * 🔴 Only ever import/call this from a branch gated on
 * `import.meta.env.MODE === 'learn'` (see src/main.ts) — never behind a
 * runtime/client-side switch. Which build this code ends up in is decided
 * by which npm script built it (`build:play` vs `build:learn`, see
 * vite.config.ts), so a player looking at a shared `build:play` link has no
 * way to turn this on (design D6).
 *
 * This is a minimal reference tool, not a full debug UI: it exercises the
 * state-jump contract (./state-jump.ts) so that contract has at least one
 * real, visible consumer beyond its own tests.
 */
export function mountDebugPanel(): void {
  // Idempotent: a second call reuses the node instead of stacking overlays.
  const existing = document.getElementById('debug-panel')
  if (existing) return
  const root = document.createElement('div')
  root.id = 'debug-panel'
  document.body.appendChild(root)

  root.style.cssText = [
    'position:fixed',
    'top:0',
    'right:0',
    'z-index:1000',
    'background:rgba(17,17,24,0.85)',
    'color:#e5e7eb',
    'font:12px/1.4 system-ui,-apple-system,sans-serif',
    'padding:8px 10px',
    'max-width:280px',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'debug panel (learn build only)'
  title.style.cssText = 'font-weight:600;margin-bottom:6px'
  root.appendChild(title)

  const output = document.createElement('pre')
  output.style.cssText = 'white-space:pre-wrap;margin:6px 0 0;font-size:11px'

  for (const id of listStates()) {
    const button = document.createElement('button')
    button.textContent = `jump(${id})`
    button.style.cssText = 'margin:2px 4px 2px 0'
    button.addEventListener('click', () => {
      renderJumpResult(id, output)
    })
    root.appendChild(button)
  }

  root.appendChild(output)
}

function renderJumpResult(id: StateId, output: HTMLPreElement): void {
  const state = jump(id)
  const valid = isValidStart(id, state)
  output.textContent = JSON.stringify({ state, isValidStart: valid }, null, 2)
}
