import { homedir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from './daemon.ts'

const dataDir = process.env['HQ_DATA_DIR'] ?? join(homedir(), '.ai-hq')
const port = Number(process.env['HQ_PORT'] ?? 4747)

const daemon = await startDaemon({ dataDir, port })
console.log(`hq daemon listening on http://127.0.0.1:${daemon.port} (data: ${daemon.dbPath})`)
