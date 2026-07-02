import { z } from 'zod'

// "Event" per CONTEXT.md; prefixed Hq in code to avoid colliding with the global DOM/Node Event type.
export const hqEventSchema = z.object({
  seq: z.number().int().positive(),
  sessionId: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.string(),
})

export type HqEvent = z.infer<typeof hqEventSchema>

export interface NewHqEvent {
  sessionId: string
  type: string
  payload: unknown
}
