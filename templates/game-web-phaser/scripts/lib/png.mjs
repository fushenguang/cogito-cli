// Zero-dep PNG decode + "is this screenshot actually non-empty" judgement —
// design D4.
//
// 🔴 A solid-colour PNG and a real rendered frame are both perfectly valid
// PNGs — checking that the screenshot file/base64 exists, or checking its
// byte length, proves nothing. This module actually decodes pixels (via
// Node's built-in `zlib.inflateSync`, no image library) and judges emptiness
// from unique-colour count + pixel variance. See tests/png.test.mjs for the
// required negative case: a solid-colour PNG MUST be judged empty.

import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** @typedef {{ type: string, data: Buffer }} PngChunk */

/** @returns {PngChunk[]} */
function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePng: not a PNG (bad signature)')
  }
  /** @type {PngChunk[]} */
  const chunks = []
  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) {
      throw new Error(`decodePng: truncated ${type} chunk`)
    }
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4 // skip the trailing CRC32
  }
  return chunks
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Decode a base64-encoded PNG into raw pixels.
 *
 * Supports what CDP's `Page.captureScreenshot` actually produces: 8-bit,
 * non-interlaced, colour type 2 (RGB) or 6 (RGBA). Anything else throws —
 * this is meant to fail loudly on an unexpected format, not silently
 * misread pixels.
 *
 * @returns {{ width: number, height: number, channels: 3 | 4, pixels: Buffer }}
 */
export function decodePng(base64) {
  const buf = Buffer.from(base64, 'base64')
  const chunks = readChunks(buf)

  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('decodePng: missing IHDR chunk')

  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data.readUInt8(8)
  const colorType = ihdr.data.readUInt8(9)
  const interlace = ihdr.data.readUInt8(12)

  if (bitDepth !== 8) {
    throw new Error(`decodePng: unsupported bit depth ${bitDepth} (only 8 is supported)`)
  }
  if (interlace !== 0) {
    throw new Error('decodePng: unsupported interlaced PNG (Adam7)')
  }

  let channels
  if (colorType === 2) channels = 3
  else if (colorType === 6) channels = 4
  else
    throw new Error(
      `decodePng: unsupported colour type ${colorType} (only 2=RGB and 6=RGBA are supported)`,
    )

  const idatData = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  if (idatData.length === 0) throw new Error('decodePng: no IDAT chunks found')

  const raw = inflateSync(idatData)

  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let rawOffset = 0

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset]
    rawOffset += 1
    const rowStart = y * stride
    const prevRowStart = rowStart - stride

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x]
      const a = x >= channels ? pixels[rowStart + x - channels] : 0
      const b = y > 0 ? pixels[prevRowStart + x] : 0
      const c = y > 0 && x >= channels ? pixels[prevRowStart + x - channels] : 0

      let value
      switch (filterType) {
        case 0:
          value = rawByte
          break
        case 1:
          value = rawByte + a
          break
        case 2:
          value = rawByte + b
          break
        case 3:
          value = rawByte + Math.floor((a + b) / 2)
          break
        case 4:
          value = rawByte + paethPredictor(a, b, c)
          break
        default:
          throw new Error(`decodePng: unsupported filter type ${filterType} on row ${y}`)
      }
      pixels[rowStart + x] = value & 0xff
    }
    rawOffset += stride
  }

  return { width, height, channels, pixels }
}

/**
 * Judge whether a decoded PNG is "really" non-empty (design D4): a solid
 * colour is a valid render (e.g. a loading screen background) but is not
 * proof the game actually drew anything, so both a unique-colour-count
 * floor AND a pixel-variance floor must be cleared.
 *
 * @param {{ width: number, height: number, channels: number, pixels: Buffer }} decoded
 * @param {{ minUniqueColors?: number, minVariance?: number }} [thresholds]
 */
export function judgeScreenshotNonEmpty(decoded, thresholds = {}) {
  const { minUniqueColors = 2, minVariance = 1 } = thresholds
  const { width, height, channels, pixels } = decoded
  const totalPixels = width * height

  if (totalPixels === 0) {
    return {
      nonEmpty: false,
      uniqueColors: 0,
      variance: 0,
      reason: 'zero-size image (width or height is 0)',
    }
  }

  const colors = new Set()
  let sum = 0
  let sumSquares = 0

  for (let i = 0; i < totalPixels; i++) {
    const base = i * channels
    const r = pixels[base]
    const g = pixels[base + 1]
    const b = pixels[base + 2]
    colors.add((r << 16) | (g << 8) | b)

    // Perceptual luminance as the scalar we measure variance over — cheap
    // and enough to tell "flat colour" from "has visible structure" apart.
    const luminance = r * 0.299 + g * 0.587 + b * 0.114
    sum += luminance
    sumSquares += luminance * luminance
  }

  const mean = sum / totalPixels
  const variance = sumSquares / totalPixels - mean * mean
  const uniqueColors = colors.size

  const nonEmpty = uniqueColors >= minUniqueColors && variance >= minVariance
  return {
    nonEmpty,
    uniqueColors,
    variance,
    reason: nonEmpty
      ? undefined
      : `uniqueColors=${uniqueColors} (need >=${minUniqueColors}), variance=${variance.toFixed(3)} (need >=${minVariance})`,
  }
}
