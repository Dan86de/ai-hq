// The interrupt control, exercised end to end: a real Daemon over HTTP, the
// real app.js in a DOM, and a long-running fake agent the Operator cuts off.
// See harness.ts for how the browser pieces are stood up in the node environment.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createFakeAgentAdapter, getSessionResponseSchema } from '@ai-hq/core'
import {
  daemonUrl,
  launchSession,
  openScreen,
  realFetch,
  setUpHarness,
  startWithAdapter,
  tearDownHarness,
} from './harness.ts'

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
  return document.querySelector<HTMLButtonElement>('button.interrupt-button')
}

test('the interrupt control stops a running Session: the Transcript records it and the badge flips', async () => {
  await startWithAdapter(createFakeAgentAdapter({ runUntilInterrupted: true }))
  const sessionId = await launchSession('/repo/a', 'long task')
  await openDetailScreen(sessionId)

  // The screen is streaming a live run and offers the control.
  await vi.waitFor(
    () => {
      expect(document.querySelector('.entry--agent_message')).not.toBeNull()
      expect(interruptButton()?.hidden).toBe(false)
    },
    { timeout: 5000 },
  )

  interruptButton()!.click()

  await vi.waitFor(
    () => {
      expect(document.body.textContent).toContain('session interrupted by the operator')
      expect(document.querySelector('.badge')?.textContent).toBe('interrupted')
      expect(interruptButton()?.hidden).toBe(true)
    },
    { timeout: 5000 },
  )
})

test('a finished Session offers no interrupt control', async () => {
  await startWithAdapter(createFakeAgentAdapter())
  const sessionId = await launchSession('/repo/a', 'quick task')
  await vi.waitFor(
    async () => {
      const response = await realFetch(daemonUrl(`/sessions/${sessionId}`))
      const { session } = getSessionResponseSchema.parse(await response.json())
      expect(session.status).toBe('completed')
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
