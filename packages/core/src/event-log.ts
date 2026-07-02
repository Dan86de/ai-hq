import Database from 'better-sqlite3'
import type { HqEvent, NewHqEvent } from './events.ts'

export interface EventLog {
  append(event: NewHqEvent): HqEvent
  read(options?: { fromSeq?: number; sessionId?: string }): HqEvent[]
  subscribe(listener: (event: HqEvent) => void): () => void
  close(): void
}

interface EventRow {
  seq: number
  session_id: string
  type: string
  payload: string
  ts: string
}

function toHqEvent(row: EventRow): HqEvent {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    ts: row.ts,
  }
}

export function createEventLog(options: { dbPath: string }): EventLog {
  const db = new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
  `)

  const insertStmt = db.prepare(
    'INSERT INTO events (session_id, type, payload, ts) VALUES (?, ?, ?, ?)',
  )
  const listeners = new Set<(event: HqEvent) => void>()

  return {
    append(event) {
      const ts = new Date().toISOString()
      const result = insertStmt.run(event.sessionId, event.type, JSON.stringify(event.payload), ts)
      const appended: HqEvent = {
        seq: Number(result.lastInsertRowid),
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload,
        ts,
      }
      for (const listener of [...listeners]) {
        try {
          listener(appended)
        } catch {
          // A failing subscriber must never break the log.
        }
      }
      return appended
    },

    read(options = {}) {
      const fromSeq = options.fromSeq ?? 0
      const rows =
        options.sessionId === undefined
          ? db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq').all(fromSeq)
          : db
              .prepare('SELECT * FROM events WHERE seq >= ? AND session_id = ? ORDER BY seq')
              .all(fromSeq, options.sessionId)
      return (rows as EventRow[]).map(toHqEvent)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    close() {
      db.close()
    },
  }
}
