// The Decision banner, exercised end to end: a real Daemon over HTTP, the real
// app.js in a DOM, and a gated agent run. The DOM is a hand-built jsdom in the
// node environment (vitest's jsdom environment rewrites import.meta.url to
// http://, which breaks the Daemon's uiDir). jsdom has no fetch or EventSource
// of its own, so the harness routes the UI's relative URLs to the Daemon and
// implements EventSource over fetch.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createFakeAgentAdapter,
  launchSessionResponseSchema,
  listDecisionsResponseSchema,
  type AgentAdapter,
  type FakeAgentStep,
} from '@ai-hq/core'
import { startDaemon, type Daemon } from '@ai-hq/daemon'
import { uiDir } from '../src/index.ts'

const realFetch = globalThis.fetch

let dataDir: string
let daemon: Daemon | undefined
let base: string

/** The gated run the acceptance criteria describe: one parked call, then wrap-up. */
const gatedScript: FakeAgentStep[] = [
  { type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } },
  { type: 'agent_message', text: 'Wrapping up.' },
]

/** Minimal EventSource over fetch: exactly what app.js uses (onopen/onmessage/onerror/close). */
class FetchEventSource {
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
 * An AgentAdapter with one Gated tool call that parks only when the test says
 * so - proving the banner appears live on an already-open screen, not via replay.
 */
function createManualGatedAdapter() {
  let release = (): void => {}
  const parked = new Promise<void>((resolve) => {
    release = resolve
  })
  const adapter: AgentAdapter = {
    async launch(input) {
      return {
        events: (async function* () {
          yield { type: 'agent_message', text: 'Starting on the task.' } as const
          await parked
          const verdict = await input.requestPermission({
            toolName: 'Bash',
            input: { command: 'rm -rf build' },
          })
          if (verdict.behavior === 'approve') {
            yield { type: 'tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } } as const
          }
        })(),
        async interrupt() {},
        async resume() {},
      }
    },
  }
  return { adapter, park: () => release() }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-ui-'))
  // A fresh window per test: stale app.js imports from earlier tests keep
  // their old window and can never touch this one.
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
})

afterEach(async () => {
  await daemon?.close().catch(() => {})
  daemon = undefined
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true })
})

async function startWithAdapter(adapter: AgentAdapter): Promise<void> {
  daemon = await startDaemon({ dataDir, port: 0, adapter })
  base = `http://127.0.0.1:${daemon.port}`
}

async function launchSession(): Promise<string> {
  const response = await realFetch(new URL('/sessions', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: '/repo/a', prompt: 'clean the build' }),
  })
  expect(response.status).toBe(201)
  return launchSessionResponseSchema.parse(await response.json()).session.id
}

async function openDetailScreen(sessionId: string): Promise<void> {
  // replaceState fires no hashchange, so stale app.js imports from earlier
  // tests never re-route; only the fresh import below renders this screen.
  history.replaceState(null, '', `#/sessions/${encodeURIComponent(sessionId)}`)
  vi.resetModules()
  await import(pathToFileURL(join(uiDir, 'app.js')).href)
}

function decisionCard(): HTMLElement | null {
  return document.querySelector('.decision-card')
}

async function waitForDecisionCard(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(decisionCard()).not.toBeNull(), { timeout: 5000 })
  return decisionCard()!
}

test('the banner appears live when a Decision parks, showing the exact tool name and input', async () => {
  const manual = createManualGatedAdapter()
  await startWithAdapter(manual.adapter)
  const sessionId = await launchSession()
  await openDetailScreen(sessionId)

  // The screen is open and streaming, and nothing is parked yet.
  await vi.waitFor(
    () => expect(document.querySelector('.entry--agent_message')).not.toBeNull(),
    { timeout: 5000 },
  )
  expect(decisionCard()).toBeNull()

  manual.park()

  const card = await waitForDecisionCard()
  expect(card.querySelector('.tool-name')?.textContent).toBe('Bash')
  expect(card.querySelector('.entry-input')?.textContent).toContain('rm -rf build')
  expect(document.querySelector('.badge')?.textContent).toBe('waiting on human')
})

test('approve clears the banner, resumes the Session, and the Transcript continues in place', async () => {
  await startWithAdapter(createFakeAgentAdapter({ script: gatedScript }))
  const sessionId = await launchSession()
  await openDetailScreen(sessionId)
  const card = await waitForDecisionCard()

  card.querySelector<HTMLButtonElement>('button.decision-approve')!.click()

  await vi.waitFor(
    () => {
      expect(decisionCard()).toBeNull()
      expect(document.querySelector('.entry--tool_call .tool-name')?.textContent).toBe('Bash')
      expect(document.body.textContent).toContain('Wrapping up.')
      expect(document.body.textContent).toContain('session completed')
    },
    { timeout: 5000 },
  )
  expect(document.querySelector<HTMLElement>('.decisions')?.hidden).toBe(true)
  expect(document.querySelector('.badge')?.textContent).toBe('completed')
})

test('deny with a note clears the banner and relays the note to the agent', async () => {
  await startWithAdapter(createFakeAgentAdapter({ script: gatedScript }))
  const sessionId = await launchSession()
  await openDetailScreen(sessionId)
  const card = await waitForDecisionCard()

  const note = card.querySelector<HTMLInputElement>('input.decision-note')!
  note.value = 'keep the build directory'
  card.querySelector<HTMLButtonElement>('button.decision-deny')!.click()

  await vi.waitFor(
    () => {
      expect(decisionCard()).toBeNull()
      // The fake agent echoes the relayed note and adjusts course.
      expect(document.body.textContent).toContain(
        'Tool Bash was denied: keep the build directory',
      )
      expect(document.body.textContent).toContain('session completed')
    },
    { timeout: 5000 },
  )
  // The denied call never executed.
  expect(document.querySelector('.entry--tool_call')).toBeNull()
})

test('opening a Session with an already-pending Decision shows the banner via replay', async () => {
  await startWithAdapter(createFakeAgentAdapter({ script: gatedScript }))
  const sessionId = await launchSession()
  await vi.waitFor(
    async () => {
      const response = await realFetch(new URL('/decisions', base))
      const { decisions } = listDecisionsResponseSchema.parse(await response.json())
      expect(decisions).toHaveLength(1)
    },
    { timeout: 5000 },
  )

  await openDetailScreen(sessionId)

  const card = await waitForDecisionCard()
  expect(card.querySelector('.tool-name')?.textContent).toBe('Bash')
  expect(document.querySelector('.badge')?.textContent).toBe('waiting on human')
})
