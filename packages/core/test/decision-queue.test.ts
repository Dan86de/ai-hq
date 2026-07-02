import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createDecisionQueue,
  createEventLog,
  createFakeAgentAdapter,
  createPermissionGate,
  createSessionRegistry,
  type DecisionQueue,
  type EventLog,
  type FakeAgentStep,
  type SessionRegistry,
} from '../src/index.ts'

let dir: string
let dbPath: string
let eventLog: EventLog
let queue: DecisionQueue
let registry: SessionRegistry

function createGatedRegistry(script: FakeAgentStep[]): SessionRegistry {
  registry = createSessionRegistry({
    dbPath,
    eventLog,
    adapter: createFakeAgentAdapter({ script }),
    gate: createPermissionGate({ decisionQueue: queue }),
  })
  return registry
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-decisions-'))
  dbPath = join(dir, 'hq.db')
  eventLog = createEventLog({ dbPath })
  queue = createDecisionQueue({ dbPath, eventLog })
})

afterEach(() => {
  registry.close()
  queue.close()
  eventLog.close()
  rmSync(dir, { recursive: true, force: true })
})

const gatedBash: FakeAgentStep = {
  type: 'gated_tool_call',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
}

describe('decision queue', () => {
  test('a non-allowlisted tool call parks as a pending Decision and the Session waits on the human', async () => {
    createGatedRegistry([gatedBash])

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })

    await expect.poll(() => queue.pending()).toHaveLength(1)
    const decision = queue.pending()[0]!
    expect(decision).toMatchObject({
      sessionId: session.id,
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      status: 'pending',
      note: null,
      decidedAt: null,
    })
    expect(decision.createdAt).not.toBe('')
    expect(registry.get(session.id)?.status).toBe('waiting_on_human')
  })

  test('an allowlisted tool executes without creating a Decision or interrupting the Operator', async () => {
    createGatedRegistry([
      { type: 'gated_tool_call', toolName: 'Read', input: { path: 'README.md' } },
    ])

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'read the readme' })

    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')
    expect(queue.pending()).toHaveLength(0)
    const events = eventLog.read({ sessionId: session.id })
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      'tool_call',
      'session_completed',
    ])
  })

  test('approving resumes the Session and the gated call executes', async () => {
    createGatedRegistry([gatedBash, { type: 'agent_message', text: 'Build cleaned.' }])

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)

    const result = queue.decide(queue.pending()[0]!.id, { behavior: 'approve' })

    expect(result.outcome).toBe('decided')
    if (result.outcome !== 'decided') throw new Error('unreachable')
    expect(result.decision.status).toBe('approved')
    expect(result.decision.decidedAt).not.toBeNull()

    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')
    const events = eventLog.read({ sessionId: session.id })
    expect(events.map((e) => e.type)).toEqual([
      'session_launched',
      'decision_requested',
      'decision_decided',
      'tool_call',
      'agent_message',
      'session_completed',
    ])
    expect(events[3]?.payload).toEqual({ toolName: 'Bash', input: { command: 'rm -rf build' } })
  })

  test('denying with a note relays the note to the agent, which adjusts course', async () => {
    createGatedRegistry([gatedBash])

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)

    const result = queue.decide(queue.pending()[0]!.id, {
      behavior: 'deny',
      note: 'keep the build, clean only the cache',
    })

    expect(result.outcome).toBe('decided')
    if (result.outcome !== 'decided') throw new Error('unreachable')
    expect(result.decision).toMatchObject({
      status: 'denied',
      note: 'keep the build, clean only the cache',
    })

    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')
    const events = eventLog.read({ sessionId: session.id })
    const adjustment = events.find((e) => e.type === 'agent_message')
    expect(adjustment?.payload).toEqual({
      text: 'Tool Bash was denied: keep the build, clean only the cache. Adjusting course.',
    })
    expect(events.map((e) => e.type)).not.toContain('tool_call')
  })

  test('pending lists Decisions per Session and across all Sessions', async () => {
    createGatedRegistry([gatedBash])

    const first = await registry.launch({ repoPath: '/repo/a', prompt: 'task a' })
    const second = await registry.launch({ repoPath: '/repo/b', prompt: 'task b' })
    await expect.poll(() => queue.pending()).toHaveLength(2)

    expect(queue.pending(first.id)).toHaveLength(1)
    expect(queue.pending(second.id)).toHaveLength(1)
    expect(queue.pending(first.id)[0]?.sessionId).toBe(first.id)
  })

  test('a pending Decision survives as a record when the queue is reopened', async () => {
    createGatedRegistry([gatedBash])

    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)
    queue.close()

    queue = createDecisionQueue({ dbPath, eventLog })
    expect(queue.pending()).toMatchObject([
      {
        sessionId: session.id,
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        status: 'pending',
      },
    ])
  })

  test('deciding an unknown Decision reports not_found', () => {
    createGatedRegistry([])

    expect(queue.decide('unknown', { behavior: 'approve' })).toEqual({ outcome: 'not_found' })
  })

  test('deciding twice reports already_decided and keeps the first Verdict', async () => {
    createGatedRegistry([gatedBash])

    await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)
    const id = queue.pending()[0]!.id

    queue.decide(id, { behavior: 'deny', note: 'not now' })
    const second = queue.decide(id, { behavior: 'approve' })

    expect(second.outcome).toBe('already_decided')
    if (second.outcome !== 'already_decided') throw new Error('unreachable')
    expect(second.decision).toMatchObject({ status: 'denied', note: 'not now' })
  })
})
