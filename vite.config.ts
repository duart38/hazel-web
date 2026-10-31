import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** `HAZEL_DEV_CARD=/Volumes/Untitled pnpm dev` serves that folder to the app as a card, so the
 *  app can be seen with real photos without the folder picker (which needs a click). Only in
 *  `vite dev`; read only unless HAZEL_DEV_CARD_WRITABLE=1. */
function devCard(): Plugin {
  const root = process.env.HAZEL_DEV_CARD
  const writable = process.env.HAZEL_DEV_CARD_WRITABLE === '1'
  return {
    name: 'hazel-dev-card',
    apply: 'serve',
    configureServer(server) {
      if (!root) return
      const base = path.resolve(root)
      const resolve = (query: string | null): string | null => {
        const full = path.resolve(base, query ?? '')
        return full === base || full.startsWith(base + path.sep) ? full : null
      }
      server.middlewares.use('/__hazel/card', (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://dev')
          const target = resolve(url.searchParams.get('path'))
          const send = (status: number, body = '') => {
            res.statusCode = status
            res.end(body)
          }
          if (url.pathname === '/info') {
            res.setHeader('content-type', 'application/json')
            return send(200, JSON.stringify({ name: path.basename(base), writable }))
          }
          if (!target) return send(403)
          if (req.method !== 'GET' && !writable) return send(403)
          try {
            if (url.pathname === '/list') {
              if (req.method === 'PUT') {
                await fs.mkdir(target, { recursive: true })
                return send(204)
              }
              const entries = await fs.readdir(target, { withFileTypes: true })
              const list = entries
                .filter((e) => e.isFile() || e.isDirectory())
                .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }))
              res.setHeader('content-type', 'application/json')
              return send(200, JSON.stringify(list))
            }
            if (url.pathname === '/file') {
              if (req.method === 'DELETE') {
                await fs.rm(target)
                return send(204)
              }
              if (req.method === 'PUT') {
                const chunks: Buffer[] = []
                for await (const chunk of req) chunks.push(chunk as Buffer)
                await fs.writeFile(target, Buffer.concat(chunks))
                return send(204)
              }
              const stat = await fs.stat(target)
              res.setHeader('content-length', String(stat.size))
              res.setHeader('x-modified', String(stat.mtimeMs))
              createReadStream(target).pipe(res)
              return
            }
            send(404)
          } catch {
            send(404)
          }
        })()
      })
    },
  }
}

/** Cross-origin isolation, so the look engine can share memory between threads (src/look/threads.ts).
 *  vercel.json sends the same two headers in production. */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** The two headers on every response, a 304 included: Vite's own `server.headers` leaves them off
 *  a 304, and WebKit then refuses a revalidated worker script (each look engine starts its own
 *  worker, so the second one failed) because of the page's COEP. */
function isolate(): Plugin {
  const set = (_req: IncomingMessage, res: ServerResponse, next: () => void) => {
    for (const [key, value] of Object.entries(isolation)) res.setHeader(key, value)
    next()
  }
  return {
    name: 'hazel-isolation',
    configureServer: (server) => void server.middlewares.use(set),
    configurePreviewServer: (server) => void server.middlewares.use(set),
  }
}

export default defineConfig({
  plugins: [isolate(), react(), devCard()],
  server: { headers: isolation },
  preview: { headers: isolation },
})
