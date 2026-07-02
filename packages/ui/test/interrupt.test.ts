// The interrupt control, exercised end to end: a real Daemon over HTTP, the
// real app.js in a DOM, and a fake agent parked mid-run. See harness.ts for how
// the browser pieces are stood up in the node environment.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createFakeAgentAdapter,
  getSessionResponseSchema,
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

/** A run that stays busy until interrupted; the trailing message must never land. */
const hangingScript: FakeAgentStep[] = [
  { type: 'agent_message', text: 'Working on it.' },
  { type: 'hang' },
  { type: 'agent_message', text: 'never reached' },
]

beforeEach(() => {
  setUpHarness()
})

afterEach(async () => {
  await tearDownHarness()
})

async function openDetailScreen(sessionId: string): Promise<void> {
  await openScreen(`#/sessions/${encodeURIComponent(sessionId)}`)
}

function interruptButton(): HTMLButtonElement | null {
  return document.querySelector('button.interrupt-button')
}

test('the interrupt control stops a running Session and the screen shows how it ended', async () => {
  await startWithAdapter(createFakeAgentAdapter({ script: hangingScript }))
  const sessionId = await launchSession('/repo/a', 'wrong direction')
  await openDetailScreen(sessionId)

  // The screen is streaming a live run and offers the control.
  const button = await vi.waitFor(
    () => {
      const candidate = interruptButton()
      expect(candidate).not.toBeNull()
      expect(candidate!.hidden).toBe(false)
      expect(document.querySelector('.entry--agent_message')).not.toBeNull()
      return candidate!
    },
    { timeout: 5000 },
  )

  button.click()

  await vi.waitFor(
    () => {
      expect(document.body.textContent).toContain('session interrupted')
      expect(document.querySelector('.badge')?.textContent).toBe('failed')
      expect(interruptButton()?.hidden).toBe(true)
    },
    { timeout: 5000 },
  )
  // The agent actually stopped: the step after the hang never emitted.
  expect(document.body.textContent).not.toContain('never reached')

  // The Session ended in a terminal status on the Daemon, not just on screen.
  const response = await realFetch(daemonUrl(`/sessions/${encodeURIComponent(sessionId)}`))
  expect(getSessionResponseSchema.parse(await response.json()).session.status).toBe('failed')
})

test('a finished Session offers no interrupt control', async () => {
  await startWithAdapter(createFakeAgentAdapter())
  const sessionId = await launchSession('/repo/a', 'quick task')
  await vi.waitFor(
    async () => {
      const response = await realFetch(daemonUrl(`/sessions/${encodeURIComponent(sessionId)}`))
      expect(getSessionResponseSchema.parse(await response.json()).session.status).toBe('completed')
    },
    { timeout: 5000 },
  )

  await openDetailScreen(sessionId)

  await vi.waitFor(
    () => expect(document.querySelector('.badge')?.textContent).toBe('completed'),
    { timeout: 5000 },
  )
  expect(interruptButton()?.hidden).toBe(true)
})
