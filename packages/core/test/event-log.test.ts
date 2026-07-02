import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEventLog, type EventLog, type HqEvent } from '../src/index.ts'

let dir: string
let dbPath: string
let log: EventLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-event-log-'))
  dbPath = join(dir, 'hq.db')
  log = createEventLog({ dbPath })
})

afterEach(() => {
  log.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('event log', () => {
  test('append assigns increasing sequence numbers and read returns events in order', () => {
    const first = log.append({ sessionId: 's1', type: 'agent_message', payload: { text: 'a' } })
    const second = log.append({ sessionId: 's1', type: 'tool_call', payload: { toolName: 'read_file' } })

    expect(second.seq).toBeGreaterThan(first.seq)
    expect(log.read().map((e) => e.type)).toEqual(['agent_message', 'tool_call'])
  })

  test('read from a sequence number returns that event and everything after it', () => {
    log.append({ sessionId: 's1', type: 'one', payload: {} })
    const middle = log.append({ sessionId: 's1', type: 'two', payload: {} })
    log.append({ sessionId: 's1', type: 'three', payload: {} })

    expect(log.read({ fromSeq: middle.seq }).map((e) => e.type)).toEqual(['two', 'three'])
  })

  test('read filters by session', () => {
    log.append({ sessionId: 's1', type: 'one', payload: {} })
    log.append({ sessionId: 's2', type: 'two', payload: {} })

    expect(log.read({ sessionId: 's2' }).map((e) => e.type)).toEqual(['two'])
  })

  test('payloads round-trip', () => {
    log.append({ sessionId: 's1', type: 'tool_call', payload: { toolName: 'bash', input: { cmd: 'ls' } } })

    expect(log.read()[0]?.payload).toEqual({ toolName: 'bash', input: { cmd: 'ls' } })
  })

  test('subscribers receive appended events until they unsubscribe', () => {
    const seen: HqEvent[] = []
    const unsubscribe = log.subscribe((event) => seen.push(event))

    log.append({ sessionId: 's1', type: 'one', payload: {} })
    unsubscribe()
    log.append({ sessionId: 's1', type: 'two', payload: {} })

    expect(seen.map((e) => e.type)).toEqual(['one'])
  })

  test('events survive closing and reopening the log', () => {
    log.append({ sessionId: 's1', type: 'one', payload: { text: 'kept' } })
    log.close()

    log = createEventLog({ dbPath })
    const events = log.read({ fromSeq: 0 })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ text: 'kept' })
  })
})
