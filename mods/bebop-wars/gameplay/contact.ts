import type { AccountId, Frame, Observation } from './model.ts'

export const hookDamageShare = 0.55

export interface Cast { readonly entity: number; readonly serial: number }
export interface Landed { readonly entity: number; readonly serial: number; readonly named: AccountId | undefined; readonly hit: boolean }
export interface Contact {
  readonly caster: AccountId
  readonly victim: AccountId
  readonly attacker: number
  readonly target: number
  readonly ability: number
  readonly amount: number
  readonly healthBefore: number
}

// The game shows a latch as the victim's pull modifier or, when the Hook reports it sooner, as the Hook naming a new victim.
export function hookContacts(
  players: readonly Observation[], pulls: Frame['pulls'], casts: ReadonlyMap<AccountId, Cast>, landed: Map<AccountId, Landed>,
): Contact[] {
  const samples = new Map(players.map(sample => [sample.id, sample]))
  const contacts: Contact[] = []
  for (const id of Array.from(landed.keys())) if (!samples.get(id)?.body?.hook) landed.delete(id)
  for (const sample of players) {
    const body = sample.body, hook = body?.hook, cast = casts.get(sample.id)
    if (!body || !hook || !cast || cast.entity !== hook.entity) { landed.delete(sample.id); continue }
    const before = landed.get(sample.id)
    const spent = before !== undefined && before.entity === cast.entity && before.serial === cast.serial && before.hit
    const pulled = Array.from(pulls).find(([, pull]) => pull.kind === 'held' && pull.owner === sample.id)?.[0]
    const named = before !== undefined && hook.victim !== before.named ? hook.victim : undefined
    const victim = spent ? undefined : pulled ?? named
    landed.set(sample.id, { entity: cast.entity, serial: cast.serial, named: hook.victim, hit: spent || victim !== undefined })
    if (victim === undefined) continue
    const target = samples.get(victim)?.body
    if (!body.alive || !target?.alive || target.side === body.side) continue
    contacts.push({ caster: sample.id, victim, attacker: body.entity, target: target.entity, ability: hook.entity, amount: Math.round(target.maxHealth * hookDamageShare), healthBefore: target.health })
  }
  return contacts
}
