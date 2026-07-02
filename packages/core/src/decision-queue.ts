import { randomUUID } from 'node:crypto'
import Database, { type Statement } from 'better-sqlite3'
import { z } from 'zod'
import type { Decision, DecisionStatus, Verdict } from './contracts.ts'
import type { EventLog } from './event-log.ts'

// The gate (CONTEXT.md: Decision Queue). request() parks a Gated tool call as a
// pending Decision until the Operator's Verdict resolves it; everything about
// persistence, promise parking, and Session status flips is hidden here.

export interface DecisionRequest {
  sessionId: string
  toolName: string
  input: unknown
}

export type DecideResult =
  | { outcome: 'decided'; decision: Decision }
  | { outcome: 'not_found' }
  | { outcome: 'already_decided'; decision: Decision }

export interface DecisionQueue {
  /** Parks the call as a pending Decision and resolves with the Operator's Verdict. */
  request(request: DecisionRequest): Promise<Verdict>
  decide(id: string, verdict: Verdict): DecideResult
  /** Pending Decisions, oldest first; per Session when an id is given, across all Sessions otherwise. */
  pending(sessionId?: string): Decision[]
  /**
   * Startup reconciliation: rebuilds the decisions Projection from the Event Log.
   * A Decision pending when the previous Daemon died stays pending and
   * reviewable. Call before any request parks.
   */
  recover(): void
  close(): void
}

interface DecisionRow {
  id: string
  session_id: string
  tool_name: string
  input: string
  status: string
  note: string | null
  created_at: string
  decided_at: string | null
}

const requestedPayloadSchema = z.object({
  decisionId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
})
const decidedPayloadSchema = z.object({
  decisionId: z.string(),
  status: z.enum(['approved', 'denied']),
  note: z.string().nullable(),
})

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input),
    status: row.status as DecisionStatus,
    note: row.note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }
}

export function createDecisionQueue(options: { dbPath: string; eventLog: EventLog }): DecisionQueue {
  const { eventLog } = options
  const db = new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_pending ON decisions(status, session_id);
  `)

  const insertStmt = db.prepare(
    'INSERT INTO decisions (id, session_id, tool_name, input, status, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const getStmt = db.prepare('SELECT * FROM decisions WHERE id = ?')
  const decideStmt = db.prepare(
    "UPDATE decisions SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
  )
  const pendingAllStmt = db.prepare(
    "SELECT * FROM decisions WHERE status = 'pending' ORDER BY created_at, rowid",
  )
  const pendingBySessionStmt = db.prepare(
    "SELECT * FROM decisions WHERE status = 'pending' AND session_id = ? ORDER BY created_at, rowid",
  )
  // The sessions table is created by the SessionRegistry, which is constructed
  // after the queue, so its statements are prepared on first use.
  let parkSessionStmt: Statement | undefined
  let resumeSessionStmt: Statement | undefined

  const parked = new Map<string, (verdict: Verdict) => void>()

  function flipToWaiting(sessionId: string): void {
    parkSessionStmt ??= db.prepare(
      "UPDATE sessions SET status = 'waiting_on_human', updated_at = ? WHERE id = ? AND status = 'running'",
    )
    parkSessionStmt.run(new Date().toISOString(), sessionId)
  }

  function flipToRunning(sessionId: string): void {
    // The Session keeps waiting while any of its Decisions is still pending.
    if (pendingBySessionStmt.all(sessionId).length > 0) return
    resumeSessionStmt ??= db.prepare(
      "UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_on_human'",
    )
    resumeSessionStmt.run(new Date().toISOString(), sessionId)
  }

  return {
    request(request) {
      const id = randomUUID()
      const now = new Date().toISOString()
      insertStmt.run(
        id,
        request.sessionId,
        request.toolName,
        JSON.stringify(request.input ?? null),
        'pending',
        null,
        now,
        null,
      )
      eventLog.append({
        sessionId: request.sessionId,
        type: 'decision_requested',
        payload: { decisionId: id, toolName: request.toolName, input: request.input },
      })
      flipToWaiting(request.sessionId)
      return new Promise<Verdict>((resolve) => {
        parked.set(id, resolve)
      })
    },

    decide(id, verdict) {
      const row = getStmt.get(id) as DecisionRow | undefined
      if (row === undefined) return { outcome: 'not_found' }
      if (row.status !== 'pending') return { outcome: 'already_decided', decision: toDecision(row) }

      const status: DecisionStatus = verdict.behavior === 'approve' ? 'approved' : 'denied'
      const note = verdict.behavior === 'deny' ? (verdict.note ?? null) : null
      decideStmt.run(status, note, new Date().toISOString(), id)
      eventLog.append({
        sessionId: row.session_id,
        type: 'decision_decided',
        payload: { decisionId: id, status, note },
      })
      flipToRunning(row.session_id)

      const resolve = parked.get(id)
      parked.delete(id)
      resolve?.(verdict)
      return { outcome: 'decided', decision: toDecision(getStmt.get(id) as DecisionRow) }
    },

    pending(sessionId) {
      const rows =
        sessionId === undefined ? pendingAllStmt.all() : pendingBySessionStmt.all(sessionId)
      return (rows as DecisionRow[]).map(toDecision)
    },

    recover() {
      // Decisions are a Projection: compute every row from the Event Log alone.
      const rows = new Map<string, DecisionRow>()
      for (const event of eventLog.read()) {
        if (event.type === 'decision_requested') {
          const payload = requestedPayloadSchema.safeParse(event.payload)
          if (!payload.success) continue
          rows.set(payload.data.decisionId, {
            id: payload.data.decisionId,
            session_id: event.sessionId,
            tool_name: payload.data.toolName,
            input: JSON.stringify(payload.data.input ?? null),
            status: 'pending',
            note: null,
            created_at: event.ts,
            decided_at: null,
          })
        } else if (event.type === 'decision_decided') {
          const payload = decidedPayloadSchema.safeParse(event.payload)
          if (!payload.success) continue
          const row = rows.get(payload.data.decisionId)
          if (row === undefined) continue
          row.status = payload.data.status
          row.note = payload.data.note
          row.decided_at = event.ts
        }
      }

      const rebuild = db.transaction((all: DecisionRow[]) => {
        db.prepare('DELETE FROM decisions').run()
        for (const row of all) {
          insertStmt.run(
            row.id,
            row.session_id,
            row.tool_name,
            row.input,
            row.status,
            row.note,
            row.created_at,
            row.decided_at,
          )
        }
      })
      rebuild([...rows.values()])
    },

    close() {
      db.close()
    },
  }
}
