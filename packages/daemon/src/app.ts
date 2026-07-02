import { Hono } from 'hono'
import { launchSessionRequestSchema, type SessionRegistry } from '@ai-hq/core'

export function createApp(options: { registry: SessionRegistry }): Hono {
  const { registry } = options
  const app = new Hono()

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
