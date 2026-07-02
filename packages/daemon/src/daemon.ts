import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import {
  createDecisionQueue,
  createEventLog,
  createPermissionGate,
  createSessionRegistry,
  type AgentAdapter,
} from '@ai-hq/core'
import { createClaudeAgentAdapter } from '@ai-hq/adapter-claude'
import { createApp } from './app.ts'

export interface Daemon {
  port: number
  dbPath: string
  close(): Promise<void>
}

export interface StartDaemonOptions {
  dataDir: string
  /** Port to listen on; 0 picks a free one. */
  port: number
  /** AgentAdapter Sessions run on; defaults to the real Claude adapter. Tests inject the fake. */
  adapter?: AgentAdapter
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  mkdirSync(options.dataDir, { recursive: true })
  const dbPath = join(options.dataDir, 'hq.db')
  const eventLog = createEventLog({ dbPath })
  const decisionQueue = createDecisionQueue({ dbPath, eventLog })
  const registry = createSessionRegistry({
    dbPath,
    eventLog,
    adapter: options.adapter ?? createClaudeAgentAdapter(),
    gate: createPermissionGate({ decisionQueue }),
  })
  const app = createApp({ registry, eventLog, decisionQueue })

  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server: ServerType = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: options.port },
      (info) => resolve({ server, port: info.port }),
    )
  })

  return {
    port,
    dbPath,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // SSE connections stay open indefinitely; close() alone would wait on them forever.
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
      registry.close()
      decisionQueue.close()
      eventLog.close()
    },
  }
}
