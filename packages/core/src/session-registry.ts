import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { AgentAdapter, AgentRun } from './agent-adapter.ts'
import type { Session, SessionStatus } from './contracts.ts'
import type { EventLog } from './event-log.ts'
import type { PermissionGate } from './permission-gate.ts'

export interface LaunchInput {
  repoPath: string
  prompt: string
}

export interface SessionRegistry {
  launch(input: LaunchInput): Promise<Session>
  get(id: string): Session | undefined
  list(): Session[]
  /**
   * Startup reconciliation: rebuilds the sessions Projection from the Event Log
   * and fails Sessions whose agent process died with the previous Daemon,
   * recording each failure as a session_failed Event. Call before any launch.
   */
  recover(): void
  close(): void
}

interface SessionRow {
  id: string
  repo_path: string
  prompt: string
  status: string
  sdk_session_id: string | null
  created_at: string
  updated_at: string
}

const launchedPayloadSchema = z.object({ repoPath: z.string(), prompt: z.string() })
const initializedPayloadSchema = z.object({ sdkSessionId: z.string() })

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    repoPath: row.repo_path,
    prompt: row.prompt,
    status: row.status as SessionStatus,
    sdkSessionId: row.sdk_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createSessionRegistry(options: {
  dbPath: string
  eventLog: EventLog
  adapter: AgentAdapter
  /** Gate for the agent's tool calls; without one, every call is allowed through. */
  gate?: PermissionGate
}): SessionRegistry {
  const { eventLog, adapter } = options
  const gate: PermissionGate = options.gate ?? (async () => ({ behavior: 'approve' }))
  const db = new Database(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  // The sdk_session_id column exists from day one; the fake adapter leaves it empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      sdk_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const insertStmt = db.prepare(
    'INSERT INTO sessions (id, repo_path, prompt, status, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const getStmt = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const listStmt = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC')
  const setStatusStmt = db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
  const setSdkSessionIdStmt = db.prepare(
    'UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?',
  )

  let closed = false

  function setStatus(id: string, status: SessionStatus): void {
    if (closed) return
    setStatusStmt.run(status, new Date().toISOString(), id)
  }

  async function pump(sessionId: string, run: AgentRun): Promise<void> {
    try {
      for await (const event of run.events) {
        if (closed) return
        if (event.type === 'agent_initialized') {
          setSdkSessionIdStmt.run(event.sdkSessionId, new Date().toISOString(), sessionId)
        }
        const { type, ...payload } = event
        eventLog.append({ sessionId, type, payload })
      }
      if (closed) return
      eventLog.append({ sessionId, type: 'session_completed', payload: {} })
      setStatus(sessionId, 'completed')
    } catch (error) {
      if (closed) return
      const message = error instanceof Error ? error.message : String(error)
      eventLog.append({ sessionId, type: 'session_failed', payload: { error: message } })
      setStatus(sessionId, 'failed')
    }
  }

  return {
    async launch(input) {
      const id = randomUUID()
      const now = new Date().toISOString()
      insertStmt.run(id, input.repoPath, input.prompt, 'running', null, now, now)
      eventLog.append({
        sessionId: id,
        type: 'session_launched',
        payload: { repoPath: input.repoPath, prompt: input.prompt },
      })
      try {
        const run = await adapter.launch({
          repoPath: input.repoPath,
          prompt: input.prompt,
          requestPermission: (request) => gate(id, request),
        })
        void pump(id, run)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        eventLog.append({ sessionId: id, type: 'session_failed', payload: { error: message } })
        setStatus(id, 'failed')
      }
      return toSession(getStmt.get(id) as SessionRow)
    },

    get(id) {
      const row = getStmt.get(id) as SessionRow | undefined
      return row === undefined ? undefined : toSession(row)
    },

    list() {
      return (listStmt.all() as SessionRow[]).map(toSession)
    },

    recover() {
      // Sessions are a Projection: compute every row from the Event Log alone.
      const rows = new Map<string, SessionRow>()
      for (const event of eventLog.read()) {
        if (event.type === 'session_launched') {
          const payload = launchedPayloadSchema.safeParse(event.payload)
          rows.set(event.sessionId, {
            id: event.sessionId,
            repo_path: payload.success ? payload.data.repoPath : '',
            prompt: payload.success ? payload.data.prompt : '',
            status: 'running',
            sdk_session_id: null,
            created_at: event.ts,
            updated_at: event.ts,
          })
          continue
        }
        const row = rows.get(event.sessionId)
        if (row === undefined) continue
        if (event.type === 'agent_initialized') {
          const payload = initializedPayloadSchema.safeParse(event.payload)
          if (payload.success) {
            row.sdk_session_id = payload.data.sdkSessionId
            row.updated_at = event.ts
          }
        } else if (event.type === 'session_completed') {
          row.status = 'completed'
          row.updated_at = event.ts
        } else if (event.type === 'session_failed') {
          row.status = 'failed'
          row.updated_at = event.ts
        }
      }

      // A Session the log leaves non-terminal had its agent process die with
      // the previous Daemon. Record the failure in the Event Log first - the
      // log is the source of truth, and the Transcript shows why it ended.
      for (const row of rows.values()) {
        if (row.status === 'completed' || row.status === 'failed') continue
        const failed = eventLog.append({
          sessionId: row.id,
          type: 'session_failed',
          payload: { error: 'Daemon restarted while the Session was running' },
        })
        row.status = 'failed'
        row.updated_at = failed.ts
      }

      const rebuild = db.transaction((all: SessionRow[]) => {
        db.prepare('DELETE FROM sessions').run()
        for (const row of all) {
          insertStmt.run(
            row.id,
            row.repo_path,
            row.prompt,
            row.status,
            row.sdk_session_id,
            row.created_at,
            row.updated_at,
          )
        }
      })
      rebuild([...rows.values()])
    },

    close() {
      closed = true
      db.close()
    },
  }
}
