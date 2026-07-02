import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { createEventLog, createFakeAgentAdapter, createSessionRegistry } from '@ai-hq/core'
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
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  mkdirSync(options.dataDir, { recursive: true })
  const dbPath = join(options.dataDir, 'hq.db')
  const eventLog = createEventLog({ dbPath })
  const registry = createSessionRegistry({
    dbPath,
    eventLog,
    // adapter-claude arrives in a later slice; the walking skeleton runs on the fake.
    adapter: createFakeAgentAdapter(),
  })
  const app = createApp({ registry })

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
      })
      registry.close()
      eventLog.close()
    },
  }
}
