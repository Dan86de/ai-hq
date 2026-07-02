// The one place in the workspace allowed to import the Claude Agent SDK (CONTEXT.md: AgentAdapter).
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AdapterEvent,
  AgentAdapter,
  AgentLaunchInput,
  PermissionCallback,
} from '@ai-hq/core'

/**
 * The slice of the SDK's `query()` the adapter uses. Narrow so tests can fake
 * it without implementing every Query control method; the real `query` is
 * assignable to it, which the default below proves at compile time.
 */
export interface QueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>
}

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => QueryHandle

export interface ClaudeAgentAdapterOptions {
  queryFn?: QueryFn
}

// canUseTool is only invoked in streaming input mode, so the prompt goes in as
// a single-message stream. The turn (including all tool calls) completes after
// the generator returns, then the SDK emits a result and the run ends.
async function* promptStream(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
  }
}

function toCanUseTool(requestPermission: PermissionCallback): NonNullable<Options['canUseTool']> {
  return async (toolName, input) => {
    const verdict = await requestPermission({ toolName, input })
    if (verdict.behavior === 'approve') {
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: verdict.note ?? 'Denied by the Operator.' }
  }
}

async function* toAdapterEvents(messages: AsyncIterable<SDKMessage>): AsyncGenerator<AdapterEvent> {
  for await (const message of messages) {
    if (message.type === 'system' && message.subtype === 'init') {
      yield { type: 'agent_initialized', sdkSessionId: message.session_id }
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          yield { type: 'agent_message', text: block.text }
        } else if (block.type === 'tool_use') {
          yield { type: 'tool_call', toolName: block.name, input: block.input }
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype !== 'success' || message.is_error) {
        const details = 'errors' in message && message.errors.length > 0 ? `: ${message.errors.join('; ')}` : ''
        throw new Error(`agent run failed (${message.subtype})${details}`)
      }
      return
    }
    // Everything else (partial messages, status, hooks, ...) is outside this slice.
  }
}

export function createClaudeAgentAdapter(options: ClaudeAgentAdapterOptions = {}): AgentAdapter {
  const queryFn: QueryFn = options.queryFn ?? query
  return {
    async launch(input: AgentLaunchInput) {
      const run = queryFn({
        prompt: promptStream(input.prompt),
        options: {
          cwd: input.repoPath,
          canUseTool: toCanUseTool(input.requestPermission),
        },
      })
      return {
        events: toAdapterEvents(run),
        interrupt: () => run.interrupt(),
        async resume() {
          throw new Error('resume is not implemented yet; it arrives in a later slice')
        },
      }
    },
  }
}
