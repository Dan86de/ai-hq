// Shared browser-in-node harness for UI tests: a real Daemon over HTTP and the
// real app.js in a hand-built jsdom DOM (vitest's jsdom environment rewrites
// import.meta.url to http://, which breaks the Daemon's uiDir). jsdom has no
// fetch or EventSource of its own, so the harness routes the UI's relative
// URLs to the Daemon and implements EventSource over fetch.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, vi } from 'vitest'
import { launchSessionResponseSchema, type AgentAdapter } from '@ai-hq/core'
import { startDaemon, type Daemon } from '@ai-hq/daemon'
import { uiDir } from '../src/index.ts'

export const realFetch = globalThis.fetch

let dataDir: string
let daemon: Daemon | undefined
let base: string

/** Resolves a path against the running Daemon, for direct API calls. */
export function daemonUrl(path: string): URL {
  return new URL(path, base)
}

/** Minimal EventSource over fetch: exactly what app.js uses (onopen/onmessage/onerror/close). */
export class FetchEventSource {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly #controller = new AbortController()

  constructor(url: string) {
    void this.#stream(url)
  }

  async #stream(url: string): Promise<void> {
    try {
      const response = await realFetch(new URL(url, base), {
        headers: { accept: 'text/event-stream' },
        signal: this.#controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error(`status ${response.status}`)
      this.onopen?.()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let frameEnd
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trimStart())
            .join('\n')
          if (data !== '') this.onmessage?.({ data })
        }
      }
    } catch {
      if (!this.#controller.signal.aborted) this.onerror?.()
    }
  }

  close(): void {
    this.#controller.abort()
  }
}

/**
 * Call from beforeEach. A fresh temp data dir and a fresh window per test:
 * stale app.js imports from earlier tests keep their old window and can never
 * touch this one.
 */
export function setUpHarness(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-ui-'))
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<header><span id="connection" class="connection" hidden></span></header>' +
      '<main id="app"></main>' +
      '</body></html>',
    { url: 'http://127.0.0.1/' },
  )
  dom.window.scrollTo = () => {}
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('location', dom.window.location)
  vi.stubGlobal('history', dom.window.history)
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), base), init),
  )
  vi.stubGlobal('EventSource', FetchEventSource)
}

/** Call from afterEach: stop the Daemon, restore globals, remove the temp dir. */
export async function tearDownHarness(): Promise<void> {
  await daemon?.close().catch(() => {})
  daemon = undefined
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true })
}

export async function startWithAdapter(adapter: AgentAdapter): Promise<void> {
  daemon = await startDaemon({ dataDir, port: 0, adapter })
  base = `http://127.0.0.1:${daemon.port}`
}

/** Launches a Session through the Daemon's API and returns its id. */
export async function launchSession(repoPath: string, prompt: string): Promise<string> {
  const response = await realFetch(daemonUrl('/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath, prompt }),
  })
  expect(response.status).toBe(201)
  return launchSessionResponseSchema.parse(await response.json()).session.id
}

/**
 * Renders the screen at the given hash. replaceState fires no hashchange, so
 * stale app.js imports from earlier tests never re-route; only the fresh
 * import below renders this screen.
 */
export async function openScreen(hash: string): Promise<void> {
  history.replaceState(null, '', hash)
  vi.resetModules()
  await import(pathToFileURL(join(uiDir, 'app.js')).href)
}
