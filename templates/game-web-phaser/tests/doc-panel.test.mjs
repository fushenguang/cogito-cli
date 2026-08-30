// Contract test for the doc panel's "full-screen mask when open" half of
// this change's placement requirement (the other half — the closed-state
// button staying inside the HUD band — is tests/doc-panel-geometry.test.mjs).
//
// src/doc-panel.ts is a DOM module (it calls document.createElement etc.
// inside openDocPanel()/buildCard()), so this suite cannot render it
// bare-Node the way the leaf contracts are tested — there is no jsdom or
// any other DOM implementation in this project's dependency tree (adding
// one is out of scope for this change: AGENTS.md's brief for it forbids
// adding dependencies). What CAN be checked without a DOM is the exact CSS
// text the module would apply to the backdrop element — DOC_OVERLAY_STYLE
// is exported specifically so this is checkable as a plain string, and the
// module's only top-level side effect on import is defining functions (no
// document.* calls run until openDocPanel() is actually invoked), so the
// import itself is safe under bare Node.
//
// The real, browser-rendered "does it actually cover the viewport, does it
// actually pause input" behaviour was additionally verified by hand against
// a real `pnpm build:play` + static serve — see this change's PR/commit
// description for that run's output. This test is the permanent regression
// coverage for the part of that contract that IS expressible without a DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DOC_OVERLAY_STYLE, isDocPanelOpen } from '../src/doc-panel.ts'

test('doc-panel.ts imports cleanly under bare Node (no DOM touched at module load time)', () => {
  assert.equal(typeof DOC_OVERLAY_STYLE, 'string')
})

test('the panel is reported closed before openDocPanel() is ever called', () => {
  assert.equal(isDocPanelOpen(), false)
})

test('DOC_OVERLAY_STYLE covers the full viewport (the "全屏遮罩" half of the placement contract)', () => {
  const declarations = DOC_OVERLAY_STYLE.split(';').map((rule) => rule.trim())

  for (const required of ['position:fixed', 'inset:0', 'width:100%', 'height:100%']) {
    assert.ok(
      declarations.includes(required),
      `DOC_OVERLAY_STYLE is missing "${required}" — without it the open panel would not ` +
        `provably mask the full screen, and doc-panel-geometry.ts's HUD-band-only rule ` +
        `would then have no justification for letting the panel cover the playfield`,
    )
  }
})

test('DOC_OVERLAY_STYLE sits above normal page content (non-trivial z-index)', () => {
  const zIndexRule = DOC_OVERLAY_STYLE.split(';').find((rule) => rule.trim().startsWith('z-index:'))
  assert.ok(zIndexRule, 'DOC_OVERLAY_STYLE has no z-index rule at all')
  const value = Number(zIndexRule.split(':')[1])
  assert.ok(Number.isFinite(value) && value > 0, `z-index was "${zIndexRule}", expected a positive number`)
})
