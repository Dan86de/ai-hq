import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createEventLog,
  createFakeAgentAdapter,
  createSessionRegistry,
  defaultFakeScript,
  type AgentAdapter,
  type EventLog,
  type SessionRegistry,
} from '../src/index.ts'

let dir: string
let dbPath: string
let eventLog: EventLog
let registry: SessionRegistry

function createRegistry(adapter: AgentAdapter): SessionRegistry {
  registry = createSessionRegistry({ dbPath, eventLog, adapter })
  return registry
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-registry-'))
  dbPath = join(dir, 'hq.db')
  eventLog = createEventLog({ dbPath })
})

afterEach(() => {
  registry.close()
  eventLog.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('session registry', () => {
  test('a launched session starts running and completes when the fake agent finishes', async () => {
    createRegistry(createFakeAgentAdapter())

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'do the thing' })

    expect(session.status).toBe('running')
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')
  })

  test('every fake-adapter event lands in the event log and is readable from a sequence number', async () => {
    createRegistry(createFakeAgentAdapter())

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'do the thing' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')

    const events = eventLog.read({ sessionId: session.id })
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      ...defaultFakeScript.map((e) => e.type),
      'session_completed',
    ])
    expect(events[1]?.payload).toEqual({ text: 'Starting on the task.' })

    const tail = eventLog.read({ sessionId: session.id, fromSeq: events[2]!.seq })
    expect(tail.map((e) => e.type)).toEqual(events.slice(2).map((e) => e.type))
  })

  test('a session fails when the fake agent dies, and the failure is in the log', async () => {
    createRegistry(createFakeAgentAdapter({ failWith: 'fake agent crashed' }))

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'doomed' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('failed')

    const events = eventLog.read({ sessionId: session.id })
    expect(events.at(-1)?.type).toBe('session_failed')
    expect(events.at(-1)?.payload).toEqual({ error: 'fake agent crashed' })
  })

  test('list shows repo, prompt, and status for every session, newest first', async () => {
    createRegistry(createFakeAgentAdapter())

    const first = await registry.launch({ repoPath: '/repo/a', prompt: 'first task' })
    const second = await registry.launch({ repoPath: '/repo/b', prompt: 'second task' })
    await expect.poll(() => registry.get(second.id)?.status).toBe('completed')

    const sessions = registry.list()
    expect(sessions.map((s) => s.id)).toEqual([second.id, first.id])
    expect(sessions[0]).toMatchObject({ repoPath: '/repo/b', prompt: 'second task' })
  })

  test('the sdk session id is stored when an adapter reports it', async () => {
    createRegistry(
      createFakeAgentAdapter({
        script: [{ type: 'agent_initialized', sdkSessionId: 'sdk-123' }],
      }),
    )

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'task' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')

    expect(registry.get(session.id)?.sdkSessionId).toBe('sdk-123')
  })

  test('the fake adapter leaves the sdk session id empty', async () => {
    createRegistry(createFakeAgentAdapter())

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'task' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')

    expect(registry.get(session.id)?.sdkSessionId).toBeNull()
  })

  test('a session fails when the adapter cannot even launch', async () => {
    createRegistry({
      launch: async () => {
        throw new Error('no agent binary')
      },
    })

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'task' })

    expect(registry.get(session.id)?.status).toBe('failed')
    const events = eventLog.read({ sessionId: session.id })
    expect(events.at(-1)?.payload).toEqual({ error: 'no agent binary' })
  })
})

describe('interrupt', () => {
  test('interrupt stops the running agent, records the interruption, and fails the session', async () => {
    createRegistry(
      createFakeAgentAdapter({
        script: [
          { type: 'agent_message', text: 'Working on it.' },
          { type: 'hang' },
          { type: 'agent_message', text: 'never reached' },
        ],
      }),
    )
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'wrong direction' })
    await expect.poll(() => eventLog.read({ sessionId: session.id })).toHaveLength(2)

    const result = await registry.interrupt(session.id)

    expect(result.outcome).toBe('interrupted')
    if (result.outcome !== 'interrupted') throw new Error('unreachable')
    expect(result.session.status).toBe('failed')
    expect(registry.get(session.id)?.status).toBe('failed')

    // The agent stopped for real and the unwinding pump added no terminal Event
    // of its own: the log ends at session_interrupted, with nothing after it.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(eventLog.read({ sessionId: session.id }).map((e) => e.type)).toEqual([
      'session_launched',
      'agent_message',
      'session_interrupted',
    ])
  })

  test('interrupting a finished session reports not_running and appends nothing', async () => {
    createRegistry(createFakeAgentAdapter())
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'task' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')
    const before = eventLog.read({ sessionId: session.id })

    const result = await registry.interrupt(session.id)

    expect(result.outcome).toBe('not_running')
    if (result.outcome !== 'not_running') throw new Error('unreachable')
    expect(result.session.status).toBe('completed')
    expect(eventLog.read({ sessionId: session.id })).toEqual(before)
  })

  test('interrupting an unknown session reports not_found', async () => {
    createRegistry(createFakeAgentAdapter())

    expect(await registry.interrupt('unknown')).toEqual({ outcome: 'not_found' })
  })
})
