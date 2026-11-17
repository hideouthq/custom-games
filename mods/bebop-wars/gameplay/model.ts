import { arena, contain, direction, horizontalDistance, inBank, inShop, opposite, spawn, type Vec3 } from './arena.ts'
import type { HudAction, Side } from './hud-model.ts'
import { catalog, economy, warmupBudget, isProductId, scripted, type Defense, type Group, type HookRank, type ProductId, type Setup, type Utility } from './catalog.ts'
import { burstContains, globeRules, type Flight, type Launch } from './globe.ts'
import { flattened, pianoRules } from './piano.ts'
import { knockdownRules } from './sight.ts'

export type AccountId = string & { readonly __brand: 'AccountId' }
function isAccountId(value: string): value is AccountId { return /^[a-zA-Z0-9:_-]{1,80}$/.test(value) }
export function accountId(value: string): AccountId {
  if (!isAccountId(value)) throw new Error('Invalid player identity')
  return value
}

export interface Config {
  readonly teamSize: 1 | 2 | 3
  readonly target: number
  readonly matchSeconds: number
  readonly debug: boolean
  readonly probe: boolean
  readonly preview: boolean
  readonly practice: boolean
}

export function configuration(args: readonly string[]): Config {
  let teamSize: 1 | 2 | 3 = 2
  let debug = false, probe = false, preview = false, practice = false
  for (const arg of args) {
    if (arg === 'teams=1v1') teamSize = 1
    else if (arg === 'teams=2v2') teamSize = 2
    else if (arg === 'teams=3v3') teamSize = 3
    else if (arg === 'debug') debug = true
    else if (arg === 'probe') { probe = true; debug = true }
    else if (arg === 'preview') preview = true
    else if (arg === 'practice') practice = true
    else throw new Error(`Unknown Bebop Wars argument: ${arg}`)
  }
  if (practice && (teamSize !== 1 || probe || preview)) throw new Error('Practice requires 1v1 without probe or preview')
  return { teamSize, target: 25, matchSeconds: 480, debug, probe, preview, practice }
}

export const rules = {
  countdown: 5, respawn: 4, results: 10, reconnect: 30, protection: 1,
  sprintCooldown: catalog.sprint.cooldown, sprintSeconds: 3, echoCooldown: catalog.echo.cooldown,
} as const

export type Phase =
  | { kind: 'warmup' }
  | { kind: 'countdown'; until: number }
  | { kind: 'live'; until: number }
  | { kind: 'overtime' }
  | { kind: 'results'; until: number; winner: Side | undefined; reason: string }

export interface Actor { readonly id: AccountId; readonly generation: number; readonly life: number }
export interface HookSample {
  readonly entity: number
  readonly casting: boolean
  readonly victim: AccountId | undefined
  readonly startedAt: number
  readonly cooldownEnd: number
  readonly executed: boolean
}
export interface BodySample {
  readonly health: number
  readonly maxHealth: number
  readonly souls: number
  readonly abilityPoints: number
  readonly hookRank: HookRank
  readonly nativeItems: readonly { readonly product: ProductId; readonly slot: number }[]
  readonly sprintActive?: boolean
  readonly entity: number
  readonly alive: boolean
  readonly side: Side
  readonly position: Vec3
  readonly velocity: Vec3
  readonly hook: HookSample | undefined
}
export interface Observation {
  readonly id: AccountId
  readonly slot: number
  readonly generation: number
  readonly name: string
  readonly bot: boolean
  readonly body: BodySample | undefined
}
export interface Frame {
  readonly now: number
  readonly players: readonly Observation[]
  readonly deaths: readonly { readonly victim: Actor; readonly attacker: Actor | null }[]
  readonly globes: ReadonlyMap<number, GlobeSample>
  readonly pulls: ReadonlyMap<AccountId, { readonly kind: 'held'; readonly owner: AccountId } | { readonly kind: 'ambiguous' }>
}

export function hookBusy(hook: HookSample): boolean { return hook.casting || hook.victim !== undefined }

export type Transit =
  | { kind: 'none' }
  | { kind: 'pull'; caster: Actor; originBank: Side }
  | { kind: 'ambiguous'; originBank: Side }

export type Life =
  | { kind: 'waiting'; notBefore: number }
  | { kind: 'alive'; entity: number; bank: Side; position: Vec3; safe: Vec3; protectionUntil: number; transit: Transit }
  | { kind: 'dead'; respawnAt: number; confirmed: boolean }

export interface Progression {
  owned: ProductId[]
  setup: Setup | null
  utility: Utility | null
  defense: Defense | null
  purchase: { id: number; round: number; actor: Actor; product: ProductId } | null
  feedback: { text: string; until: number }
}

export function freshProgression(): Progression {
  return { owned: [], setup: null, utility: null, defense: null, purchase: null, feedback: { text: '', until: 0 } }
}

function freshRound(now: number): Pick<Fighter, 'setupUntil' | 'utilityUntil' | 'defenseUntil' | 'chillUntil' | 'kills' | 'saves' | 'menu' | 'income' | 'threat'> {
  return { setupUntil: now, utilityUntil: now, defenseUntil: now, chillUntil: 0, kills: 0, saves: 0, menu: 'closed', income: { passiveTicks: 0, teamKills: 0, pending: 0, paidSaves: [] }, threat: null }
}

export function equip(progression: Progression, product: ProductId): void {
  const group = catalog[product].group
  if (group === 'setup') progression.setup = product as Setup
  else if (group === 'utility') progression.utility = product as Utility
  else progression.defense = product as Defense
}

export function deadlineOf(fighter: Pick<Fighter, 'setupUntil' | 'utilityUntil' | 'defenseUntil'>, group: Group): number {
  return group === 'setup' ? fighter.setupUntil : group === 'utility' ? fighter.utilityUntil : fighter.defenseUntil
}
function setDeadline(fighter: Fighter, group: Group, until: number): void {
  if (group === 'setup') fighter.setupUntil = until
  else if (group === 'utility') fighter.utilityUntil = until
  else fighter.defenseUntil = until
}

export interface Fighter {
  readonly id: AccountId
  name: string
  presence: { kind: 'connected'; slot: number; generation: number } | { kind: 'away'; until: number }
  membership: { kind: 'seated'; side: Side; seat: number } | { kind: 'watching' }
  serial: number
  life: Life
  ready: boolean
  progression: Progression
  roundSide: Side | null
  setupUntil: number
  utilityUntil: number
  defenseUntil: number
  chillUntil: number
  kills: number
  saves: number
  income: { passiveTicks: number; teamKills: number; pending: number; paidSaves: number[] }
  threat: { caster: Actor; cast: number; resolved: boolean } | null
  menu: 'closed' | 'loadout'
  notice: { text: string; until: number }
  nextSeatAttempt: number
}

export interface GlobeSample extends Flight { readonly ended: boolean; readonly clear: readonly AccountId[] }
export interface Knockdown { readonly id: number; readonly actor: Actor; readonly victim: Actor; readonly landsAt: number }
export interface Piano { readonly id: number; readonly actor: Actor; readonly side: Side; readonly mark: Vec3; readonly landsAt: number }
export interface SnowGlobe extends Flight {
  readonly id: number
  readonly actor: Actor
  readonly side: Side
}
export interface Feed { readonly id: number; readonly text: string; readonly side: Side | undefined; readonly until: number }
export interface State {
  readonly config: Config
  now: number
  round: number
  phase: Phase
  fighters: Map<AccountId, Fighter>
  score: Record<Side, number>
  globes: SnowGlobe[]
  pianos: Piano[]
  knockdowns: Knockdown[]
  feed: Feed[]
  nextEvent: number
  liveSeconds: number
  emptySince: Record<Side, number | undefined>
}

export type Request =
  | { readonly actor: Actor; readonly kind: 'hud'; readonly action: HudAction }
  | { readonly actor: Actor; readonly kind: 'tool'; readonly tool: Group; readonly menuAtPress: 'closed' | 'loadout'; readonly launch: Launch | undefined; readonly mark?: Vec3; readonly sighted?: AccountId }
  | { readonly actor: Actor; readonly kind: 'failed'; readonly tool: Exclude<ProductId, 'snowGlobe' | 'piano' | 'knockdown'>; readonly previousDeadline: number; readonly attemptedAt: number }
export type Failure = Extract<Request, { kind: 'failed' }>

export type Command =
  | { readonly kind: 'seat'; readonly actor: Actor; readonly side: Side }
  | { readonly kind: 'spectate'; readonly actor: Actor }
  | { readonly kind: 'deploy'; readonly actor: Actor; readonly side: Side; readonly position: Vec3 }
  | { readonly kind: 'respawn'; readonly actor: Actor }
  | { readonly kind: 'buy'; readonly actor: Actor; readonly round: number; readonly id: number; readonly product: ProductId }
  | { readonly kind: 'reset'; readonly actor: Actor; readonly round: number }
  | { readonly kind: 'income'; readonly actor: Actor; readonly round: number; readonly amount: number }
  | { readonly kind: 'move'; readonly actor: Actor; readonly position: Vec3; readonly velocity: Vec3 }
  | { readonly kind: 'sprint' | 'echo' | 'shrink'; readonly actor: Actor; readonly previousDeadline: number; readonly attemptedAt: number }
  | { readonly kind: 'cast'; readonly actor: Actor; readonly product: 'etherealShift' | 'rescueBeam'; readonly previousDeadline: number; readonly attemptedAt: number }
  | { readonly kind: 'snowGlobe'; readonly snowGlobe: SnowGlobe }
  | { readonly kind: 'piano'; readonly piano: Piano }
  | { readonly kind: 'pianoLand'; readonly id: number; readonly mark: Vec3 }
  | { readonly kind: 'stun'; readonly actor: Actor; readonly id: number; readonly seconds: number }
  | { readonly kind: 'knockdown'; readonly actor: Actor; readonly victim: Actor; readonly id: number }
  | { readonly kind: 'impact'; readonly id: number; readonly position: Vec3; readonly side: Side }
  | { readonly kind: 'chill'; readonly actor: Actor; readonly id: number }
  | { readonly kind: 'saved'; readonly actor: Actor; readonly id: number }

export function initial(config: Config): State {
  return { config, now: 0, round: 0, phase: { kind: 'warmup' }, fighters: new Map(), score: { 2: 0, 3: 0 }, globes: [], pianos: [], knockdowns: [], feed: [], nextEvent: 1, liveSeconds: 0, emptySince: { 2: undefined, 3: undefined } }
}

export function actor(fighter: Fighter): Actor | undefined {
  return fighter.presence.kind === 'connected' ? { id: fighter.id, generation: fighter.presence.generation, life: fighter.serial } : undefined
}

export function matches(fighter: Fighter | undefined, ref: Actor): fighter is Fighter {
  return fighter !== undefined && fighter.presence.kind === 'connected' && fighter.presence.generation === ref.generation && fighter.serial === ref.life
}

export function playing(state: State): boolean { return state.phase.kind === 'live' || state.phase.kind === 'overtime' }

function copy(previous: State, now: number): State {
  return {
    ...previous, now, phase: { ...previous.phase }, score: { ...previous.score }, emptySince: { ...previous.emptySince },
    fighters: new Map(Array.from(previous.fighters, ([key, value]) => [key, {
      ...value, life: value.life.kind === 'alive' ? { ...value.life, transit: { ...value.life.transit } } : { ...value.life }, notice: { ...value.notice },
      presence: { ...value.presence }, membership: { ...value.membership },
      income: { ...value.income, paidSaves: [...value.income.paidSaves] }, threat: value.threat === null ? null : { ...value.threat },
      progression: {
        ...value.progression, owned: [...value.progression.owned],
        feedback: { ...value.progression.feedback },
      },
    }])),
    globes: previous.globes.slice(), pianos: previous.pianos.slice(), knockdowns: previous.knockdowns.slice(), feed: previous.feed.filter(item => item.until > now),
  }
}

function tell(state: State, text: string, side?: Side): void {
  state.feed.push({ id: state.nextEvent++, text, side, until: state.now + 5 })
  state.feed = state.feed.slice(-3)
}
function notice(state: State, fighter: Fighter, text: string): void { fighter.notice = { text, until: state.now + 2.5 } }

function walletFeedback(state: State, fighter: Fighter, text: string): void {
  fighter.progression.feedback = { text, until: state.now + 3 }
}

function pay(state: State, fighter: Fighter, amount: number, reason?: string): void {
  fighter.income.pending += amount
  if (reason) walletFeedback(state, fighter, `${reason}: +${amount} Souls`)
}

function baselineIncome(state: State): void {
  const ticks = Math.floor(state.liveSeconds / economy.passiveSeconds)
  for (const fighter of state.fighters.values()) {
    if (fighter.membership.kind !== 'seated') continue
    const kills = state.score[fighter.membership.side]
    pay(state, fighter, Math.max(0, ticks - fighter.income.passiveTicks) * economy.passive + Math.max(0, kills - fighter.income.teamKills) * economy.teamKill)
    fighter.income.passiveTicks = ticks
    fighter.income.teamKills = kills
  }
}

function purchase(state: State, fighter: Fighter, product: ProductId, frame: Frame, commands: Command[]): void {
  const progression = fighter.progression
  if (progression.owned.includes(product) || progression.purchase !== null) return
  if (catalog[product].teamOnly && state.config.teamSize === 1) { notice(state, fighter, `${catalog[product].name} needs a teammate`); return }
  const body = frame.players.find(sample => sample.id === fighter.id)?.body
  if (!body) { notice(state, fighter, 'Shop unavailable until your body returns'); return }
  const available = state.phase.kind === 'warmup' ? Math.min(body.souls, warmupBudget(progression.owned)) : body.souls
  const item = catalog[product]
  if (available < item.price) { notice(state, fighter, `Need ${item.price - available} more Souls`); return }
  const ref = actor(fighter)
  if (!ref) return
  const id = state.nextEvent++
  progression.purchase = { id, round: state.round, actor: ref, product }
  commands.push({ kind: 'buy', actor: ref, round: state.round, id, product })
}

export interface Receipt {
  readonly kind: 'purchase'
  readonly actor: Actor
  readonly round: number
  readonly id: number
  readonly result: 'bought' | 'unaffordable' | 'unavailable'
}

export function settle(previous: State, receipts: readonly Receipt[]): State {
  const state = copy(previous, previous.now)
  for (const receipt of receipts) {
    const fighter = state.fighters.get(receipt.actor.id)
    if (!matches(fighter, receipt.actor) || receipt.round !== state.round) continue
    const pending = fighter.progression.purchase
    if (!pending || pending.id !== receipt.id || pending.round !== receipt.round || pending.actor.life !== receipt.actor.life || pending.actor.generation !== receipt.actor.generation) continue
    fighter.progression.purchase = null
    if (receipt.result !== 'bought') {
      notice(state, fighter, receipt.result === 'unaffordable' ? 'Not enough Souls' : 'Purchase unavailable. Souls kept')
      continue
    }
    fighter.progression.owned.push(pending.product)
    equip(fighter.progression, pending.product)
    walletFeedback(state, fighter, `${catalog[pending.product].name} purchased`)
  }
  return state
}

export function freeSeat(state: State, preferred?: Side): Fighter['membership'] {
  const used = (side: Side) => Array.from(state.fighters.values()).filter(p => p.membership.kind === 'seated' && p.membership.side === side)
  const sides: Side[] = preferred ? [preferred] : used(3).length <= used(2).length ? [3, 2] : [2, 3]
  for (const side of sides) {
    const members = used(side)
    if (members.length >= state.config.teamSize) continue
    for (let seat = 0; seat < state.config.teamSize; seat++) {
      if (!members.some(p => p.membership.kind === 'seated' && p.membership.seat === seat)) return { kind: 'seated', side, seat }
    }
  }
  return { kind: 'watching' }
}

function sync(state: State, frame: Frame, commands: Command[]): void {
  const present = new Set(frame.players.map(p => p.id))
  for (const fighter of state.fighters.values()) {
    if (!present.has(fighter.id) && fighter.id.startsWith('bot:')) {
      state.fighters.delete(fighter.id)
      continue
    }
    if (!present.has(fighter.id) && fighter.presence.kind === 'connected') {
      fighter.presence = { kind: 'away', until: state.now + rules.reconnect }
      fighter.life = { kind: 'waiting', notBefore: state.now + rules.respawn }
      fighter.menu = 'closed'
      fighter.ready = false
      fighter.chillUntil = 0
    }
    if (fighter.presence.kind === 'away' && state.now >= fighter.presence.until) fighter.membership = { kind: 'watching' }
  }
  for (const observed of frame.players) {
    let fighter = state.fighters.get(observed.id)
    if (fighter === undefined) {
      fighter = {
        id: observed.id, name: observed.name,
        presence: { kind: 'connected', slot: observed.slot, generation: observed.generation },
        membership: state.phase.kind === 'warmup' || playing(state) ? freeSeat(state) : { kind: 'watching' },
        serial: 0, life: { kind: 'waiting', notBefore: state.now }, ready: observed.bot && state.config.probe,
        progression: freshProgression(), roundSide: null, notice: { text: '', until: 0 }, nextSeatAttempt: 0, ...freshRound(0),
      }
      state.fighters.set(fighter.id, fighter)
      commands.push({ kind: 'reset', actor: { id: fighter.id, generation: observed.generation, life: 0 }, round: state.round })
    } else if (fighter.presence.kind === 'away' || fighter.presence.generation !== observed.generation) {
      fighter.presence = { kind: 'connected', slot: observed.slot, generation: observed.generation }
      fighter.life = { kind: 'waiting', notBefore: state.now + (playing(state) ? rules.respawn : 0) }
      fighter.menu = 'closed'
      fighter.nextSeatAttempt = 0
      fighter.progression.purchase = null
    }
    fighter.name = observed.name
    const ref = actor(fighter)
    if (!ref) continue
    if (fighter.membership.kind === 'watching') {
      if (state.phase.kind === 'warmup' || playing(state)) fighter.membership = freeSeat(state, fighter.roundSide ?? undefined)
      if (fighter.membership.kind === 'watching') {
        if (state.now >= fighter.nextSeatAttempt) {
          commands.push({ kind: 'spectate', actor: ref })
          fighter.nextSeatAttempt = state.now + 1
        }
        continue
      }
    }
    const membership = fighter.membership
    if (playing(state)) fighter.roundSide ??= membership.side
    const body = observed.body
    if (!body || body.side !== membership.side) {
      if (state.now >= fighter.nextSeatAttempt && !(fighter.life.kind === 'waiting' && state.now < fighter.life.notBefore)) {
        commands.push({ kind: 'seat', actor: ref, side: membership.side })
        fighter.nextSeatAttempt = state.now + 1
      }
      continue
    }
    if (!body.alive) {
      if (fighter.life.kind !== 'dead') fighter.life = { kind: 'dead', respawnAt: state.now + rules.respawn, confirmed: true }
      else fighter.life.confirmed = true
      fighter.chillUntil = 0
      if (state.now >= fighter.life.respawnAt && state.now >= fighter.nextSeatAttempt) {
        commands.push({ kind: 'respawn', actor: ref })
        fighter.nextSeatAttempt = state.now + 0.5
      }
      continue
    }
    if (fighter.life.kind === 'dead' && !fighter.life.confirmed) continue
    if (fighter.life.kind === 'dead' && state.now < fighter.life.respawnAt) continue
    if (fighter.life.kind === 'waiting' && state.now < fighter.life.notBefore) continue
    if (fighter.life.kind !== 'alive' || fighter.life.entity !== body.entity) {
      fighter.serial++
      const position = spawn(membership.side, membership.seat, state.config.teamSize)
      fighter.life = { kind: 'alive', entity: body.entity, bank: membership.side, position, safe: position, protectionUntil: state.now + rules.protection, transit: { kind: 'none' } }
      fighter.threat = null
      fighter.chillUntil = 0
      fighter.menu = 'closed'
      commands.push({ kind: 'deploy', actor: { ...ref, life: fighter.serial }, side: membership.side, position })
    } else {
      fighter.life.position = body.position
    }
  }
}

function deaths(state: State, frame: Frame): void {
  const before = { ...state.score }
  const eligible = frame.deaths.flatMap(event => {
    const victim = state.fighters.get(event.victim.id)
    if (!matches(victim, event.victim) || victim.life.kind !== 'alive') return []
    const attacker = event.attacker === null ? undefined : state.fighters.get(event.attacker.id)
    const killer = event.attacker !== null && matches(attacker, event.attacker) && attacker.membership.kind === 'seated' && victim.membership.kind === 'seated' && attacker.membership.side !== victim.membership.side ? attacker : undefined
    return [{ victim, killer }]
  })
  for (const { victim, killer } of eligible) {
    if (victim.life.kind !== 'alive') continue
    victim.life = { kind: 'dead', respawnAt: state.now + rules.respawn, confirmed: false }
    victim.chillUntil = 0
    victim.threat = null
    victim.menu = 'closed'
    if (playing(state) && killer?.membership.kind === 'seated') {
      killer.kills++
      state.score[killer.membership.side]++
      if (state.phase.kind === 'live' && state.now < state.phase.until) {
        const side = killer.membership.side
        const comeback = before[opposite(side)] - before[side] >= economy.comebackDeficit
        for (const teammate of state.fighters.values()) {
          if (teammate.membership.kind !== 'seated' || teammate.membership.side !== side) continue
          pay(state, teammate, teammate.id === killer.id ? (comeback ? economy.comebackKill : economy.kill) : (comeback ? economy.comebackTeamKill : economy.teamKill), teammate.id === killer.id ? (comeback ? 'Comeback kill' : 'Kill') : 'Team kill')
          teammate.income.teamKills++
        }
      }
      tell(state, `${killer.name} killed ${victim.name}`, killer.membership.side)
    }
  }
}

function resolvePulls(state: State, frame: Frame, commands: Command[]): void {
  for (const victim of state.fighters.values()) {
    if (victim.life.kind !== 'alive' || victim.membership.kind !== 'seated' || victim.presence.kind !== 'connected') continue
    const life = victim.life, home = victim.membership.side, previous = life.transit
    const sample = frame.pulls.get(victim.id)
    const caster = sample?.kind === 'held' ? state.fighters.get(sample.owner) : undefined
    const ref = actor(victim)
    if (!ref) continue
    if (sample?.kind === 'ambiguous') {
      life.transit = { kind: 'ambiguous', originBank: previous.kind === 'none' ? life.bank : previous.originBank }
      victim.menu = 'closed'
      continue
    }
    if (caster?.life.kind === 'alive' && caster.membership.kind === 'seated') {
      const casterRef = actor(caster)
      if (casterRef) {
        if (caster.membership.side !== home) {
          const cast = frame.players.find(sample => sample.id === caster.id)?.body?.hook?.startedAt
          const threat = victim.threat
          if (cast !== undefined && (!threat || threat.caster.id !== casterRef.id || threat.caster.generation !== casterRef.generation || threat.caster.life !== casterRef.life || threat.cast !== cast)) victim.threat = { caster: casterRef, cast, resolved: false }
        }
        life.transit = {
          kind: 'pull', caster: casterRef, originBank: previous.kind === 'none' ? life.bank : previous.originBank,
        }
        victim.menu = 'closed'
        continue
      }
    }
    if (previous.kind === 'pull') {
      const owner = state.fighters.get(previous.caster.id)
      const valid = matches(owner, previous.caster) && owner.life.kind === 'alive' && owner.membership.kind === 'seated'
      const landed = inBank(life.position, home) ? home : inBank(life.position, opposite(home)) ? opposite(home) : undefined
      if (valid && landed !== undefined) {
        life.bank = landed
        if (victim.threat && !victim.threat.resolved && landed === home && owner.membership.kind === 'seated' && owner.membership.side === home && playing(state)) {
          victim.threat.resolved = true
          owner.saves++
          owner.income.paidSaves = owner.income.paidSaves.filter(time => state.liveSeconds - time < economy.rescueWindow)
          if (state.phase.kind === 'live' && owner.income.paidSaves.length * economy.rescue < economy.rescueLimit) {
            owner.income.paidSaves.push(state.liveSeconds)
            pay(state, owner, economy.rescue, 'Save')
          }
          notice(state, victim, 'Saved')
          tell(state, `${owner.name} saved ${victim.name}`, home)
          commands.push({ kind: 'saved', actor: ref, id: state.nextEvent++ })
        }
        if (landed === home && victim.threat) victim.threat.resolved = true
      } else life.bank = previous.originBank
    } else if (previous.kind === 'ambiguous') life.bank = previous.originBank
    life.transit = { kind: 'none' }
    if (life.bank === home && victim.threat) victim.threat.resolved = true
    if (inBank(life.position, life.bank)) life.safe = life.position
    else {
      const edge = contain(life.position, life.bank)
      const moving = frame.players.find(sample => sample.id === victim.id)?.body?.velocity
      if (edge && moving && life.position.z >= life.safe.z - 32 && horizontalDistance(edge, life.position) <= arena.containReach) {
        const outward = direction(life.bank) * moving.y < 0 && edge.y !== life.position.y
        const sideways = edge.x !== life.position.x && Math.sign(moving.x) === Math.sign(life.position.x)
        commands.push({ kind: 'move', actor: ref, position: edge, velocity: { x: sideways ? 0 : moving.x, y: outward ? 0 : moving.y, z: moving.z } })
        life.position = edge
        life.safe = edge
      } else {
        commands.push({ kind: 'move', actor: ref, position: life.safe, velocity: { x: 0, y: 0, z: 0 } })
        life.position = life.safe
      }
      notice(state, victim, 'Only a Hook can carry you across')
    }
  }
}

function requests(state: State, frame: Frame, pending: readonly Request[], commands: Command[]): void {
  const samples = new Map(frame.players.map(p => [p.id, p]))
  for (const request of pending) {
    const fighter = state.fighters.get(request.actor.id)
    if (!matches(fighter, request.actor)) continue
    if (request.kind === 'failed') {
      const item = catalog[request.tool]
      if (deadlineOf(fighter, item.group) === request.attemptedAt + item.cooldown) setDeadline(fighter, item.group, request.previousDeadline)
      notice(state, fighter, scripted(request.tool) ? 'Tool unavailable; cooldown restored' : `${item.name} found no target`)
      continue
    }
    if (request.kind === 'hud') {
      const action = request.action
      if (action.kind === 'close') fighter.menu = 'closed'
      else if (action.kind === 'ready' && state.phase.kind === 'warmup' && fighter.membership.kind === 'seated') fighter.ready = !fighter.ready
      else if (action.kind === 'team' && state.phase.kind === 'warmup') {
        const old = fighter.membership
        fighter.membership = { kind: 'watching' }
        const next = freeSeat(state, action.side)
        fighter.membership = next.kind === 'seated' ? next : old
        if (next.kind === 'seated') { fighter.ready = false; fighter.life = { kind: 'waiting', notBefore: state.now }; fighter.nextSeatAttempt = 0 }
      } else if (action.kind === 'shop') {
        if (canShop(state, fighter)) fighter.menu = 'loadout'
      } else if ((action.kind === 'buy' || action.kind === 'equip') && canShop(state, fighter)) {
        const access = purchaseAccess(state, fighter, frame)
        if (!access.allowed) notice(state, fighter, access.reason)
        else if (action.kind === 'buy' && isProductId(action.product)) purchase(state, fighter, action.product, frame, commands)
        else if (action.kind === 'equip' && isProductId(action.utility) && fighter.progression.owned.includes(action.utility)) {
          equip(fighter.progression, action.utility)
          notice(state, fighter, `${catalog[action.utility].name} equipped${fighter.life.kind === 'dead' ? ' next spawn' : ''}`)
        }
      }
      continue
    }
    if (request.menuAtPress !== 'closed' || fighter.menu !== 'closed' || !canAct(state, fighter)) continue
    const body = samples.get(fighter.id)?.body
    if (!body) continue
    const product = fighter.progression[request.tool]
    if (product === null || !fighter.progression.owned.includes(product)) { notice(state, fighter, 'Buy an item for this slot at Shop'); continue }
    const item = catalog[product]
    if (product === 'snowGlobe') {
      const flying = state.globes.find(globe => globe.actor.id === fighter.id)
      if (flying) {
        if (flying.updatedAt > state.now || !frame.globes.has(flying.id)) continue
        burst(state, flying, frame, commands)
        state.globes = state.globes.filter(globe => globe.id !== flying.id)
        continue
      }
      if (state.now < fighter.setupUntil) { notice(state, fighter, 'Snow Globe is cooling down'); continue }
      if (!request.launch || fighter.membership.kind !== 'seated') { notice(state, fighter, 'Aim with a clear view'); continue }
      fighter.setupUntil = state.now + item.cooldown
      const snowGlobe: SnowGlobe = { id: state.nextEvent++, actor: request.actor, side: fighter.membership.side, ...request.launch, travelled: 0, updatedAt: state.now }
      state.globes.push(snowGlobe)
      commands.push({ kind: 'snowGlobe', snowGlobe })
      continue
    }
    const previousDeadline = deadlineOf(fighter, item.group)
    if (state.now < previousDeadline) { notice(state, fighter, `${item.name} is cooling down`); continue }
    if (product === 'echo') {
      if (!body.hook || hookBusy(body.hook)) { notice(state, fighter, 'Wait for your hook to return'); continue }
      if (body.hook.cooldownEnd <= state.now) { notice(state, fighter, 'Hook is already ready'); continue }
    }
    if (!scripted(product) && fighter.life.kind === 'alive' && fighter.life.transit.kind !== 'none') { notice(state, fighter, 'You are caught'); continue }
    if (product === 'knockdown') {
      const victim = request.sighted === undefined ? undefined : state.fighters.get(request.sighted)
      const marked = victim && victim.life.kind === 'alive' && victim.life.protectionUntil <= state.now && victim.membership.kind === 'seated' && fighter.membership.kind === 'seated' && victim.membership.side !== fighter.membership.side ? actor(victim) : undefined
      if (!marked) { notice(state, fighter, 'No enemy in your sights'); continue }
      fighter.setupUntil = state.now + item.cooldown
      const id = state.nextEvent++
      state.knockdowns.push({ id, actor: request.actor, victim: marked, landsAt: state.now + knockdownRules.delay })
      commands.push({ kind: 'knockdown', actor: request.actor, victim: marked, id })
      notice(state, victim!, 'Marked by Knockdown')
      continue
    }
    if (product === 'piano') {
      if (!request.mark || fighter.membership.kind !== 'seated') { notice(state, fighter, 'Aim at the ground'); continue }
      fighter.setupUntil = state.now + item.cooldown
      const piano: Piano = { id: state.nextEvent++, actor: request.actor, side: fighter.membership.side, mark: request.mark, landsAt: state.now + pianoRules.delay }
      state.pianos.push(piano)
      commands.push({ kind: 'piano', piano })
      continue
    }
    setDeadline(fighter, item.group, state.now + item.cooldown)
    if (product === 'sprint' || product === 'echo') commands.push({ kind: product, actor: request.actor, previousDeadline, attemptedAt: state.now })
    else if (product === 'shrinkRay') commands.push({ kind: 'shrink', actor: request.actor, previousDeadline, attemptedAt: state.now })
    else commands.push({ kind: 'cast', actor: request.actor, product, previousDeadline, attemptedAt: state.now })
  }
}

export function canShop(state: State, fighter: Fighter): boolean {
  return fighter.membership.kind === 'seated' && fighter.presence.kind === 'connected' && state.phase.kind !== 'results' && state.phase.kind !== 'countdown' && state.phase.kind !== 'overtime' && (fighter.life.kind !== 'alive' || fighter.life.transit.kind === 'none')
}

export function purchaseAccess(state: State, fighter: Fighter, frame: Frame): { allowed: boolean; reason: string } {
  if (!canShop(state, fighter)) return { allowed: false, reason: 'Shop unavailable' }
  if (state.phase.kind === 'overtime' || (state.phase.kind === 'live' && state.now >= state.phase.until)) return { allowed: false, reason: 'Shop closed for overtime' }
  const hook = frame.players.find(sample => sample.id === fighter.id)?.body?.hook
  if (hook && hookBusy(hook)) return { allowed: false, reason: 'Wait for your Hook to return' }
  if (state.phase.kind === 'warmup' || fighter.life.kind === 'dead') return { allowed: true, reason: '' }
  if (fighter.life.kind === 'alive' && fighter.membership.kind === 'seated' && inShop(fighter.life.position, fighter.membership.side)) return { allowed: true, reason: '' }
  return { allowed: false, reason: 'Return to your shop to buy' }
}

export function canAct(state: State, fighter: Fighter): boolean {
  return (playing(state) || state.phase.kind === 'warmup') && fighter.membership.kind === 'seated' && fighter.life.kind === 'alive' && fighter.life.protectionUntil <= state.now && fighter.menu === 'closed' && fighter.life.transit.kind === 'none'
}

function burst(state: State, globe: SnowGlobe, frame: Frame, commands: Command[]): void {
  commands.push({ kind: 'impact', id: globe.id, position: globe.position, side: globe.side })
  const clear = frame.globes.get(globe.id)?.clear ?? []
  for (const target of state.fighters.values()) {
    if (target.presence.kind !== 'connected' || target.membership.kind !== 'seated' || target.membership.side === globe.side || target.life.kind !== 'alive' || target.life.protectionUntil > state.now || !clear.includes(target.id)) continue
    if (!burstContains(globe.position, target.life.position)) continue
    const ref = actor(target)
    if (!ref) continue
    target.chillUntil = state.now + globeRules.chill
    commands.push({ kind: 'chill', actor: ref, id: state.nextEvent++ })
    notice(state, target, 'Chilled by Snow Globe')
  }
}

function landings(state: State, commands: Command[]): void {
  const falling: Piano[] = []
  for (const piano of state.pianos) {
    if (state.now < piano.landsAt) { falling.push(piano); continue }
    commands.push({ kind: 'pianoLand', id: piano.id, mark: piano.mark })
    for (const target of state.fighters.values()) {
      if (target.presence.kind !== 'connected' || target.membership.kind !== 'seated' || target.membership.side === piano.side || target.life.kind !== 'alive' || target.life.protectionUntil > state.now) continue
      if (!flattened(piano.mark, target.life.position)) continue
      const ref = actor(target)
      if (!ref) continue
      commands.push({ kind: 'stun', actor: ref, id: state.nextEvent++, seconds: pianoRules.stun })
      notice(state, target, 'Flattened by Mystical Piano')
    }
  }
  state.pianos = falling
  const marked: Knockdown[] = []
  for (const knockdown of state.knockdowns) {
    const victim = state.fighters.get(knockdown.victim.id)
    if (!matches(victim, knockdown.victim) || victim.life.kind !== 'alive') continue
    if (state.now < knockdown.landsAt) { marked.push(knockdown); continue }
    commands.push({ kind: 'stun', actor: knockdown.victim, id: state.nextEvent++, seconds: knockdownRules.stun })
    notice(state, victim, 'Knocked down')
  }
  state.knockdowns = marked
}

function flights(state: State, frame: Frame, commands: Command[]): void {
  const keep: SnowGlobe[] = []
  for (const globe of state.globes) {
    const caster = state.fighters.get(globe.actor.id)
    if (!matches(caster, globe.actor) || caster.life.kind !== 'alive') continue
    const sample = frame.globes.get(globe.id)
    if (!sample) { keep.push(globe); continue }
    const next = { ...globe, position: sample.position, travelled: sample.travelled, updatedAt: sample.updatedAt }
    if (sample.ended) burst(state, next, frame, commands)
    else keep.push(next)
  }
  state.globes = keep
}

function advance(state: State, frame: Frame, commands: Command[]): void {
  const seated = Array.from(state.fighters.values()).filter(p => p.membership.kind === 'seated' && p.presence.kind === 'connected')
  const ready = seated.length === state.config.teamSize * 2 && seated.every(p => p.ready && p.life.kind === 'alive')
  const hooksReturned = seated.every(p => {
    const hook = frame.players.find(sample => sample.id === p.id)?.body?.hook
    return p.life.kind === 'alive' && p.life.transit.kind === 'none' && hook !== undefined && !hookBusy(hook)
  })
  if (state.phase.kind === 'warmup' && ready && hooksReturned) {
    state.phase = { kind: 'countdown', until: state.now + rules.countdown }
    state.score = { 2: 0, 3: 0 }
    state.liveSeconds = 0
    state.feed = []
    state.globes = []
    state.pianos = []
    state.knockdowns = []
    for (const p of seated) {
      Object.assign(p, freshRound(state.now))
      p.roundSide = p.membership.kind === 'seated' ? p.membership.side : null
      if (p.life.kind === 'alive' && p.membership.kind === 'seated') {
        const ref = actor(p), position = spawn(p.membership.side, p.membership.seat, state.config.teamSize)
        p.life.transit = { kind: 'none' }; p.life.bank = p.membership.side; p.life.position = position; p.life.safe = position
        if (ref) commands.push({ kind: 'deploy', actor: ref, side: p.membership.side, position })
      }
    }
  } else if (state.phase.kind === 'countdown') {
    if (!ready) {
      state.phase = { kind: 'warmup' }
      for (const fighter of state.fighters.values()) fighter.roundSide = null
    }
    else if (state.now >= state.phase.until) state.phase = { kind: 'live', until: state.now + state.config.matchSeconds }
  } else if (playing(state)) {
    for (const side of [2, 3] satisfies Side[]) {
      const connected = seated.some(p => p.membership.kind === 'seated' && p.membership.side === side)
      state.emptySince[side] = connected ? undefined : state.emptySince[side] ?? state.now
    }
    const amberGone = state.emptySince[2], sapphireGone = state.emptySince[3]
    if (amberGone !== undefined && sapphireGone !== undefined && state.now - Math.max(amberGone, sapphireGone) >= rules.reconnect) finish(state, undefined, 'Match abandoned')
    else if (amberGone !== undefined && state.now - amberGone >= rules.reconnect) finish(state, 3, 'Amber team left')
    else if (sapphireGone !== undefined && state.now - sapphireGone >= rules.reconnect) finish(state, 2, 'Sapphire team left')
    else {
      const reached = Math.max(state.score[2], state.score[3]) >= state.config.target
      if (reached || state.phase.kind === 'overtime') {
        if (state.score[2] === state.score[3]) state.phase = { kind: 'overtime' }
        else finish(state, state.score[2] > state.score[3] ? 2 : 3, 'Kill victory')
      }
    }
  } else if (state.phase.kind === 'results' && state.now >= state.phase.until) {
    state.phase = { kind: 'warmup' }
    state.round++
    state.emptySince = { 2: undefined, 3: undefined }
    state.score = { 2: 0, 3: 0 }
    state.liveSeconds = 0
    for (const p of state.fighters.values()) {
      Object.assign(p, freshRound(state.now))
      p.ready = false; p.roundSide = null; p.progression = freshProgression()
      const ref = actor(p)
      if (ref) commands.push({ kind: 'reset', actor: ref, round: state.round })
      p.life = { kind: 'waiting', notBefore: state.now }
    }
  }
}

function finish(state: State, winner: Side | undefined, reason: string): void {
  state.phase = { kind: 'results', until: state.now + rules.results, winner, reason }
  state.globes = []
  state.pianos = []
  state.knockdowns = []
  for (const fighter of state.fighters.values()) { fighter.menu = 'closed'; fighter.chillUntil = 0 }
}

export function step(previous: State, frame: Frame, pending: readonly Request[] = []): { state: State; commands: Command[] } {
  const state = copy(previous, frame.now)
  const commands: Command[] = []
  if (previous.phase.kind === 'live') {
    state.liveSeconds += Math.max(0, Math.min(frame.now, previous.phase.until) - previous.now)
    baselineIncome(state)
  }
  deaths(state, frame)
  sync(state, frame, commands)
  if (state.phase.kind === 'live' && state.now < state.phase.until) baselineIncome(state)
  if (state.phase.kind === 'live' && state.now >= state.phase.until) {
    if (state.score[2] === state.score[3]) state.phase = { kind: 'overtime' }
    else finish(state, state.score[2] > state.score[3] ? 2 : 3, 'Time limit')
  }
  if (state.phase.kind !== 'results' && state.phase.kind !== 'countdown') {
    resolvePulls(state, frame, commands)
    flights(state, frame, commands)
    landings(state, commands)
  }
  requests(state, frame, pending, commands)
  advance(state, frame, commands)
  for (const fighter of state.fighters.values()) {
    const ref = actor(fighter)
    if (ref && fighter.income.pending > 0) commands.push({ kind: 'income', actor: ref, round: state.round, amount: fighter.income.pending })
  }
  for (const fighter of state.fighters.values()) if (fighter.menu === 'loadout' && !canShop(state, fighter)) fighter.menu = 'closed'
  return { state, commands }
}

export function acknowledge(previous: State, failures: readonly Failure[]): State {
  const state = copy(previous, previous.now)
  requests(state, { now: state.now, players: [], deaths: [], globes: new Map(), pulls: new Map() }, failures, [])
  return state
}
