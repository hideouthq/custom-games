import type { Actor } from './model.ts'

export interface NativeActivation {
  readonly actor: Actor
  readonly entity: number
  readonly ability: number
  readonly requestedAt: number
}

export interface ActivationSample {
  readonly actor: Actor | undefined
  readonly entity: number | undefined
  readonly alive: boolean
  readonly executed: ReadonlySet<number>
}

export function activationStatus(attempt: NativeActivation, sample: ActivationSample, now: number): 'pending' | 'active' | 'cancelled' | 'timedOut' {
  const current = sample.actor
  if (!current || !sample.alive || sample.entity !== attempt.entity || current.id !== attempt.actor.id || current.generation !== attempt.actor.generation || current.life !== attempt.actor.life) return 'cancelled'
  if (sample.executed.has(attempt.ability)) return 'active'
  return now - attempt.requestedAt >= 1 ? 'timedOut' : 'pending'
}
