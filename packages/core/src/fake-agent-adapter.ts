import type { AdapterEvent, AgentAdapter } from './agent-adapter.ts'

export interface FakeAgentAdapterOptions {
  /** Events the fake agent emits, in order. Defaults to a small scripted run. */
  script?: AdapterEvent[]
  /** When set, the fake agent dies with this error message after emitting the script. */
  failWith?: string
}

export const defaultFakeScript: AdapterEvent[] = [
  { type: 'agent_message', text: 'Starting on the task.' },
  { type: 'tool_call', toolName: 'read_file', input: { path: 'README.md' } },
  { type: 'agent_message', text: 'Task complete.' },
]

export function createFakeAgentAdapter(options: FakeAgentAdapterOptions = {}): AgentAdapter {
  const script = options.script ?? defaultFakeScript
  return {
    async launch() {
      return {
        events: (async function* () {
          for (const event of script) {
            yield event
          }
          if (options.failWith !== undefined) {
            throw new Error(options.failWith)
          }
        })(),
        async interrupt() {},
        async resume() {},
      }
    },
  }
}
