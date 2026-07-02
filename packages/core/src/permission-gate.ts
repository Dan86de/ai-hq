import type { PermissionRequest, PermissionVerdict } from './agent-adapter.ts'
import type { DecisionQueue } from './decision-queue.ts'

/**
 * Decides what happens when an agent asks to use a tool: allowlisted safe tools
 * run without prompting, everything else parks as a Decision on the queue.
 */
export type PermissionGate = (
  sessionId: string,
  request: PermissionRequest,
) => Promise<PermissionVerdict>

// Static in this slice (CONTEXT.md spec): read-only tools that cannot change
// anything on the Operator's machine.
export const defaultAllowlist: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep'])

export function createPermissionGate(options: {
  decisionQueue: DecisionQueue
  allowlist?: ReadonlySet<string>
}): PermissionGate {
  const allowlist = options.allowlist ?? defaultAllowlist
  return async (sessionId, request) => {
    if (allowlist.has(request.toolName)) return { behavior: 'approve' }
    return options.decisionQueue.request({
      sessionId,
      toolName: request.toolName,
      input: request.input,
    })
  }
}
