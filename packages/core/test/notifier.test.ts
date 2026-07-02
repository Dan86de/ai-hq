import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createEventLog,
  createNotifier,
  type EventLog,
  type Notification,
  type Notifier,
  type Session,
} from '../src/index.ts'

const session: Session = {
  id: 'session-1',
  repoPath: '/Users/dan/code/ai-hq',
  prompt: 'fix the login bug',
  status: 'running',
  sdkSessionId: null,
  createdAt: '2026-07-02T10:00:00.000Z',
  updatedAt: '2026-07-02T10:00:00.000Z',
}

let dir: string
let log: EventLog
let notifications: Notification[]
let notifier: Notifier

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-notifier-'))
  log = createEventLog({ dbPath: join(dir, 'hq.db') })
  notifications = []
  notifier = createNotifier({
    eventLog: log,
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    deliver: (notification) => notifications.push(notification),
  })
})

afterEach(() => {
  notifier.close()
  log.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('notifier', () => {
  test('a parked Decision notifies, naming the Session and the gated tool', () => {
    log.append({
      sessionId: session.id,
      type: 'decision_requested',
      payload: { decisionId: 'd1', toolName: 'Bash', input: { command: 'rm -rf build' } },
    })

    expect(notifications).toEqual([
      { title: 'ai-hq - fix the login bug', body: 'Decision parked: Bash' },
    ])
  })

  test('a completed Session notifies', () => {
    log.append({ sessionId: session.id, type: 'session_completed', payload: {} })

    expect(notifications).toEqual([
      { title: 'ai-hq - fix the login bug', body: 'Session completed' },
    ])
  })

  test('a failed Session notifies with the error', () => {
    log.append({ sessionId: session.id, type: 'session_failed', payload: { error: 'boom' } })

    expect(notifications).toEqual([
      { title: 'ai-hq - fix the login bug', body: 'Session failed: boom' },
    ])
  })

  test('other Events do not notify', () => {
    log.append({ sessionId: session.id, type: 'session_launched', payload: {} })
    log.append({ sessionId: session.id, type: 'agent_message', payload: { text: 'working' } })
    log.append({ sessionId: session.id, type: 'tool_call', payload: { toolName: 'read_file' } })
    log.append({ sessionId: session.id, type: 'decision_decided', payload: { decisionId: 'd1' } })

    expect(notifications).toEqual([])
  })

  test('a long prompt is shortened in the Session label', () => {
    const longPromptSession = { ...session, prompt: 'a'.repeat(60) }
    const scoped = createNotifier({
      eventLog: log,
      sessions: { get: () => longPromptSession },
      deliver: (notification) => notifications.push(notification),
    })
    try {
      log.append({ sessionId: session.id, type: 'session_completed', payload: {} })

      expect(notifications.at(-1)?.title).toBe(`ai-hq - ${'a'.repeat(40)}...`)
    } finally {
      scoped.close()
    }
  })

  test('an unknown Session still notifies, labeled by its id', () => {
    log.append({ sessionId: 'ghost-session', type: 'session_failed', payload: {} })

    expect(notifications).toEqual([{ title: 'Session ghost-se', body: 'Session failed' }])
  })

  test('a malformed decision_requested payload still notifies', () => {
    log.append({ sessionId: session.id, type: 'decision_requested', payload: null })

    expect(notifications).toEqual([
      { title: 'ai-hq - fix the login bug', body: 'Decision parked: a gated tool call' },
    ])
  })

  test('close() stops notifications', () => {
    notifier.close()

    log.append({ sessionId: session.id, type: 'session_completed', payload: {} })

    expect(notifications).toEqual([])
  })
})
