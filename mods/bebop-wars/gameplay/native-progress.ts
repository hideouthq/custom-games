import type { Ability, Pawn, Player } from 'modlock'
import { earnedAbilityPoints, isHookRank, spentAbilityPoints, startingSouls, warmupBudget, type HookRank } from './catalog.ts'
import { accountId, type AccountId, type Fighter, type State } from './model.ts'

const hookName = 'citadel_ability_hook'
const masks: Readonly<Record<HookRank, number>> = { 0: 1, 1: 3, 2: 7, 3: 15 }
type NativePawn = Pick<Pawn, 'entity' | 'hero' | 'health' | 'souls' | 'abilityPoints' | 'abilityUnlocks'>
type NativeAbility = Pick<Ability, 'name' | 'slot' | 'entity' | 'upgrades' | 'charges' | 'cooldownStart' | 'cooldownEnd' | 'rechargeEnd'>
type NativePlayer = Pick<Player, 'resetHero' | 'setAbility' | 'adjustSouls' | 'adjustAbilityPoints'> & {
  pawn(): NativePawn | undefined
  abilities(): readonly NativeAbility[]
}
type Participant = Pick<Fighter, 'id' | 'presence' | 'kills' | 'progression'>
type Match = Pick<State, 'round' | 'phase' | 'now'>

export interface NativeProgressSnapshot {
  readonly id: AccountId
  readonly round: number
  readonly generation: number
  readonly entity: number
  readonly hookEntity: number
  readonly souls: number
  readonly rank: HookRank
  readonly charges: number
  readonly cooldownStart: number
  readonly cooldownEnd: number
  readonly rechargeEnd: number
}

type Progress =
  | { kind: 'reset' | 'baseline'; round: number }
  | { kind: 'restore' | 'ready'; round: number; saved: NativeProgressSnapshot }
  | { kind: 'sync'; round: number; saved: NativeProgressSnapshot; cooldown: { start: number; end: number } | null }

export function hookRank(mask: number): HookRank | undefined {
  switch (mask) {
    case 1: return 0
    case 3: return 1
    case 7: return 2
    case 15: return 3
    default: return undefined
  }
}

function affordableRank(rank: HookRank, points: number): HookRank {
  if (rank === 3 && points >= 8) return 3
  if (rank >= 2 && points >= 3) return 2
  if (rank >= 1 && points >= 1) return 1
  return 0
}

function sample(id: AccountId, round: number, generation: number, pawn: NativePawn, hook: NativeAbility, rank: HookRank): NativeProgressSnapshot {
  return { id, round, generation, entity: pawn.entity, hookEntity: hook.entity, souls: pawn.souls, rank, charges: hook.charges, cooldownStart: hook.cooldownStart, cooldownEnd: hook.cooldownEnd, rechargeEnd: hook.rechargeEnd }
}

export function exactWallet(player: Pick<NativePlayer, 'pawn' | 'adjustSouls'>, target: number): boolean {
  const before = player.pawn()
  if (!before) return false
  if (before.souls === target) return true
  if (!player.adjustSouls(target - before.souls, true)) return false
  let after = player.pawn()
  if (!after || after.entity !== before.entity) return false
  if (after.souls > target) {
    if (!player.adjustSouls(target - after.souls, true)) return false
    after = player.pawn()
  }
  return after?.entity === before.entity && after.souls === target
}

export class NativeProgress {
  private readonly records = new Map<AccountId, Progress>()
  private readonly connected = new Set<AccountId>()

  disconnected(id: AccountId): void { this.connected.delete(id) }
  get busy(): boolean { return [...this.connected].some(id => this.records.get(id)?.kind !== 'ready') }

  reset(id: AccountId, round: number): void {
    if (this.records.get(id)?.round !== round) this.records.set(id, { kind: 'reset', round })
  }

  ready(id: AccountId): boolean { return this.connected.has(id) && this.records.get(id)?.kind === 'ready' }

  credit(player: NativePlayer, fighter: Participant, state: Match, amount: number): 'paid' | 'deferred' | 'failed' {
    const record = this.records.get(fighter.id), pawn = player.pawn()
    const hook = player.abilities().find(ability => ability.name === hookName)
    if (fighter.presence.kind !== 'connected' || record?.kind !== 'ready' || record.round !== state.round || !pawn || !hook || record.saved.generation !== fighter.presence.generation || record.saved.entity !== pawn.entity || record.saved.hookEntity !== hook.entity) return 'deferred'
    if (!Number.isSafeInteger(amount) || amount <= 0 || !exactWallet(player, pawn.souls + amount)) return 'failed'
    const after = player.pawn()
    if (!after || after.entity !== pawn.entity) return 'failed'
    this.records.set(fighter.id, { ...record, saved: { ...record.saved, souls: after.souls } })
    return 'paid'
  }

  reconcile(player: NativePlayer, fighter: Participant, state: Match, pawn: NativePawn | undefined, abilities: readonly NativeAbility[]): boolean {
    if (fighter.presence.kind !== 'connected') { this.disconnected(fighter.id); return false }
    this.connected.add(fighter.id)
    this.reset(fighter.id, state.round)
    let record = this.records.get(fighter.id)
    let hook = abilities.find(ability => ability.name === hookName)
    if (!record || !pawn?.hero || !hook) {
      this.disconnected(fighter.id)
      return false
    }
    const generation = fighter.presence.generation
    if (record.kind === 'reset') {
      if (pawn.health <= 0 || !player.resetHero(0)) return false
      record = { kind: 'baseline', round: state.round }
      this.records.set(fighter.id, record)
      pawn = player.pawn()
      abilities = player.abilities()
      hook = abilities.find(ability => ability.name === hookName)
      if (!pawn?.hero || !hook) return false
    }
    if (record.kind === 'baseline') {
      record = { kind: 'restore', round: state.round, saved: { ...sample(fighter.id, state.round, generation, pawn, hook, 0), souls: startingSouls, cooldownEnd: 0, rechargeEnd: 0 } }
      this.records.set(fighter.id, record)
    }
    if ((record.kind === 'ready' || record.kind === 'sync') && (record.saved.generation !== generation || record.saved.entity !== pawn.entity || record.saved.hookEntity !== hook.entity)) {
      record = { ...record, kind: 'restore' }
      this.records.set(fighter.id, record)
    }
    if (record.kind === 'restore') {
      const saved = record.saved
      const rank = affordableRank(saved.rank, earnedAbilityPoints(fighter.kills))
      const cooldownEnd = saved.cooldownEnd > state.now ? saved.cooldownEnd : 0
      const rechargeEnd = saved.rechargeEnd > state.now ? saved.rechargeEnd : 0
      if (!player.setAbility({ ability: hookName, upgrades: masks[rank], charges: saved.charges, cooldownEnd, rechargeEnd })) return false
      if (pawn.souls !== saved.souls && !exactWallet(player, saved.souls)) return false
      pawn = player.pawn()
      abilities = player.abilities()
      hook = abilities.find(ability => ability.name === hookName)
      if (!pawn || !hook || pawn.souls !== saved.souls || hook.upgrades !== masks[rank] || hook.charges !== saved.charges || Math.abs(hook.cooldownEnd - cooldownEnd) > 0.05 || Math.abs(hook.rechargeEnd - rechargeEnd) > 0.05) return false
      record = { kind: 'ready', round: state.round, saved: sample(fighter.id, state.round, generation, pawn, hook, rank) }
      this.records.set(fighter.id, record)
    }
    if (record.kind !== 'ready' && record.kind !== 'sync') return false
    const entitlement = earnedAbilityPoints(fighter.kills)
    const previous = affordableRank(record.saved.rank, entitlement)
    const observed = hookRank(hook.upgrades)
    const rank = observed !== undefined && observed > previous && spentAbilityPoints(observed) <= entitlement ? observed : previous
    const rejected = hook.upgrades !== masks[rank] && (observed === undefined || spentAbilityPoints(observed) > entitlement)
    const pending = record.kind === 'sync' && record.cooldown?.start === hook.cooldownStart ? record.cooldown : null
    const deadline = pending?.end ?? (rejected && hook.cooldownStart === record.saved.cooldownStart && hook.cooldownEnd < record.saved.cooldownEnd ? record.saved.cooldownEnd : undefined)
    const cooldown = deadline === undefined ? null : { start: hook.cooldownStart, end: deadline > state.now ? deadline : 0 }
    const saved = sample(fighter.id, state.round, generation, pawn, hook, rank)
    this.records.set(fighter.id, { kind: 'sync', round: state.round, saved: { ...saved, cooldownEnd: cooldown?.end ?? saved.cooldownEnd }, cooldown })
    let changed = false
    if (hook.upgrades !== masks[rank] || (cooldown !== null && Math.abs(hook.cooldownEnd - cooldown.end) > 0.05)) {
      if (!player.setAbility({ ability: hookName, upgrades: masks[rank], cooldownEnd: cooldown?.end })) return false
      changed = true
    }
    for (const ability of abilities) {
      if (ability.name !== hookName && ability.slot >= 0 && ability.slot < 4 && ability.upgrades > 1) {
        if (!player.setAbility({ ability: ability.name, upgrades: ability.upgrades & 1 })) return false
        changed = true
      }
    }
    const points = entitlement - spentAbilityPoints(rank)
    if (pawn.abilityPoints !== points || pawn.abilityUnlocks !== 0) {
      if (!player.adjustAbilityPoints(points - pawn.abilityPoints, -pawn.abilityUnlocks)) return false
      changed = true
    }
    const budget = state.phase.kind === 'warmup' || state.phase.kind === 'countdown' ? warmupBudget(fighter.progression.owned) : undefined
    if (budget !== undefined && pawn.souls !== budget) {
      if (!exactWallet(player, budget)) return false
      changed = true
    }
    const after = changed ? player.pawn() : pawn
    const finalAbilities = changed ? player.abilities() : abilities
    const finalHook = finalAbilities.find(ability => ability.name === hookName)
    if (!after || !finalHook || after.abilityPoints !== points || after.abilityUnlocks !== 0 || finalHook.upgrades !== masks[rank] || (cooldown !== null && Math.abs(finalHook.cooldownEnd - cooldown.end) > 0.05) || (budget !== undefined && after.souls !== budget) || finalAbilities.some(ability => ability.name !== hookName && ability.slot >= 0 && ability.slot < 4 && ability.upgrades > 1)) return false
    this.records.set(fighter.id, { kind: 'ready', round: state.round, saved: sample(fighter.id, state.round, generation, after, finalHook, rank) })
    return true
  }

  export(): readonly NativeProgressSnapshot[] | undefined {
    if (this.busy) return undefined
    const saved: NativeProgressSnapshot[] = []
    for (const record of this.records.values()) {
      if ('saved' in record) saved.push({ ...record.saved })
    }
    return saved
  }

  restore(value: unknown): boolean {
    if (!Array.isArray(value) || value.length > 64) return false
    const records = new Map<AccountId, Progress>()
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      const row: Record<string, unknown> = entry
      const integer = (key: string): boolean => typeof row[key] === 'number' && Number.isInteger(row[key]) && row[key] >= 0 && row[key] <= 0xffffffff
      if (typeof row.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(row.id) || !['round', 'generation', 'entity', 'hookEntity', 'souls', 'charges'].every(integer) || !isHookRank(row.rank) || typeof row.cooldownStart !== 'number' || !Number.isFinite(row.cooldownStart) || typeof row.cooldownEnd !== 'number' || !Number.isFinite(row.cooldownEnd) || typeof row.rechargeEnd !== 'number' || !Number.isFinite(row.rechargeEnd)) return false
      const { round, generation, entity, hookEntity, souls, charges } = row
      if (typeof round !== 'number' || typeof generation !== 'number' || typeof entity !== 'number' || typeof hookEntity !== 'number' || typeof souls !== 'number' || typeof charges !== 'number' || souls > 0x7fffffff || charges > 100) return false
      const id = accountId(row.id)
      if (records.has(id)) return false
      records.set(id, { kind: 'ready', round, saved: { id, round, generation, entity, hookEntity, souls, rank: row.rank, charges, cooldownStart: row.cooldownStart, cooldownEnd: row.cooldownEnd, rechargeEnd: row.rechargeEnd } })
    }
    this.records.clear()
    this.connected.clear()
    for (const [id, record] of records) this.records.set(id, record)
    return true
  }
}
