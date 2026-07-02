// The only interface allowed to know which agent platform is underneath (CONTEXT.md).
// Everything Claude-specific will live behind it, in a later adapter-claude package.

export type AdapterEvent =
  | { type: 'agent_initialized'; sdkSessionId: string }
  | { type: 'agent_message'; text: string }
  | { type: 'tool_call'; toolName: string; input: unknown }

export interface PermissionRequest {
  toolName: string
  input: unknown
}

export type PermissionVerdict = { behavior: 'approve' } | { behavior: 'deny'; note?: string }

export type PermissionCallback = (request: PermissionRequest) => Promise<PermissionVerdict>

export interface AgentLaunchInput {
  repoPath: string
  prompt: string
  requestPermission: PermissionCallback
}

export interface AgentRun {
  /**
   * The run's event stream.
   * Normal end of the stream means the agent completed; a thrown error means it died.
   */
  events: AsyncIterable<AdapterEvent>
  interrupt(): Promise<void>
  resume(prompt: string): Promise<void>
}

export interface AgentAdapter {
  launch(input: AgentLaunchInput): Promise<AgentRun>
}
