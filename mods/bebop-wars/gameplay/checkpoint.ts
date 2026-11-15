import { economy, isDefense, isProductId, isSetup, isUtility, type ProductId } from './catalog.ts'
import { accountId, type Actor, type Config, type Fighter, type Life, type Phase, type Progression, type State, type Transit } from './model.ts'
import type { Vec3 } from './arena.ts'
import type { Side } from './hud-model.ts'

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error('Expected record'); return value }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('Expected list'); return value }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite number'); return value }
function natural(value: unknown): number { const result = number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error('Expected natural number'); return result }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Expected text'); return value }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Expected boolean'); return value }
function side(value: unknown): Side { if (value !== 2 && value !== 3) throw new Error('Expected side'); return value }
function optionalTime(value: unknown): number | undefined { return value === undefined ? undefined : number(value) }
function vector(value: unknown): Vec3 { const point = record(value); return { x: number(point.x), y: number(point.y), z: number(point.z) } }
function actor(value: unknown): Actor { const ref = record(value); return { id: accountId(text(ref.id)), generation: natural(ref.generation), life: natural(ref.life) } }

function transit(value: unknown): Transit {
  const source = record(value)
  if (source.kind === 'none') return { kind: 'none' }
  if (source.kind === 'ambiguous') return { kind: 'ambiguous', originBank: side(source.originBank) }
  if (source.kind === 'pull') return { kind: 'pull', caster: actor(source.caster), originBank: side(source.originBank) }
  throw new Error('Unknown transit')
}

function life(value: unknown): Life {
  const source = record(value)
  if (source.kind === 'waiting') return { kind: 'waiting', notBefore: number(source.notBefore) }
  if (source.kind === 'dead') return { kind: 'dead', respawnAt: number(source.respawnAt), confirmed: bool(source.confirmed) }
  if (source.kind === 'alive') return { kind: 'alive', entity: natural(source.entity), bank: side(source.bank), position: vector(source.position), safe: vector(source.safe), protectionUntil: number(source.protectionUntil), transit: transit(source.transit) }
  throw new Error('Unknown life')
}

function phase(value: unknown): Phase {
  const source = record(value)
  if (source.kind === 'warmup' || source.kind === 'overtime') return { kind: source.kind }
  if (source.kind === 'countdown' || source.kind === 'live') return { kind: source.kind, until: number(source.until) }
  if (source.kind === 'results') return { kind: 'results', until: number(source.until), winner: source.winner === undefined ? undefined : side(source.winner), reason: text(source.reason) }
  throw new Error('Unknown phase')
}

function progression(value: unknown): Progression {
  const source = record(value)
  const owned: ProductId[] = list(source.owned).map(value => { if (!isProductId(value)) throw new Error('Unknown product'); return value })
  if (new Set(owned).size !== owned.length) throw new Error('Duplicate ownership')
  const setup = source.setup, utility = source.utility, defense = source.defense
  if (setup !== null && (!isSetup(setup) || !owned.includes(setup))) throw new Error('Unowned setup tool')
  if (utility !== null && (!isUtility(utility) || !owned.includes(utility))) throw new Error('Unowned utility')
  if (defense !== null && (!isDefense(defense) || !owned.includes(defense))) throw new Error('Unowned defense')
  const pending = source.purchase === null ? null : record(source.purchase)
  const product = pending?.product
  if (pending !== null && (!isProductId(product) || owned.includes(product))) throw new Error('Invalid purchase')
  const feedback = record(source.feedback)
  return {
    owned, setup, utility, defense,
    purchase: pending !== null && isProductId(product) ? { id: natural(pending.id), round: natural(pending.round), actor: actor(pending.actor), product } : null,
    feedback: { text: text(feedback.text), until: number(feedback.until) },
  }
}

function fighter(value: unknown): Fighter {
  const source = record(value), presence = record(source.presence), membership = record(source.membership), notice = record(source.notice)
  const income = record(source.income), threat = source.threat === null ? null : record(source.threat)
  const paidSaves = list(income.paidSaves).map(number)
  if (paidSaves.length * economy.rescue > economy.rescueLimit || paidSaves.some(time => time < 0)) throw new Error('Invalid rescue payments')
  if (presence.kind !== 'connected' && presence.kind !== 'away') throw new Error('Unknown presence')
  if (membership.kind !== 'seated' && membership.kind !== 'watching') throw new Error('Unknown membership')
  if (source.menu !== 'closed' && source.menu !== 'loadout') throw new Error('Unknown menu')
  return {
    id: accountId(text(source.id)), name: text(source.name),
    presence: presence.kind === 'connected' ? { kind: 'connected', slot: natural(presence.slot), generation: natural(presence.generation) } : { kind: 'away', until: number(presence.until) },
    membership: membership.kind === 'seated' ? { kind: 'seated', side: side(membership.side), seat: natural(membership.seat) } : { kind: 'watching' },
    serial: natural(source.serial), life: life(source.life), ready: bool(source.ready), progression: progression(source.progression),
    roundSide: source.roundSide === null ? null : side(source.roundSide),
    setupUntil: number(source.setupUntil), utilityUntil: number(source.utilityUntil), defenseUntil: number(source.defenseUntil), chillUntil: number(source.chillUntil),
    kills: natural(source.kills), saves: natural(source.saves), menu: source.menu,
    income: { passiveTicks: natural(income.passiveTicks), teamKills: natural(income.teamKills), pending: natural(income.pending), paidSaves },
    threat: threat === null ? null : { caster: actor(threat.caster), cast: number(threat.cast), resolved: bool(threat.resolved) },
    notice: { text: text(notice.text), until: number(notice.until) }, nextSeatAttempt: number(source.nextSeatAttempt),
  }
}

export function encodeCheckpoint(state: State): string {
  return JSON.stringify({ version: 5, ...state, fighters: Array.from(state.fighters.values()) })
}

export function decodeCheckpoint(textValue: string, config: Config): State | undefined {
  if (!textValue || textValue.length > 64 * 1024) return undefined
  try {
    const source = record(JSON.parse(textValue)), savedConfig = record(source.config)
    if (source.version !== 5 || savedConfig.teamSize !== config.teamSize || savedConfig.target !== config.target || savedConfig.matchSeconds !== config.matchSeconds) return undefined
    const score = record(source.score), empty = record(source.emptySince)
    const liveSeconds = number(source.liveSeconds)
    if (liveSeconds < 0 || liveSeconds > config.matchSeconds) return undefined
    const fighters = list(source.fighters).map(fighter)
    if (new Set(fighters.map(value => value.id)).size !== fighters.length) return undefined
    const seats = fighters.flatMap(fighter => fighter.membership.kind === 'seated' ? [`${fighter.membership.side}:${fighter.membership.seat}`] : [])
    if (new Set(seats).size !== seats.length || fighters.some(fighter => fighter.membership.kind === 'seated' && fighter.membership.seat >= config.teamSize)) return undefined
    return {
      config, now: number(source.now), round: natural(source.round), phase: phase(source.phase),
      liveSeconds,
      score: { 2: natural(score['2']), 3: natural(score['3']) },
      fighters: new Map(fighters.map(fighter => [fighter.id, fighter])), nextEvent: natural(source.nextEvent),
      emptySince: { 2: optionalTime(empty['2']), 3: optionalTime(empty['3']) },
      feed: list(source.feed).map(value => { const item = record(value); return { id: natural(item.id), text: text(item.text), side: item.side === undefined ? undefined : side(item.side), until: number(item.until) } }),
      pianos: [], knockdowns: [],
      globes: list(source.globes).map(value => { const item = record(value); return { id: natural(item.id), actor: actor(item.actor), side: side(item.side), position: vector(item.position), direction: vector(item.direction), travelled: number(item.travelled), updatedAt: number(item.updatedAt) } }),
    }
  } catch { return undefined }
}
