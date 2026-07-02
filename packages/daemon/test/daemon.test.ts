import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createEventLog,
  createFakeAgentAdapter,
  decideDecisionResponseSchema,
  getSessionResponseSchema,
  hqEventSchema,
  launchSessionResponseSchema,
  listDecisionsResponseSchema,
  listSessionsResponseSchema,
  type AdapterEvent,
  type AgentAdapter,
  type FakeAgentStep,
  type HqEvent,
  type Notification,
  type Verdict,
} from '@ai-hq/core'
import { startDaemon, type Daemon } from '../src/index.ts'

let dataDir: string
let daemon: Daemon
let notifications: Notification[]

// Every startDaemon in this file records Notifications instead of firing real
// macOS ones; the osascript default would pop notifications on each test run.
const recordNotification = (notification: Notification): void => {
  notifications.push(notification)
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-daemon-'))
  notifications = []
  daemon = await startDaemon({
    dataDir,
    port: 0,
    adapter: createFakeAgentAdapter(),
    notify: recordNotification,
  })
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

async function getPendingDecisions(path: string) {
  const response = await fetch(url(path))
  expect(response.status).toBe(200)
  return listDecisionsResponseSchema.parse(await response.json()).decisions
}

async function sendVerdict(decisionId: string, verdict: Verdict): Promise<Response> {
  return fetch(url(`/decisions/${decisionId}/verdict`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(verdict),
  })
}

/** An AgentAdapter whose run the test drives event by event. Supports one run at a time. */
function createManualAdapter() {
  const queue: (AdapterEvent | 'end')[] = []
  let wake = (): void => {}
  const adapter: AgentAdapter = {
    async launch() {
      return {
        events: (async function* () {
          while (true) {
            while (queue.length > 0) {
              const next = queue.shift()!
              if (next === 'end') return
              yield next
            }
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
        })(),
        async interrupt() {},
        async resume() {},
      }
    },
  }
  return {
    adapter,
    emit(event: AdapterEvent) {
      queue.push(event)
      wake()
    },
    end() {
      queue.push('end')
      wake()
    },
  }
}

/** Connects to an SSE endpoint and hands back Events one at a time. */
async function openEventStream(path: string, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const response = await fetch(url(path), { headers, signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  const parsed: HqEvent[] = []
  return {
    async next(): Promise<HqEvent> {
      while (parsed.length === 0) {
        const { done, value } = await reader.read()
        if (done) throw new Error('event stream ended unexpectedly')
        buffer += value
        let frameEnd
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trimStart())
            .join('\n')
          if (data !== '') parsed.push(hqEventSchema.parse(JSON.parse(data)))
        }
      }
      return parsed.shift()!
    },
    close() {
      controller.abort()
    },
  }
}

async function collectEvents(path: string, count: number, headers?: Record<string, string>) {
  const stream = await openEventStream(path, headers)
  try {
    const events: HqEvent[] = []
    for (let i = 0; i < count; i++) {
      events.push(await stream.next())
    }
    return events
  } finally {
    stream.close()
  }
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

  test('GET /sessions/:id returns the session', async () => {
    const session = await launchSession('/repo/a', 'fetch me')

    const response = await fetch(url(`/sessions/${session.id}`))
    expect(response.status).toBe(200)
    const fetched = getSessionResponseSchema.parse(await response.json()).session
    expect(fetched).toMatchObject({ id: session.id, repoPath: '/repo/a', prompt: 'fetch me' })
  })

  test('GET /sessions/:id returns 404 for an unknown session', async () => {
    expect((await fetch(url('/sessions/unknown'))).status).toBe(404)
  })

  test('events and sessions survive a daemon restart', async () => {
    const session = await launchSession('/repo/a', 'persist me')
    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')
    await daemon.close()

    daemon = await startDaemon({
      dataDir,
      port: 0,
      adapter: createFakeAgentAdapter(),
      notify: recordNotification,
    })

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

describe('gating over HTTP', () => {
  const gatedScript: FakeAgentStep[] = [
    { type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } },
    { type: 'agent_message', text: 'Wrapping up.' },
  ]

  async function restartWithScript(script: FakeAgentStep[]): Promise<void> {
    await daemon.close()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      adapter: createFakeAgentAdapter({ script }),
      notify: recordNotification,
    })
  }

  async function launchParkedSession() {
    const session = await launchSession('/repo/a', 'clean the build')
    await expect.poll(() => getPendingDecisions('/decisions')).toHaveLength(1)
    const decision = (await getPendingDecisions('/decisions'))[0]!
    return { session, decision }
  }

  test('a gated call parks as a pending Decision, visible per Session and across Sessions', async () => {
    await restartWithScript(gatedScript)
    const { session, decision } = await launchParkedSession()

    expect(decision).toMatchObject({
      sessionId: session.id,
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      status: 'pending',
    })
    expect(await getPendingDecisions(`/sessions/${session.id}/decisions`)).toEqual([decision])

    const fetched = getSessionResponseSchema.parse(
      await (await fetch(url(`/sessions/${session.id}`))).json(),
    ).session
    expect(fetched.status).toBe('waiting_on_human')
  })

  test('approving via HTTP resumes the Session and the call executes', async () => {
    await restartWithScript(gatedScript)
    const { session, decision } = await launchParkedSession()

    const response = await sendVerdict(decision.id, { behavior: 'approve' })

    expect(response.status).toBe(200)
    const decided = decideDecisionResponseSchema.parse(await response.json()).decision
    expect(decided.status).toBe('approved')
    expect(decided.decidedAt).not.toBeNull()

    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')
    const events = await collectEvents(`/sessions/${session.id}/events`, 6)
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      'decision_requested',
      'decision_decided',
      'tool_call',
      'agent_message',
      'session_completed',
    ])
    expect(await getPendingDecisions('/decisions')).toHaveLength(0)
  })

  test('denying with a note via HTTP relays the note and the agent adjusts course', async () => {
    await restartWithScript(gatedScript)
    const { session, decision } = await launchParkedSession()

    const response = await sendVerdict(decision.id, {
      behavior: 'deny',
      note: 'keep the build directory',
    })

    expect(response.status).toBe(200)
    const decided = decideDecisionResponseSchema.parse(await response.json()).decision
    expect(decided).toMatchObject({ status: 'denied', note: 'keep the build directory' })

    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')
    const events = await collectEvents(`/sessions/${session.id}/events`, 6)
    expect(events.map((e) => e.type)).not.toContain('tool_call')
    expect(events[3]?.payload).toMatchObject({
      text: expect.stringContaining('keep the build directory'),
    })
  })

  test('a second Verdict is rejected with the already-decided Decision', async () => {
    await restartWithScript(gatedScript)
    const { decision } = await launchParkedSession()
    await sendVerdict(decision.id, { behavior: 'approve' })

    const response = await sendVerdict(decision.id, { behavior: 'deny', note: 'too late' })

    expect(response.status).toBe(409)
  })

  test('a Verdict for an unknown Decision returns 404', async () => {
    expect((await sendVerdict('unknown', { behavior: 'approve' })).status).toBe(404)
  })

  test('an invalid Verdict body is rejected', async () => {
    await restartWithScript(gatedScript)
    const { decision } = await launchParkedSession()

    const response = await fetch(url(`/decisions/${decision.id}/verdict`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'maybe' }),
    })

    expect(response.status).toBe(400)
  })

  test('GET /sessions/:id/decisions returns 404 for an unknown session', async () => {
    expect((await fetch(url('/sessions/unknown/decisions'))).status).toBe(404)
  })
})

describe('Notifier', () => {
  async function restartWithAdapter(adapter: AgentAdapter): Promise<void> {
    await daemon.close()
    daemon = await startDaemon({ dataDir, port: 0, adapter, notify: recordNotification })
  }

  test('a parked Decision notifies, naming the Session and the gated tool', async () => {
    await restartWithAdapter(
      createFakeAgentAdapter({
        script: [{ type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } }],
      }),
    )

    await launchSession('/repo/a', 'clean the build')

    await expect
      .poll(() => notifications)
      .toContainEqual({ title: 'a - clean the build', body: 'Decision parked: Bash' })
  })

  test('a completed Session notifies', async () => {
    await launchSession('/repo/a', 'build the feature')

    await expect
      .poll(() => notifications)
      .toContainEqual({ title: 'a - build the feature', body: 'Session completed' })
  })

  test('a failed Session notifies', async () => {
    await restartWithAdapter(createFakeAgentAdapter({ failWith: 'agent crashed' }))

    await launchSession('/repo/a', 'doomed task')

    await expect
      .poll(() => notifications)
      .toContainEqual({ title: 'a - doomed task', body: 'Session failed: agent crashed' })
  })
})

describe('GET /sessions/:id/events (SSE)', () => {
  const completedTranscript = [
    'session_launched',
    'agent_message',
    'tool_call',
    'agent_message',
    'session_completed',
  ]

  async function launchCompletedSession() {
    const session = await launchSession('/repo/a', 'stream me')
    await expect
      .poll(async () => (await listSessions()).find((s) => s.id === session.id)?.status)
      .toBe('completed')
    return session
  }

  test('replays history and then continues live, with no gaps or duplicates', async () => {
    await daemon.close()
    const manual = createManualAdapter()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      adapter: manual.adapter,
      notify: recordNotification,
    })

    const session = await launchSession('/repo/a', 'stream me')
    manual.emit({ type: 'agent_message', text: 'one' })

    const stream = await openEventStream(`/sessions/${session.id}/events`)
    try {
      const replayed = [await stream.next(), await stream.next()]
      expect(replayed[0]).toMatchObject({ type: 'session_launched', sessionId: session.id })
      expect(replayed[1]).toMatchObject({ type: 'agent_message', payload: { text: 'one' } })

      // Everything so far was delivered, so these two arrive over the live tail.
      manual.emit({ type: 'agent_message', text: 'two' })
      const live = await stream.next()
      expect(live).toMatchObject({ type: 'agent_message', payload: { text: 'two' } })

      manual.end()
      const terminal = await stream.next()
      expect(terminal.type).toBe('session_completed')

      const seqs = [...replayed, live, terminal].map((e) => e.seq)
      expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b))
    } finally {
      stream.close()
    }
  })

  test('replays the full Transcript of a completed session', async () => {
    const session = await launchCompletedSession()

    const events = await collectEvents(`/sessions/${session.id}/events`, 5)
    expect(events.map((e) => e.type)).toEqual(completedTranscript)
    expect(events.every((e) => e.sessionId === session.id)).toBe(true)
  })

  test('fromSeq replays that event and everything after it', async () => {
    const session = await launchCompletedSession()
    const all = await collectEvents(`/sessions/${session.id}/events`, 5)

    const fromThird = await collectEvents(
      `/sessions/${session.id}/events?fromSeq=${all[2]!.seq}`,
      3,
    )
    expect(fromThird).toEqual(all.slice(2))
  })

  test('Last-Event-ID resumes right after the given seq, as an EventSource reconnect does', async () => {
    const session = await launchCompletedSession()
    const all = await collectEvents(`/sessions/${session.id}/events`, 5)

    const resumed = await collectEvents(`/sessions/${session.id}/events`, 3, {
      'last-event-id': String(all[1]!.seq),
    })
    expect(resumed).toEqual(all.slice(2))
  })

  test('returns 404 for an unknown session', async () => {
    expect((await fetch(url('/sessions/unknown/events'))).status).toBe(404)
  })
})

describe('restart recovery', () => {
  const midFlightScript: FakeAgentStep[] = [
    { type: 'agent_message', text: 'Working on it.' },
    { type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } },
  ]

  /** Brings the Daemon back over the same data dir, as a relaunch after a kill does. */
  async function restartDaemon(adapter: AgentAdapter): Promise<void> {
    await daemon.close()
    daemon = await startDaemon({ dataDir, port: 0, adapter, notify: recordNotification })
  }

  test('kill mid-Session and restart: the Session is failed, the pending Decision and Transcript survive', async () => {
    await restartDaemon(createFakeAgentAdapter({ script: midFlightScript }))
    const session = await launchSession('/repo/a', 'clean the build')
    await expect.poll(() => getPendingDecisions('/decisions')).toHaveLength(1)
    const parked = (await getPendingDecisions('/decisions'))[0]!

    await restartDaemon(createFakeAgentAdapter())

    // The Session shows failed, not running.
    const fetched = getSessionResponseSchema.parse(
      await (await fetch(url(`/sessions/${session.id}`))).json(),
    ).session
    expect(fetched.status).toBe('failed')

    // The Decision is still a reviewable record.
    expect(await getPendingDecisions('/decisions')).toMatchObject([
      {
        id: parked.id,
        sessionId: session.id,
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        status: 'pending',
      },
    ])

    // The full Transcript up to the kill is readable, closed by the recovery failure.
    const events = await collectEvents(`/sessions/${session.id}/events`, 4)
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      'agent_message',
      'decision_requested',
      'session_failed',
    ])
    expect(events.at(-1)?.payload).toEqual({
      error: 'Daemon restarted while the Session was running',
    })
  })

  test('a Session still running at the kill is failed after restart, its Transcript intact', async () => {
    await daemon.close()
    const manual = createManualAdapter()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      adapter: manual.adapter,
      notify: recordNotification,
    })
    const session = await launchSession('/repo/a', 'long task')
    manual.emit({ type: 'agent_message', text: 'still going' })
    const log = createEventLog({ dbPath: daemon.dbPath })
    try {
      await expect.poll(() => log.read({ sessionId: session.id })).toHaveLength(2)
    } finally {
      log.close()
    }

    await restartDaemon(createFakeAgentAdapter())

    expect((await listSessions()).find((s) => s.id === session.id)?.status).toBe('failed')
    const events = await collectEvents(`/sessions/${session.id}/events`, 3)
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      'agent_message',
      'session_failed',
    ])
  })

  test('the Operator is notified when recovery fails a Session', async () => {
    await restartDaemon(createFakeAgentAdapter({ script: midFlightScript }))
    await launchSession('/repo/a', 'clean the build')
    await expect.poll(() => getPendingDecisions('/decisions')).toHaveLength(1)

    await restartDaemon(createFakeAgentAdapter())

    expect(notifications).toContainEqual({
      title: 'a - clean the build',
      body: 'Session failed: Daemon restarted while the Session was running',
    })
  })
})
