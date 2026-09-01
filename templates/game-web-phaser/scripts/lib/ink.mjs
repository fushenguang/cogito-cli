// Region "ink" analysis over a decoded screenshot — the pixel half of
// scripts/selfcheck.mjs's critical-copy assertion (issue #B4, 2026-09-01).
//
// What it answers: within a rectangle of the screenshot, is there ACTUALLY
// drawn text — not "an element exists in the DOM", not "a texture was
// created", but visible pixels that differ from the region's own background.
// This is the direct answer to the 小小财迷 M1 finding (caimi-m1-task2-eval):
// every module was green while the start page had no visible text, because
// each layer asserted its own artifact and nothing asserted the pixels.
//
// Method — region-modal ink ratio, chosen after two hand-rolled predicates
// failed on 2026-09-01 (a mis-scaled Y coordinate and a "bright pixel"
// threshold that excluded grey #9ca3af text entirely):
//   1. The modal (most common) colour of the region IS the region's
//      background — the fixed pages are a flat backdrop with text on top, so
//      background pixels always dominate.
//   2. A pixel is INK iff its Euclidean RGB distance from that modal colour
//      exceeds `inkDistance`. No hand-picked target colour, no luminance
//      threshold, no assumption about the text's hue — only "differs from
//      the backdrop right behind it".
//   3. The caller asserts inkRatio against two bounds: a minimum on the
//      text region (positive control — text must be visible) and a maximum
//      on a known-empty region of the same page (negative control — the
//      method itself must read ~0 where nothing is drawn). The pair is what
//      makes the measurement self-calibrating: if the negative control
//      reads high, the failure is in the measurement, not the page.
//
// Pure and dependency-free (consumes png.mjs's decodePng output shape), so
// tests/ink.test.mjs can cover it without a browser.

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * Integer pixel rectangle in screenshot coordinates.
 */

/**
 * Clamp a rect to the image bounds and integerize it.
 *
 * @param {Rect} rect
 * @param {{ width: number, height: number }} image
 * @returns {Rect | null} null when nothing of the rect remains inside the image
 */
export function clampRect(rect, image) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Region-modal ink statistics.
 *
 * @param {{ width: number, height: number, channels: number, pixels: Buffer }} decoded
 * @param {Rect} rect screenshot-space rectangle (clamped internally)
 * @param {{ inkDistance?: number }} [opts] RGB distance beyond modal that counts as ink (default 48)
 * @returns {{ sampled: number, inkRatio: number, modalRatio: number, modalColor: [number, number, number] }}
 * @throws when the rect falls entirely outside the image (sampled would be 0 —
 *   a screenshot-coordinate bug, which must not be silently readable as "no ink")
 */
export function regionInkStats(decoded, rect, opts = {}) {
  const inkDistance = opts.inkDistance ?? 48
  const clamped = clampRect(rect, decoded)
  if (clamped === null) {
    throw new Error(`regionInkStats: rect ${JSON.stringify(rect)} is entirely outside the ${decoded.width}x${decoded.height} image`)
  }

  const { channels, pixels } = decoded
  const colors = new Map() // rgb key -> count

  for (let y = clamped.y; y < clamped.y + clamped.height; y++) {
    for (let x = clamped.x; x < clamped.x + clamped.width; x++) {
      const base = (y * decoded.width + x) * channels
      const r = pixels[base]
      const g = pixels[base + 1]
      const b = pixels[base + 2]
      const key = (r << 16) | (g << 8) | b
      colors.set(key, (colors.get(key) ?? 0) + 1)
    }
  }

  const sampled = clamped.width * clamped.height
  let modalKey = 0
  let modalCount = -1
  for (const [key, count] of colors) {
    if (count > modalCount) {
      modalCount = count
      modalKey = key
    }
  }

  const mr = (modalKey >> 16) & 0xff
  const mg = (modalKey >> 8) & 0xff
  const mb = modalKey & 0xff

  let ink = 0
  for (let y = clamped.y; y < clamped.y + clamped.height; y++) {
    for (let x = clamped.x; x < clamped.x + clamped.width; x++) {
      const base = (y * decoded.width + x) * channels
      const dr = pixels[base] - mr
      const dg = pixels[base + 1] - mg
      const db = pixels[base + 2] - mb
      if (dr * dr + dg * dg + db * db > inkDistance * inkDistance) ink += 1
    }
  }

  return {
    sampled,
    inkRatio: ink / sampled,
    modalRatio: modalCount / sampled,
    modalColor: [mr, mg, mb],
  }
}
