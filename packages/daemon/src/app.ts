import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Hono, type Context } from 'hono'
import { launchSessionRequestSchema, type SessionRegistry } from '@ai-hq/core'
import { uiDir } from '@ai-hq/ui'

const uiContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function createApp(options: { registry: SessionRegistry }): Hono {
  const { registry } = options
  const app = new Hono()
  // The UI ships inside the Daemon: nothing separate to install, sign, or update.
  // Only files that exist in the ui package at startup are ever served.
  const uiFiles = new Set(readdirSync(uiDir))

  async function serveUiFile(c: Context, file: string): Promise<Response> {
    const body = await readFile(join(uiDir, file), 'utf8')
    return c.body(body, 200, {
      'content-type': uiContentTypes[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
  }

  app.get('/', (c) => serveUiFile(c, 'index.html'))

  app.get('/ui/:file', (c) => {
    const file = c.req.param('file')
    if (!uiFiles.has(file)) return c.notFound()
    return serveUiFile(c, file)
  })

  app.post('/sessions', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = launchSessionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
    }
    const session = await registry.launch(parsed.data)
    return c.json({ session }, 201)
  })

  app.get('/sessions', (c) => {
    return c.json({ sessions: registry.list() })
  })

  return app
}
