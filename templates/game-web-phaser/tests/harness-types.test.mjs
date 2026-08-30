// Bare-Node import guard for the harness contract (design D1) — the same
// shape as tests/state-jump.test.mjs's own guard, and it exists for the same
// reason: this is what would break, silently, if someone ever added an
// import to harness-types.ts. A future assertion runner (out of scope for
// this change) needs to introspect this contract without a browser; if the
// import here throws, that requirement is already broken and nothing else
// in this suite would tell you.

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('harness-types.ts is importable by bare Node (zero-import contract)', async () => {
  const mod = await import('../src/debug/harness-types.ts')
  // harness-types.ts exports only types/interfaces — fully erased at
  // runtime by Node's TypeScript type-stripping. A successful import that
  // resolves to a module object is the entire assertion here; there being
  // no runtime-visible named export is expected, not a gap in the test.
  assert.equal(typeof mod, 'object')
})
