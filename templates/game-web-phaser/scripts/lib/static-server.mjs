// Zero-dep static file server (Node's built-in `http`) used only by
// verify.mjs to serve a built dist-play/dist-learn directory for BH-1/BH-2.
// Not a general-purpose dev server — this template's real dev/preview
// servers are Vite's (see vite.config.ts).

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/**
 * Start a static file server rooted at `rootDir`, listening on an ephemeral
 * loopback port. Resolves once listening.
 *
 * @param {string} rootDir
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string }>}
 */
export function startStaticServer(rootDir) {
  const root = normalize(rootDir)

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req, res) {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
      let filePath = normalize(join(root, urlPath))

      // Refuse to serve anything outside rootDir (defence against `..`
      // traversal in the request path — this only ever serves our own
      // build output, but there is no reason not to be strict).
      if (!(filePath === root || filePath.startsWith(root + sep))) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        fileStat = null
      }
      if (!fileStat || fileStat.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }

      const data = await readFile(filePath)
      const contentType = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      resolve({ server, port, url: `http://127.0.0.1:${port}/` })
    })
  })
}
