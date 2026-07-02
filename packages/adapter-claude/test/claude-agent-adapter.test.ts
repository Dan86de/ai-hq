import { describe, expect, test } from 'vitest'
import type {
  NonNullableUsage,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AdapterEvent,
  PermissionCallback,
  PermissionRequest,
  PermissionVerdict,
} from '@ai-hq/core'
import { createClaudeAgentAdapter, type QueryFn } from '../src/index.ts'

const SDK_SESSION_ID = 'sdk-session-1'

const usage: BetaUsage = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  input_tokens: 1,
  iterations: null,
  output_tokens: 1,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
}

function initMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: 'test',
    cwd: '/repo/a',
    tools: [],
    mcp_servers: [],
    model: 'claude-opus-4-8',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: SDK_SESSION_ID,
  }
}

function assistantMessage(content: BetaContentBlock[]): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: 'claude-opus-4-8',
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage,
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: SDK_SESSION_ID,
  }
}

function textBlock(text: string): BetaContentBlock {
  return { type: 'text', text, citations: null }
}

function toolUseBlock(name: string, input: unknown): BetaContentBlock {
  return { type: 'tool_use', id: 'toolu_1', name, input }
}

const resultUsage = { input_tokens: 1, output_tokens: 1 } as NonNullableUsage

function successResult(options: { isError?: boolean } = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: options.isError ?? false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: SDK_SESSION_ID,
  }
}

function errorResult(errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: resultUsage,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: '00000000-0000-0000-0000-000000000004',
    session_id: SDK_SESSION_ID,
  }
}

interface CapturedCall {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}

function fakeQuery(messages: SDKMessage[], opts: { failWith?: Error } = {}) {
  const calls: CapturedCall[] = []
  let interrupts = 0
  const queryFn: QueryFn = (params) => {
    calls.push(params)
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          yield message
        }
        if (opts.failWith !== undefined) {
          throw opts.failWith
        }
      },
      async interrupt() {
        interrupts += 1
      },
    }
  }
  return { queryFn, calls, interruptCount: () => interrupts }
}

const approveAll: PermissionCallback = async (): Promise<PermissionVerdict> => ({
  behavior: 'approve',
})

async function launch(queryFn: QueryFn, requestPermission: PermissionCallback = approveAll) {
  const adapter = createClaudeAgentAdapter({ queryFn })
  return adapter.launch({ repoPath: '/repo/a', prompt: 'do the task', requestPermission })
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const collected: AdapterEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

describe('claude agent adapter', () => {
  test('maps the SDK stream to adapter events and ends on a success result', async () => {
    const { queryFn } = fakeQuery([
      initMessage(),
      assistantMessage([textBlock('Starting.'), toolUseBlock('Read', { path: 'README.md' })]),
      assistantMessage([textBlock('Done.')]),
      successResult(),
    ])

    const run = await launch(queryFn)

    expect(await collect(run.events)).toEqual([
      { type: 'agent_initialized', sdkSessionId: SDK_SESSION_ID },
      { type: 'agent_message', text: 'Starting.' },
      { type: 'tool_call', toolName: 'Read', input: { path: 'README.md' } },
      { type: 'agent_message', text: 'Done.' },
    ])
  })

  test('launches the SDK in the repo directory with the task as the streamed prompt', async () => {
    const { queryFn, calls } = fakeQuery([successResult()])

    const run = await launch(queryFn)
    await collect(run.events)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.options?.cwd).toBe('/repo/a')
    const streamed = []
    for await (const message of calls[0]!.prompt) {
      streamed.push(message)
    }
    expect(streamed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'do the task' },
        parent_tool_use_id: null,
      },
    ])
  })

  test('an error result makes the run fail with the subtype and errors', async () => {
    const { queryFn } = fakeQuery([initMessage(), errorResult(['model exploded'])])

    const run = await launch(queryFn)

    await expect(collect(run.events)).rejects.toThrow(
      'agent run failed (error_during_execution): model exploded',
    )
  })

  test('a success result flagged as an error still fails the run', async () => {
    const { queryFn } = fakeQuery([successResult({ isError: true })])

    const run = await launch(queryFn)

    await expect(collect(run.events)).rejects.toThrow('agent run failed (success)')
  })

  test('a dying SDK stream propagates as a run failure', async () => {
    const { queryFn } = fakeQuery([initMessage()], { failWith: new Error('process died') })

    const run = await launch(queryFn)

    await expect(collect(run.events)).rejects.toThrow('process died')
  })

  test('the permission callback approves through to the SDK with the input unchanged', async () => {
    const { queryFn, calls } = fakeQuery([successResult()])
    const seen: PermissionRequest[] = []
    const run = await launch(queryFn, async (request) => {
      seen.push(request)
      return { behavior: 'approve' }
    })
    await collect(run.events)

    const canUseTool = calls[0]!.options?.canUseTool
    expect(canUseTool).toBeDefined()
    const result = await canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'toolu_1' },
    )

    expect(seen).toEqual([{ toolName: 'Bash', input: { command: 'ls' } }])
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('a denial is relayed to the SDK with the Operator note', async () => {
    const { queryFn, calls } = fakeQuery([successResult()])
    const run = await launch(queryFn, async () => ({ behavior: 'deny', note: 'not that file' }))
    await collect(run.events)

    const result = await calls[0]!.options!.canUseTool!(
      'Read',
      { path: '.env' },
      { signal: new AbortController().signal, toolUseID: 'toolu_2' },
    )

    expect(result).toEqual({ behavior: 'deny', message: 'not that file' })
  })

  test('a denial without a note still carries a message', async () => {
    const { queryFn, calls } = fakeQuery([successResult()])
    const run = await launch(queryFn, async () => ({ behavior: 'deny' }))
    await collect(run.events)

    const result = await calls[0]!.options!.canUseTool!(
      'Read',
      { path: '.env' },
      { signal: new AbortController().signal, toolUseID: 'toolu_3' },
    )

    expect(result).toMatchObject({ behavior: 'deny', message: expect.any(String) })
  })

  test('interrupt is delegated to the SDK query', async () => {
    const { queryFn, interruptCount } = fakeQuery([successResult()])

    const run = await launch(queryFn)
    await run.interrupt()

    expect(interruptCount()).toBe(1)
  })

  test('resume is not part of this slice and says so', async () => {
    const { queryFn } = fakeQuery([successResult()])

    const run = await launch(queryFn)

    await expect(run.resume('keep going')).rejects.toThrow('resume is not implemented')
  })
})
