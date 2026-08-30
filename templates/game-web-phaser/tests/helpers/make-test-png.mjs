// Test-only PNG encoder — zero dep, built purely so png.test.mjs can feed
// synthetic fixtures into scripts/lib/png.mjs's decoder/judgement without a
// real screenshot. Not used by verify.mjs itself; do not import from there.

import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/**
 * Encode an 8-bit RGB (colour type 2), non-interlaced PNG as a base64
 * string, for feeding into decodePng()/judgeScreenshotNonEmpty() in tests.
 *
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} pixelFn
 */
export function encodeTestPng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(2, 9) // colour type: 2 = RGB
  ihdr.writeUInt8(0, 10) // compression method
  ihdr.writeUInt8(0, 11) // filter method
  ihdr.writeUInt8(0, 12) // interlace method: 0 = none

  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type 0 (None) for every row — simplest valid encoding
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y)
      const pixelStart = rowStart + 1 + x * 3
      raw[pixelStart] = r
      raw[pixelStart + 1] = g
      raw[pixelStart + 2] = b
    }
  }

  const idat = deflateSync(raw)

  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}
