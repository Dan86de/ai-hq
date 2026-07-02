import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createEventLog,
  createFakeAgentAdapter,
  launchSessionResponseSchema,
  listSessionsResponseSchema,
} from '@ai-hq/core'
import { startDaemon, type Daemon } from '../src/index.ts'

let dataDir: string
let daemon: Daemon

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-daemon-'))
  daemon = await startDaemon({ dataDir, port: 0, adapter: createFakeAgentAdapter() })
})

afterEach(async () => {
  await daemon.close().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
})

function url(path: string): string {
  return `http://127.0.0.1:${daemon.port}${path}`
}

async function launchSession(repoPath: string, prompt: string) {
  const response = await fetch(url('/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath, prompt }),
  })
  expect(response.status).toBe(201)
  return launchSessionResponseSchema.parse(await response.json()).session
}

async function listSessions() {
  const response = await fetch(url('/sessions'))
  expect(response.status).toBe(200)
  return listSessionsResponseSchema.parse(await response.json()).sessions
}

describe('daemon HTTP API', () => {
  test('POST /sessions launches a session and GET /sessions lists it', async () => {
    const session = await launchSession('/repo/a', 'build the feature')

    expect(session.status).toBe('running')
    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')

    const listed = (await listSessions()).find((s) => s.id === session.id)
    expect(listed).toMatchObject({ repoPath: '/repo/a', prompt: 'build the feature' })
  })

  test('POST /sessions rejects an invalid body', async () => {
    const response = await fetch(url('/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/repo/a' }),
    })

    expect(response.status).toBe(400)
  })

  test('GET / serves the Session list UI', async () => {
    const response = await fetch(url('/'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('/ui/app.js')
    expect(html).toContain('/ui/style.css')
  })

  test('GET /ui/<asset> serves the UI assets with their content types', async () => {
    const js = await fetch(url('/ui/app.js'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')

    const css = await fetch(url('/ui/style.css'))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  test('GET /ui/<file> serves only whitelisted UI files', async () => {
    expect((await fetch(url('/ui/nope.js'))).status).toBe(404)
    expect((await fetch(url('/ui/%2e%2e%2fpackage.json'))).status).toBe(404)
  })

  test('events and sessions survive a daemon restart', async () => {
    const session = await launchSession('/repo/a', 'persist me')
    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')
    await daemon.close()

    daemon = await startDaemon({ dataDir, port: 0, adapter: createFakeAgentAdapter() })

    const listed = (await listSessions()).find((s) => s.id === session.id)
    expect(listed?.status).toBe('completed')

    const eventLog = createEventLog({ dbPath: daemon.dbPath })
    try {
      const events = eventLog.read({ sessionId: session.id, fromSeq: 0 })
      expect(events.map((e) => e.type)).toEqual([
        'session_launched',
        'agent_message',
        'tool_call',
        'agent_message',
        'session_completed',
      ])
    } finally {
      eventLog.close()
    }
  })
})
