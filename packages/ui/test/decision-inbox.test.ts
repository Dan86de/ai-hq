// The Decision Inbox, exercised end to end: a real Daemon over HTTP, the real
// app.js in a DOM, and gated agent runs across multiple Sessions. See
// harness.ts for how the browser pieces are stood up in the node environment.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createFakeAgentAdapter,
  getSessionResponseSchema,
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

/** Scripts keyed by prompt, so every Session parks its own Gated tool call. */
const scriptsByPrompt: Record<string, FakeAgentStep[]> = {
  'clean the build': [
    { type: 'gated_tool_call', toolName: 'Bash', input: { command: 'rm -rf build' } },
    { type: 'agent_message', text: 'Wrapping up.' },
  ],
  'update the deps': [
    { type: 'gated_tool_call', toolName: 'Write', input: { path: 'package.json' } },
    { type: 'agent_message', text: 'Wrapping up.' },
  ],
}

/** One adapter, many Sessions: each launch runs the script for its prompt. */
const perPromptAdapter: AgentAdapter = {
  launch(input) {
    return createFakeAgentAdapter({ script: scriptsByPrompt[input.prompt] ?? [] }).launch(input)
  },
}

beforeEach(() => {
  setUpHarness()
})

afterEach(async () => {
  await tearDownHarness()
})

function inboxEntries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.inbox-entry')]
}

function emptyState(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.empty')
}

async function waitForPendingDecisions(count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await realFetch(daemonUrl('/decisions'))
      const { decisions } = listDecisionsResponseSchema.parse(await response.json())
      expect(decisions).toHaveLength(count)
    },
    { timeout: 5000 },
  )
}

/** Two Sessions in different repos, each parked on its own Gated tool call. */
async function launchTwoBlockedSessions(): Promise<{ a: string; b: string }> {
  await startWithAdapter(perPromptAdapter)
  const a = await launchSession('/repo/a', 'clean the build')
  const b = await launchSession('/repo/b', 'update the deps')
  await waitForPendingDecisions(2)
  return { a, b }
}

test('the Inbox lists pending Decisions across all Sessions, each with its Session label, tool name, and input', async () => {
  const { a, b } = await launchTwoBlockedSessions()

  await openScreen('#/inbox')

  await vi.waitFor(() => expect(inboxEntries()).toHaveLength(2), { timeout: 5000 })
  const [first, second] = inboxEntries()

  // Oldest first, each entry labeled with its own Session's repo and prompt.
  expect(first!.querySelector('.repo-path')?.textContent).toBe('/repo/a')
  expect(first!.querySelector('.inbox-prompt')?.textContent).toBe('clean the build')
  expect(first!.querySelector('.tool-name')?.textContent).toBe('Bash')
  expect(first!.querySelector('.entry-input')?.textContent).toContain('rm -rf build')
  expect(first!.querySelector('.inbox-session')?.getAttribute('href')).toBe(
    `#/sessions/${encodeURIComponent(a)}`,
  )

  expect(second!.querySelector('.repo-path')?.textContent).toBe('/repo/b')
  expect(second!.querySelector('.inbox-prompt')?.textContent).toBe('update the deps')
  expect(second!.querySelector('.tool-name')?.textContent).toBe('Write')
  expect(second!.querySelector('.entry-input')?.textContent).toContain('package.json')
  expect(second!.querySelector('.inbox-session')?.getAttribute('href')).toBe(
    `#/sessions/${encodeURIComponent(b)}`,
  )

  expect(emptyState()?.hidden).toBe(true)
})

test('approve works inline: the ruled Decision leaves the Inbox live, the others stay, and the Session proceeds', async () => {
  const { a } = await launchTwoBlockedSessions()
  await openScreen('#/inbox')
  await vi.waitFor(() => expect(inboxEntries()).toHaveLength(2), { timeout: 5000 })

  inboxEntries()[0]!.querySelector<HTMLButtonElement>('button.decision-approve')!.click()

  await vi.waitFor(
    () => {
      const remaining = inboxEntries()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.querySelector('.repo-path')?.textContent).toBe('/repo/b')
    },
    { timeout: 5000 },
  )

  // The approved call executed and its Session ran to completion.
  await vi.waitFor(
    async () => {
      const response = await realFetch(daemonUrl(`/sessions/${encodeURIComponent(a)}`))
      const { session } = getSessionResponseSchema.parse(await response.json())
      expect(session.status).toBe('completed')
    },
    { timeout: 5000 },
  )
})

test('deny with a note works inline, relays the note to the agent, and the emptied Inbox shows its empty state', async () => {
  await startWithAdapter(perPromptAdapter)
  const a = await launchSession('/repo/a', 'clean the build')
  await waitForPendingDecisions(1)
  await openScreen('#/inbox')
  await vi.waitFor(() => expect(inboxEntries()).toHaveLength(1), { timeout: 5000 })

  const entry = inboxEntries()[0]!
  entry.querySelector<HTMLInputElement>('input.decision-note')!.value = 'keep the build directory'
  entry.querySelector<HTMLButtonElement>('button.decision-deny')!.click()

  await vi.waitFor(
    () => {
      expect(inboxEntries()).toHaveLength(0)
      expect(emptyState()?.hidden).toBe(false)
    },
    { timeout: 5000 },
  )

  // The note reached the agent: follow the entry's route to the Transcript.
  location.hash = `#/sessions/${encodeURIComponent(a)}`
  await vi.waitFor(
    () => {
      expect(document.body.textContent).toContain('Tool Bash was denied: keep the build directory')
    },
    { timeout: 5000 },
  )
})

test('a Verdict from elsewhere leaves the Inbox live, and a note being typed survives the refresh', async () => {
  await launchTwoBlockedSessions()
  await openScreen('#/inbox')
  await vi.waitFor(() => expect(inboxEntries()).toHaveLength(2), { timeout: 5000 })

  const noteBeingTyped = inboxEntries()[1]!.querySelector<HTMLInputElement>('input.decision-note')!
  noteBeingTyped.value = 'hold on'

  // Rule the first Decision from outside the Inbox (curl, another tab).
  const response = await realFetch(daemonUrl('/decisions'))
  const { decisions } = listDecisionsResponseSchema.parse(await response.json())
  const verdictResponse = await realFetch(
    daemonUrl(`/decisions/${encodeURIComponent(decisions[0]!.id)}/verdict`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'approve' }),
    },
  )
  expect(verdictResponse.status).toBe(200)

  await vi.waitFor(
    () => {
      const remaining = inboxEntries()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.querySelector('.repo-path')?.textContent).toBe('/repo/b')
    },
    { timeout: 5000 },
  )

  // The poll reconciled instead of re-rendering: the same input, text intact.
  expect(noteBeingTyped.isConnected).toBe(true)
  expect(noteBeingTyped.value).toBe('hold on')
})

test('the Inbox shows an empty state when nothing is pending', async () => {
  await startWithAdapter(createFakeAgentAdapter())

  await openScreen('#/inbox')

  await vi.waitFor(
    () => {
      expect(emptyState()).not.toBeNull()
      expect(emptyState()!.hidden).toBe(false)
    },
    { timeout: 5000 },
  )
  expect(document.body.textContent).toContain('no pending decisions')
  expect(inboxEntries()).toHaveLength(0)
})
