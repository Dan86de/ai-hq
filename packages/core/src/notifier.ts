import { basename } from 'node:path'
import { z } from 'zod'
import type { Session } from './contracts.ts'
import type { EventLog } from './event-log.ts'
import type { HqEvent } from './events.ts'

// The Notifier (CONTEXT.md): subscribes to the Event Log and alerts the
// Operator when a Decision parks, a Session completes, or a Session fails.
// Delivery is injected; the Daemon wires native macOS notifications.

export interface Notification {
  /** The Session label (repo and prompt summary), so parallel Sessions are distinguishable. */
  title: string
  body: string
}

export type NotificationDeliverer = (notification: Notification) => void

export interface Notifier {
  close(): void
}

const decisionRequestedPayloadSchema = z.object({ toolName: z.string() })
const sessionFailedPayloadSchema = z.object({ error: z.string() })

const promptPreviewLength = 40

function sessionLabel(session: Session | undefined, sessionId: string): string {
  if (session === undefined) return `Session ${sessionId.slice(0, 8)}`
  const prompt =
    session.prompt.length > promptPreviewLength
      ? `${session.prompt.slice(0, promptPreviewLength)}...`
      : session.prompt
  return `${basename(session.repoPath)} - ${prompt}`
}

function notificationBody(event: HqEvent): string | undefined {
  switch (event.type) {
    case 'decision_requested': {
      const payload = decisionRequestedPayloadSchema.safeParse(event.payload)
      return `Decision parked: ${payload.success ? payload.data.toolName : 'a gated tool call'}`
    }
    case 'session_completed':
      return 'Session completed'
    case 'session_failed': {
      const payload = sessionFailedPayloadSchema.safeParse(event.payload)
      return payload.success ? `Session failed: ${payload.data.error}` : 'Session failed'
    }
    default:
      return undefined
  }
}

export function createNotifier(options: {
  eventLog: EventLog
  /** Where Session labels come from; the SessionRegistry satisfies this. */
  sessions: { get(id: string): Session | undefined }
  deliver: NotificationDeliverer
}): Notifier {
  const unsubscribe = options.eventLog.subscribe((event) => {
    const body = notificationBody(event)
    if (body === undefined) return
    options.deliver({
      title: sessionLabel(options.sessions.get(event.sessionId), event.sessionId),
      body,
    })
  })
  return { close: unsubscribe }
}
