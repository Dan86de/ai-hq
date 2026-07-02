import type { AdapterEvent, AgentAdapter } from './agent-adapter.ts'

/**
 * A script step the fake agent performs. A plain AdapterEvent is emitted as-is;
 * a gated_tool_call first asks the permission callback, the way the real
 * platform does: approved calls execute (a tool_call event), denied calls make
 * the agent adjust course with the Operator's note (an agent_message event);
 * a hang keeps the run open, emitting nothing, until interrupt() - the way a
 * long-running agent stays busy.
 */
export type FakeAgentStep =
  | AdapterEvent
  | { type: 'gated_tool_call'; toolName: string; input: unknown }
  | { type: 'hang' }

export interface FakeAgentAdapterOptions {
  /** Steps the fake agent performs, in order. Defaults to a small scripted run. */
  script?: FakeAgentStep[]
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
    async launch(input) {
      // Per run, so parallel fake runs interrupt independently.
      let interrupted = false
      let wakeHang = (): void => {}
      return {
        events: (async function* () {
          for (const step of script) {
            if (interrupted) return
            if (step.type === 'hang') {
              await new Promise<void>((resolve) => {
                wakeHang = resolve
              })
              continue
            }
            if (step.type === 'gated_tool_call') {
              const verdict = await input.requestPermission({
                toolName: step.toolName,
                input: step.input,
              })
              if (verdict.behavior === 'approve') {
                yield { type: 'tool_call', toolName: step.toolName, input: step.input } as const
              } else {
                yield {
                  type: 'agent_message',
                  text: `Tool ${step.toolName} was denied${verdict.note === undefined ? '' : `: ${verdict.note}`}. Adjusting course.`,
                } as const
              }
              continue
            }
            yield step
          }
          if (interrupted) return
          if (options.failWith !== undefined) {
            throw new Error(options.failWith)
          }
        })(),
        async interrupt() {
          interrupted = true
          wakeHang()
        },
        async resume() {},
      }
    },
  }
}
