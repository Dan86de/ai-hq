// The Decision banner, exercised end to end: a real Daemon over HTTP, the real
// app.js in a DOM, and a gated agent run. See harness.ts for how the browser
// pieces are stood up in the node environment.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createFakeAgentAdapter,
  listDecisionsResponseSchema,
  type AgentAdapter,
  type FakeAgentStep,
} from '@ai-hq/core'
import {
  daemonUrl,
  launchSession,
  openScreen,
  realFetch,
  setUpHarness,
  startWithAdapter,
  tearDownHarness,
} from './harness.ts'

/** The gated run the acceptance criteria describe: one parked call, then wrap-up. */
const gatedScript: FakeAgentStep[] = [
  { type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } },
  { type: 'agent_message', text: 'Wrapping up.' },
]

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
  setUpHarness()
})

afterEach(async () => {
  await tearDownHarness()
})

async function openDetailScreen(sessionId: string): Promise<void> {
  await openScreen(`#/sessions/${encodeURIComponent(sessionId)}`)
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
  const sessionId = await launchSession('/repo/a', 'clean the build')
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
  const sessionId = await launchSession('/repo/a', 'clean the build')
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
  const sessionId = await launchSession('/repo/a', 'clean the build')
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
  const sessionId = await launchSession('/repo/a', 'clean the build')
  await vi.waitFor(
    async () => {
      const response = await realFetch(daemonUrl('/decisions'))
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
