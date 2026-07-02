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
