import { z } from 'zod'

// HTTP contracts shared between the Daemon and the CLI.

export const sessionStatusSchema = z.enum(['running', 'waiting_on_human', 'completed', 'failed'])

export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionSchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  prompt: z.string(),
  status: sessionStatusSchema,
  sdkSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Session = z.infer<typeof sessionSchema>

export const decisionStatusSchema = z.enum(['pending', 'approved', 'denied'])

export type DecisionStatus = z.infer<typeof decisionStatusSchema>

export const decisionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  status: decisionStatusSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
})

export type Decision = z.infer<typeof decisionSchema>

// The Operator's ruling on a Decision: approve, or deny with an optional note
// relayed to the agent. Same shape as the adapter-level PermissionVerdict.
export const verdictSchema = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('approve') }),
  z.object({ behavior: z.literal('deny'), note: z.string().optional() }),
])

export type Verdict = z.infer<typeof verdictSchema>

export const listDecisionsResponseSchema = z.object({
  decisions: z.array(decisionSchema),
})

export const decideDecisionResponseSchema = z.object({
  decision: decisionSchema,
})

export const launchSessionRequestSchema = z.object({
  repoPath: z.string().min(1),
  prompt: z.string().min(1),
})

export type LaunchSessionRequest = z.infer<typeof launchSessionRequestSchema>

export const launchSessionResponseSchema = z.object({
  session: sessionSchema,
})

export const getSessionResponseSchema = z.object({
  session: sessionSchema,
})

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSchema),
})
