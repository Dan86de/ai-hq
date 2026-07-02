import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createFakeAgentAdapter } from '@ai-hq/core'
import { startDaemon, type Daemon } from '@ai-hq/daemon'

const execFileAsync = promisify(execFile)
const hqBin = fileURLToPath(new URL('../bin/hq.mjs', import.meta.url))
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let dataDir: string
let daemon: Daemon

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-cli-'))
  daemon = await startDaemon({ dataDir, port: 0, adapter: createFakeAgentAdapter() })
})

afterAll(async () => {
  await daemon.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function hq(args: string[], envOverrides: Record<string, string> = {}) {
  return execFileAsync(process.execPath, [hqBin, ...args], {
    env: { ...process.env, HQ_URL: `http://127.0.0.1:${daemon.port}`, ...envOverrides },
    timeout: 30_000,
  })
}

describe('hq CLI', { timeout: 60_000 }, () => {
  test('hq run launches a Session through the Daemon and prints its id, and hq ls lists it', async () => {
    const repo = dataDir
    const { stdout } = await hq(['run', '--repo', repo, '--prompt', 'Add a health endpoint'])
    const sessionId = stdout.trim()
    expect(sessionId).toMatch(UUID_PATTERN)

    await expect
      .poll(async () => (await hq(['ls'])).stdout, { interval: 500, timeout: 30_000 })
      .toContain('completed')

    const { stdout: ls } = await hq(['ls'])
    expect(ls).toContain(sessionId.slice(0, 8))
    expect(ls).toContain(repo)
    expect(ls).toContain('Add a health endpoint')
    expect(ls).toContain('STATUS')
  })

  test('hq ls summarizes long prompts', async () => {
    const longPrompt =
      'Refactor the entire authentication flow to use passkeys and remove the legacy password path'
    await hq(['run', '--repo', dataDir, '--prompt', longPrompt])

    const { stdout } = await hq(['ls'])
    expect(stdout).toContain(`${longPrompt.slice(0, 37)}...`)
    expect(stdout).not.toContain(longPrompt)
  })

  test('hq fails with a clear error when the daemon is not reachable', async () => {
    const result = hq(['ls'], { HQ_URL: 'http://127.0.0.1:1' })
    await expect(result).rejects.toMatchObject({ code: 1 })
    await expect(result).rejects.toMatchObject({
      stderr: expect.stringContaining('hq daemon is not reachable'),
    })
  })

  test('hq open opens the UI in the browser via $BROWSER and prints the URL', async () => {
    const recorder = join(dataDir, 'record-browser.sh')
    const openedUrlFile = join(dataDir, 'opened-url')
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s' "$1" > '${openedUrlFile}'\n`, { mode: 0o755 })

    const { stdout } = await hq(['open'], { BROWSER: recorder })

    const hqUrl = `http://127.0.0.1:${daemon.port}`
    expect(readFileSync(openedUrlFile, 'utf8')).toBe(hqUrl)
    expect(stdout.trim()).toBe(hqUrl)
  })

  test('hq open fails clearly when the daemon is not reachable and opens nothing', async () => {
    const result = hq(['open'], { HQ_URL: 'http://127.0.0.1:1', BROWSER: 'false' })
    await expect(result).rejects.toMatchObject({ code: 1 })
    await expect(result).rejects.toMatchObject({
      stderr: expect.stringContaining('hq daemon is not reachable'),
    })
  })
})
