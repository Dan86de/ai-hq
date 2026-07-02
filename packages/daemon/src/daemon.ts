import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import {
  createDecisionQueue,
  createEventLog,
  createNotifier,
  createPermissionGate,
  createSessionRegistry,
  type AgentAdapter,
  type NotificationDeliverer,
} from '@ai-hq/core'
import { createClaudeAgentAdapter } from '@ai-hq/adapter-claude'
import { createApp } from './app.ts'
import { deliverWithOsascript } from './osascript.ts'

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
  /** Delivers Notifications to the Operator; defaults to macOS notifications via osascript. */
  notify?: NotificationDeliverer
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
  const notifier = createNotifier({
    eventLog,
    sessions: registry,
    deliver: options.notify ?? deliverWithOsascript,
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
      notifier.close()
      registry.close()
      decisionQueue.close()
      eventLog.close()
    },
  }
}
