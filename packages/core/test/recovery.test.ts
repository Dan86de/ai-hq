import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
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

/** Simulates a Daemon restart: fresh instances over the same database, then recovery. */
function restart(): void {
  registry.close()
  queue.close()
  eventLog.close()
  eventLog = createEventLog({ dbPath })
  queue = createDecisionQueue({ dbPath, eventLog })
  registry = createSessionRegistry({
    dbPath,
    eventLog,
    adapter: createFakeAgentAdapter(),
    gate: createPermissionGate({ decisionQueue: queue }),
  })
  queue.recover()
  registry.recover()
}

/** Wipes a Projection table behind the modules' backs, as a crash-torn write would. */
function wipeTable(table: 'sessions' | 'decisions'): void {
  const db = new Database(dbPath)
  try {
    db.prepare(`DELETE FROM ${table}`).run()
  } finally {
    db.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-recovery-'))
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

describe('restart recovery', () => {
  test('a Session mid-flight when the Daemon dies is failed on recovery, and the Transcript records why', async () => {
    createGatedRegistry([{ type: 'agent_message', text: 'Working on it.' }, gatedBash])
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)
    expect(registry.get(session.id)?.status).toBe('waiting_on_human')

    restart()

    expect(registry.get(session.id)?.status).toBe('failed')
    const events = eventLog.read({ sessionId: session.id })
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

  test('a Decision pending at kill time stays pending and reviewable after recovery', async () => {
    createGatedRegistry([gatedBash])
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)

    restart()

    expect(queue.pending()).toMatchObject([
      {
        sessionId: session.id,
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        status: 'pending',
        note: null,
        decidedAt: null,
      },
    ])
  })

  test('recovery is idempotent and leaves finished Sessions alone', async () => {
    createGatedRegistry([gatedBash])
    const parked = await registry.launch({ repoPath: '/repo/a', prompt: 'parked task' })
    await expect.poll(() => queue.pending()).toHaveLength(1)
    registry.close()
    registry = createSessionRegistry({
      dbPath,
      eventLog,
      adapter: createFakeAgentAdapter(),
      gate: createPermissionGate({ decisionQueue: queue }),
    })
    const finished = await registry.launch({ repoPath: '/repo/b', prompt: 'finished task' })
    await expect.poll(() => registry.get(finished.id)?.status).toBe('completed')

    restart()
    const afterFirst = eventLog.read()
    restart()

    expect(eventLog.read()).toEqual(afterFirst)
    expect(registry.get(parked.id)?.status).toBe('failed')
    expect(registry.get(finished.id)?.status).toBe('completed')
    expect(queue.pending()).toHaveLength(1)
  })

  test('an interrupted Session stays failed after recovery, with no extra Events', async () => {
    createGatedRegistry([{ type: 'agent_message', text: 'Working on it.' }, { type: 'hang' }])
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'wrong direction' })
    await expect.poll(() => eventLog.read({ sessionId: session.id })).toHaveLength(2)
    await registry.interrupt(session.id)

    restart()

    // session_interrupted is terminal: recovery must not fail the Session again.
    expect(registry.get(session.id)?.status).toBe('failed')
    expect(eventLog.read({ sessionId: session.id }).map((e) => e.type)).toEqual([
      'session_launched',
      'agent_message',
      'session_interrupted',
    ])
  })

  test('recover rebuilds the sessions Projection from the Event Log alone', async () => {
    createGatedRegistry([{ type: 'agent_initialized', sdkSessionId: 'sdk-123' }])
    const session = await registry.launch({ repoPath: '/repo/a', prompt: 'do the thing' })
    await expect.poll(() => registry.get(session.id)?.status).toBe('completed')

    wipeTable('sessions')
    expect(registry.get(session.id)).toBeUndefined()
    registry.recover()

    expect(registry.get(session.id)).toMatchObject({
      id: session.id,
      repoPath: '/repo/a',
      prompt: 'do the thing',
      status: 'completed',
      sdkSessionId: 'sdk-123',
    })
  })

  test('recover rebuilds the decisions Projection from the Event Log alone, without resurrecting decided ones', async () => {
    createGatedRegistry([
      gatedBash,
      { type: 'gated_tool_call', toolName: 'Write', input: { path: 'notes.md' } },
    ])
    await registry.launch({ repoPath: '/repo/a', prompt: 'clean the build' })
    await expect.poll(() => queue.pending()).toHaveLength(1)
    const denied = queue.pending()[0]!
    queue.decide(denied.id, { behavior: 'deny', note: 'keep the build' })
    await expect.poll(() => queue.pending().map((d) => d.toolName)).toEqual(['Write'])

    wipeTable('decisions')
    expect(queue.pending()).toHaveLength(0)
    queue.recover()

    expect(queue.pending()).toMatchObject([
      { toolName: 'Write', input: { path: 'notes.md' }, status: 'pending' },
    ])
    const rebuilt = queue.decide(denied.id, { behavior: 'approve' })
    expect(rebuilt.outcome).toBe('already_decided')
    if (rebuilt.outcome !== 'already_decided') throw new Error('unreachable')
    expect(rebuilt.decision).toMatchObject({ status: 'denied', note: 'keep the build' })
    expect(rebuilt.decision.decidedAt).not.toBeNull()
  })
})
