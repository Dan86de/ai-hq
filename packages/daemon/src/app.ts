import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  launchSessionRequestSchema,
  verdictSchema,
  type DecisionQueue,
  type EventLog,
  type HqEvent,
  type SessionRegistry,
} from '@ai-hq/core'
import { uiDir } from '@ai-hq/ui'

const uiContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function createApp(options: {
  registry: SessionRegistry
  eventLog: EventLog
  decisionQueue: DecisionQueue
}): Hono {
  const { registry, eventLog, decisionQueue } = options
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

  app.get('/sessions/:id', (c) => {
    const session = registry.get(c.req.param('id'))
    if (session === undefined) return c.notFound()
    return c.json({ session })
  })

  // The Operator cuts off a running Session's agent.
  app.post('/sessions/:id/interrupt', async (c) => {
    const result = await registry.interrupt(c.req.param('id'))
    if (result.outcome === 'not_found') return c.notFound()
    if (result.outcome === 'not_running') {
      return c.json({ error: 'session is not running', session: result.session }, 409)
    }
    return c.json({ session: result.session })
  })

  // Pending Decisions across all Sessions: the data behind the Decision Inbox.
  app.get('/decisions', (c) => {
    return c.json({ decisions: decisionQueue.pending() })
  })

  app.get('/sessions/:id/decisions', (c) => {
    const sessionId = c.req.param('id')
    if (registry.get(sessionId) === undefined) return c.notFound()
    return c.json({ decisions: decisionQueue.pending(sessionId) })
  })

  app.post('/decisions/:id/verdict', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = verdictSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400)
    }
    const result = decisionQueue.decide(c.req.param('id'), parsed.data)
    if (result.outcome === 'not_found') return c.notFound()
    if (result.outcome === 'already_decided') {
      return c.json({ error: 'decision already decided', decision: result.decision }, 409)
    }
    return c.json({ decision: result.decision })
  })

  // One mechanism serves both catch-up and streaming: replay the Event Log from
  // a sequence number, then tail live. The stream stays open until the client
  // disconnects, so a finished Session's Transcript and a running one read the same way.
  app.get('/sessions/:id/events', (c) => {
    const sessionId = c.req.param('id')
    if (registry.get(sessionId) === undefined) return c.notFound()

    // EventSource sends Last-Event-ID (the last seq it saw) on reconnect;
    // it wins over fromSeq so reconnects never re-deliver or skip Events.
    const lastEventId = Number(c.req.header('last-event-id'))
    const fromSeq = Number.isInteger(lastEventId)
      ? lastEventId + 1
      : Math.max(0, Number(c.req.query('fromSeq')) || 0)

    return streamSSE(c, async (stream) => {
      // Subscribe before replaying so nothing appended mid-replay is missed;
      // the seq guard in write() drops what the replay already delivered.
      const pending: HqEvent[] = []
      let wake = (): void => {}
      let aborted = false
      const unsubscribe = eventLog.subscribe((event) => {
        if (event.sessionId !== sessionId) return
        pending.push(event)
        wake()
      })
      stream.onAbort(() => {
        aborted = true
        wake()
      })

      let lastSeq = fromSeq - 1
      async function write(event: HqEvent): Promise<void> {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) })
      }

      try {
        for (const event of eventLog.read({ sessionId, fromSeq })) {
          if (aborted) return
          await write(event)
        }
        while (!aborted) {
          const event = pending.shift()
          if (event !== undefined) {
            await write(event)
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        unsubscribe()
      }
    })
  })

  return app
}
