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

describe('interrupting a session', () => {
  test('interrupt stops a running session and records the interruption as an Event', async () => {
    createRegistry(createFakeAgentAdapter({ runUntilInterrupted: true }))
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'long task' })
    // The script has been pumped and the agent is still working.
    await expect
      .poll(() => eventLog.read({ sessionId: session.id }))
      .toHaveLength(1 + defaultFakeScript.length)
    expect(registry.get(session.id)?.status).toBe('running')

    const result = await registry.interrupt(session.id)

    expect(result).toMatchObject({
      outcome: 'interrupted',
      session: { id: session.id, status: 'interrupted' },
    })
    expect(registry.get(session.id)?.status).toBe('interrupted')
    expect(eventLog.read({ sessionId: session.id }).at(-1)?.type).toBe('session_interrupted')
  })

  test('the interruption is the last word: the terminated run completes nothing afterwards', async () => {
    createRegistry(createFakeAgentAdapter({ runUntilInterrupted: true }))
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'long task' })

    await registry.interrupt(session.id)
    // Give the terminated run's pump every chance to misbehave before asserting.
    await new Promise((resolve) => setTimeout(resolve, 25))

    const types = eventLog.read({ sessionId: session.id }).map((e) => e.type)
    expect(types.at(-1)).toBe('session_interrupted')
    expect(types).not.toContain('session_completed')
    expect(types).not.toContain('session_failed')
    expect(registry.get(session.id)?.status).toBe('interrupted')
  })

  test('interrupting a finished session reports not_running and changes nothing', async () => {
    createRegistry(createFakeAgentAdapter())
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'task' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')

    const result = await registry.interrupt(session.id)

    expect(result).toMatchObject({ outcome: 'not_running', session: { status: 'completed' } })
    expect(eventLog.read({ sessionId: session.id }).at(-1)?.type).toBe('session_completed')
  })

  test('interrupting an unknown session reports not_found', async () => {
    createRegistry(createFakeAgentAdapter())

    expect(await registry.interrupt('unknown')).toEqual({ outcome: 'not_found' })
  })
})
