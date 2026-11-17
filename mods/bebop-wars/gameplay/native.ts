import {
  Buttons, Layers, Player, blockInput, clearMap, connection, damage as strike,
  findEntities, fireInput, freeCursor, handedOff, handoff, heroNamed, holdReload, holdModifierState, log,
  modifierState, players, precache, readDefinitionField, readField, readModifierField,
  setFreeForAll, setTeamSeating, trace, watchInput,
  type Ability, type AbilityCastEvent, type Connection, type DamageEvent, type DamageResult, type FrameEvent,
  type Pawn, type DamagedEvent,
} from 'modlock'
import { apply, arena as arenaSettings } from 'modlock/console'
import { activationStatus, type NativeActivation } from './activation.ts'
import { distance, type Vec3 } from './arena.ts'
import { advanceGlobe, burstContains, chilledMomentum, globeAim, globeRules, type Launch } from './globe.ts'
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint.ts'
import { hookContacts, hookDamageShare, type Landed } from './contact.ts'
import { drawHud, resetHud } from './hud.tsx'
import type { HudAction } from './hud-model.ts'
import { inputGate, type InputGate } from './input.ts'
import { catalog, hookAbility, productIds, shrinkSeconds, type HookRank, type ProductId } from './catalog.ts'
import { pianoMark } from './piano.ts'
import { inSights, knockdownRules } from './sight.ts'
import { NativeEffects, effectResources } from './native-effects.ts'
import { NativeProgress, exactWallet, hookRank } from './native-progress.ts'
import { equippedProducts, nativeItemButton, observeEquipment, reconcileEquipment } from './native-equipment.ts'
import {
  accountId, acknowledge, actor, canAct, configuration, deadlineOf, equip, hookBusy, initial, matches, playing, purchaseAccess, rules, settle, step,
  type AccountId, type GlobeSample, type Command, type Failure, type Fighter, type Frame,
  type HookSample, type Observation, type Request, type State, type Receipt,
} from './model.ts'
import { present } from './presentation.ts'

const bebop = heroNamed('bebop')
const movementKeys = Buttons.jump | Buttons.dash | Buttons.crouch
const nativeItemKeys = (1n << 37n) | (1n << 38n) | (1n << 39n) | (1n << 40n)
const actionKeys = Buttons.ability3 | nativeItemKeys
const cancelAbilityKey = 1n << 60n
const disabled = Buttons.attack | Buttons.altFire | Buttons.reload | Buttons.ability1 | Buttons.ability2 | Buttons.ultimate | nativeItemKeys
export const chillModifier = 'citadel_ability_mantle/mantle_hit_slow'
const knockdownMark = 'upgrade_target_stun/modifier_citadel_delayed_stun'
// The Salvage stun is a plain stun the game files under another ability.
const pianoStuns = ['upgrade_mystical_piano/modifier_mystical_piano_aura/modifier_stun', 'ability_wrecker_salvage/modifier_wrecker_salvage_stun']
const shrinkModifier = 'upgrade_shrink_ray/modifier_shrink_ray'
const confirmSeconds = 0.1
const sprintDonor = 'upgrade_fleetfoot_boots'
const terrainTrace = { layers: Layers.solid | Layers.staticLevel, exclude: Layers.hero | Layers.player | Layers.hitbox }
const zero = { x: 0, y: 0, z: 0 }
const profiles = [
  ['CCitadel_Modifier_HookTargetVData.m_flReturnPositionForwardOffset', 0],
  ['CCitadel_Modifier_HookTargetVData.m_flCloseEnoughDistance', 16],
  ['CCitadel_Modifier_HookTargetVData.m_flReturnSpeed', 2000 * 2 / 3],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flRampUpTime', 0],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flPercentageMultiplierStart', globeRules.slow * 100],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flPercentageMultiplierEnd', globeRules.slow * 100],
] as const

interface InputState { gate: InputGate; cursor: boolean; generation: number; blocked: bigint }
const castSeconds = 1.2
interface PendingCast { readonly product: ProductId; readonly ability: number; readonly failure: Failure; readonly player: Player; readonly button: bigint; readonly generation: number; readonly requestedAt: number; confirmed: boolean }
interface PendingSprint { readonly attempt: NativeActivation; readonly failure: Failure; readonly player: Player; readonly button: bigint }
type TraceIgnore = [number] | [number, number]

function identity(connection: Connection): AccountId {
  return accountId(connection.bot ? `bot:${connection.player.slot}:${connection.generation}` : `steam:${connection.steamId}`)
}

export class Game {
  state: State
  frame: Frame = { now: 0, players: [], deaths: [], globes: new Map(), pulls: new Map() }
  failure = ''
  private progress = new NativeProgress()
  private worldReady = false
  private profileChecked = false
  private readonly pending: Request[] = []
  private pianoStun = ''
  private readonly failures: Failure[] = []
  private readonly heldInput = new Map<AccountId, { generation: number; buttons: bigint }>()
  private readonly inputs = new Map<AccountId, InputState>()
  private readonly claims = new Map<number, Map<string, boolean>>()
  private readonly effects = new NativeEffects()
  private readonly snapshots = new Map<AccountId, { pawn: Pawn | undefined; abilities: readonly Ability[] }>()
  private readonly transferred = new Map<AccountId, { entity: number; cast: number; cancelled: boolean }>()
  private readonly casts = new Map<AccountId, { entity: number; serial: number; rank: HookRank; refunded: boolean }>()
  private readonly landed = new Map<AccountId, Landed>()
  private readonly struck = new Map<AccountId, number>()
  private readonly deaths: Frame["deaths"][number][] = []
  private readonly hits: DamagedEvent[] = []
  private readonly receipts: Receipt[] = []
  private readonly sprintPending = new Map<AccountId, PendingSprint>()
  private readonly castPending = new Map<AccountId, PendingCast>()
  private executed = new Set<number>()
  private readonly changed = new Set<AccountId>()
  private readonly hudDue = new Map<AccountId, number>()
  private lastLog = ''
  private nextShopCheck = 0
  private inherited = handedOff()
  private lastCheckpoint = ''
  private reloadHeld = false
  private rewardSetupFailed = false

  constructor(args: readonly string[]) { this.state = initial(configuration(args)) }

  start(): void {
    const rewards = {
      citadel_player_gold_reward_min: 0, citadel_player_gold_reward_max: 0,
      citadel_player_gold_reward_first_kill_bonus: 0, citadel_player_gold_comeback_multiplier: 0,
      citadel_bot_passive_gold_enabled: false,
      citadel_tick_gold_payout_for_lowest: 0, citadel_tick_gold_payout_for_second_lowest: 0,
      citadel_tick_gold_comeback_redirect_payout: 0, citadel_comeback_redirect_fraction: 0,
    }
    const refused = apply({
      ...arenaSettings, ...rewards, citadel_allow_duplicate_heroes: true,
      citadel_allow_purchasing_anywhere: false, citadel_player_override_spawn_time: rules.respawn,
      citadel_bot_override_spawn_time: rules.respawn,
      citadel_no_orbs_on_hero_kill: true, citadel_pickup_spawner_enabled: false,
    })
    if (refused.length) log(`[BebopWars] refused settings: ${refused.join(', ')}`)
    this.rewardSetupFailed = refused.some(name => name in rewards)
    precache({ heroes: ['hero_bebop', 'hero_kelvin'], resources: [...effectResources, 'particles/upgrades/upgrade_fleet_foot_boost_buff.vpcf'] })
    blockInput(disabled)
    watchInput(actionKeys)
    setFreeForAll(false)
    setTeamSeating(true)
  }

  world(map: string): void {
    let resumed: State | undefined
    this.progress = new NativeProgress()
    if (map === 'winter_arena' && this.inherited) {
      try {
        const saved: unknown = JSON.parse(this.inherited)
        if (typeof saved === 'object' && saved !== null && 'mode' in saved && typeof saved.mode === 'string' && 'native' in saved) {
          const mode = decodeCheckpoint(saved.mode, this.state.config)
          if (mode && this.progress.restore(saved.native)) resumed = mode
        }
      } catch { log('[BebopWars] invalid session checkpoint; starting a new match') }
    }
    this.inherited = undefined
    this.state = resumed ?? initial(this.state.config)
    if (!resumed) handoff('')
    this.lastCheckpoint = ''
    this.frame = { now: 0, players: [], deaths: [], globes: new Map(), pulls: new Map() }
    this.pending.length = 0
    this.failures.length = 0
    this.heldInput.clear()
    this.inputs.clear()
    this.claims.clear()
    this.effects.clear()
    this.snapshots.clear()
    this.transferred.clear()
    this.casts.clear()
    this.executed.clear()
    this.landed.clear()
    this.struck.clear()
    this.deaths.length = 0
    this.hits.length = 0
    this.receipts.length = 0
    for (const id of this.sprintPending.keys()) this.cancelSprint(id)
    for (const id of this.castPending.keys()) this.cancelCast(id)
    this.changed.clear()
    this.hudDue.clear()
    resetHud()
    this.nextShopCheck = 0
    this.failure = this.rewardSetupFailed ? 'Native Soul rewards could not be disabled. Match paused.' : ''
    this.profileChecked = false
    this.worldReady = map === 'winter_arena'
    if (!this.worldReady) this.failure = 'Load winter_arena to play Bebop Wars.'
    if (!resumed) clearMap()
    this.disableShops()
    log(`[BebopWars] world ${map}; teams=${this.state.config.teamSize}v${this.state.config.teamSize}; ${resumed ? 'resumed match progression' : 'new match'}; awaiting native definition application`)
  }

  private checkProfile(): void {
    this.profileChecked = true
    if (!Player.of(0).cancelPress(0n)) {
      this.failure = 'Sprint controls unavailable. Start with the bundled Bebop Wars runtime.'
      log('[BebopWars] FAIL native queued-input cancellation unavailable')
    }
    for (const [field, expected] of profiles) {
      const entry = field.startsWith('CCitadel_Modifier_RampSlowModifierVData.') ? chillModifier : `${hookAbility}/modifier_citadel_hooktarget`
      const actual = readDefinitionField({ file: 'fileModifiers', entry, field })
      if (actual === undefined || Math.abs(actual - expected) > 0.001) {
        this.failure = 'Hook rules unavailable. Start with the bundled Bebop Wars runtime.'
        log(`[BebopWars] FAIL native profile ${field}: expected ${expected}, read ${String(actual)}`)
      } else log(`[BebopWars] PASS native profile ${field}=${actual}`)
    }
    log(`[BebopWars] ${this.failure || 'native profile verified after world definitions applied'}`)
  }

  cast(event: AbilityCastEvent): void { this.executed.add(event.ability) }

  tick(event: FrameEvent): void {
    const executed = this.executed
    this.executed = new Set()
    if (!this.worldReady) return
    if (!this.profileChecked) this.checkProfile()
    this.frame = this.observe(event, executed)
    const contacts = hookContacts(this.frame.players, this.frame.pulls, this.casts, this.landed)
    if (!this.failure) {
      this.strikeHooks(contacts)
      this.releaseTransferredHooks()
      this.refundRebounds()
      this.settleSprints(executed)
      this.settleCasts(executed)
      const previous = this.state
      const transition = step(previous, this.frame, this.pending.splice(0))
      this.state = transition.state
      for (const command of transition.commands) this.execute(command)
      if (this.failures.length) this.state = acknowledge(this.state, this.failures.splice(0))
      if (this.receipts.length) this.state = settle(this.state, this.receipts.splice(0))
      for (const fighter of this.state.fighters.values()) {
        this.reconcile(fighter)
        const before = previous.fighters.get(fighter.id)
        const player = this.player(fighter.id)
        if (player && before) {
          if (fighter.kills > before.kills) player.addMetric('bebop.kills', fighter.kills - before.kills)
          if (fighter.saves > before.saves) player.addMetric('bebop.saves', fighter.saves - before.saves)
        }
      }
    } else {
      for (const connection of players()) {
        connection.player.blockInput(disabled | actionKeys)
        connection.player.centerText(this.failure)
      }
    }
    this.effects.update(this.state.globes, this.frame.now)
    const entities = new Set(this.frame.players.flatMap(p => p.body ? [p.body.entity] : []))
    for (const [entity, states] of this.claims) {
      if (entities.has(entity)) continue
      for (const [name, active] of states) if (active) holdModifierState(entity, name, false)
      this.claims.delete(entity)
    }
    if (this.frame.now >= this.nextShopCheck) { this.disableShops(); this.nextShopCheck = this.frame.now + 5 }
    this.render()
    this.checkpoint()
    const scoreLine = `${this.state.round}:${this.state.phase.kind}:${this.state.score[3]}:${this.state.score[2]}`
    if (scoreLine !== this.lastLog) {
      log(`[BebopWars] match ${JSON.stringify({ round: this.state.round, phase: this.state.phase.kind, sapphire: this.state.score[3], amber: this.state.score[2], time: this.state.now })}`)
      this.lastLog = scoreLine
    }
  }

  private checkpoint(): void {
    const native = this.progress.export()
    const busy = native === undefined || Array.from(this.state.fighters.values()).some(fighter => fighter.chillUntil > this.frame.now) || this.sprintPending.size > 0 || this.castPending.size > 0 || this.state.globes.length > 0 || this.frame.players.some(sample => sample.body?.hook && hookBusy(sample.body.hook)) || Array.from(this.state.fighters.values()).some(fighter => fighter.life.kind === 'alive' && fighter.life.transit.kind !== 'none')
    if (busy) {
      if (!this.reloadHeld && holdReload(true)) this.reloadHeld = true
      return
    }
    if (this.failure) return
    const checkpoint = JSON.stringify({ mode: encodeCheckpoint(this.state), native })
    if (checkpoint !== this.lastCheckpoint) {
      if (handoff(checkpoint)) this.lastCheckpoint = checkpoint
      else log('[BebopWars] ERROR match state handoff refused')
    }
    if (this.reloadHeld && this.lastCheckpoint === checkpoint && holdReload(false)) this.reloadHeld = false
  }

  player(id: AccountId): Player | undefined {
    const fighter = this.state.fighters.get(id)
    if (fighter?.presence.kind !== 'connected') return undefined
    const current = connection(fighter.presence.slot)
    return current?.generation === fighter.presence.generation ? current.player : undefined
  }

  request(id: AccountId, action: HudAction): void {
    const fighter = this.state.fighters.get(id)
    const ref = fighter && actor(fighter)
    if (ref) this.pending.push({ kind: 'hud', actor: ref, action })
  }

  diagnostic(id: AccountId): object {
    const fighter = this.state.fighters.get(id), input = this.inputs.get(id)
    const ability = this.snapshots.get(id)?.abilities.find(a => a.name === hookAbility)
    const internal = ability ? {
      cooling: readField(ability.entity, 'CCitadelBaseAbility', 'm_bIsCoolingDownInternal', 'bool'),
      delay: readField(ability.entity, 'CCitadelBaseAbility', 'm_bInCastDelay', 'bool'),
      channel: readField(ability.entity, 'CCitadelBaseAbility', 'm_bChanneling', 'bool'),
      queued: readField(ability.entity, 'CCitadelBaseAbility', 'm_bShouldBeExecuted', 'bool'),
      cancelLockout: readField(ability.entity, 'CCitadelBaseAbility', 'm_flCancelLockoutEndTime', 'float32'),
      mashLockout: readField(ability.entity, 'CCitadelBaseAbility', 'm_flCancelMashProtectionEndTime', 'float32'),
    } : undefined
    return { armed: input?.gate.armed, blocked: String(input?.blocked), hookBlocked: input ? (input.blocked & Buttons.ability3) !== 0n : true, rawHeld: String(this.heldInput.get(id)?.buttons), active: fighter ? canAct(this.state, fighter) : false, menu: fighter?.menu, phase: this.state.phase.kind, ability, internal }
  }

  input(player: Player, pressed: bigint, released: bigint): void {
    const current = player.connection()
    if (!current || this.failure) return
    const id = identity(current), previous = this.heldInput.get(id)
    const held = previous?.generation === current.generation ? previous.buttons : 0n
    this.heldInput.set(id, { generation: current.generation, buttons: (held | pressed) & ~released })
    const fighter = Array.from(this.state.fighters.values()).find(p => p.presence.kind === 'connected' && p.presence.slot === player.slot)
    const ref = fighter && actor(fighter)
    if (!fighter || !ref) return
    if (ref.generation !== current.generation) return
    if (!this.progress.ready(fighter.id) || !this.inputs.get(fighter.id)?.gate.armed) return
    for (const ability of player.abilities()) {
      const button = nativeItemButton(ability.slot)
      if (button === undefined || (pressed & button) === 0n) continue
      const product = productIds.find(id => catalog[id].nativeItem === ability.name)
      if (!product || fighter.progression[catalog[product].group] !== product) continue
      this.pending.push({ kind: 'tool', tool: catalog[product].group, actor: ref, menuAtPress: fighter.menu, launch: product === 'snowGlobe' ? this.launch(player) : undefined, mark: product === 'piano' ? this.mark(player) : undefined, sighted: product === 'knockdown' ? this.sighted(player, fighter) : undefined })
    }
  }

  damage(hit: DamageEvent): DamageResult {
    const target = this.frame.players.find(p => p.body?.entity === hit.victim)
    const source = this.frame.players.find(p => p.body?.entity === hit.attacker)
    const victim = target && this.state.fighters.get(target.id)
    const attacker = source && this.state.fighters.get(source.id)
    if (this.failure || !(playing(this.state) || this.state.phase.kind === 'warmup') ||
      attacker?.life.kind !== 'alive' || victim?.life.kind !== 'alive' ||
      !this.progress.ready(attacker.id) || !this.progress.ready(victim.id) ||
      attacker.life.protectionUntil > this.state.now || victim.life.protectionUntil > this.state.now) return { block: true }
    const ability = this.snapshots.get(attacker.id)?.abilities.find(ability => ability.entity === hit.ability)
    if (ability?.name === hookAbility) {
      // The game lands Hook's own hit late in the pull, after strikeHooks has dealt it at the latch.
      const serial = this.casts.get(attacker.id)?.serial
      if (source?.body?.side === target?.body?.side || (serial !== undefined && this.struck.get(attacker.id) === serial)) return { amount: 0 }
      if (serial !== undefined) this.struck.set(attacker.id, serial)
      return { amount: Math.round((target?.body?.maxHealth ?? 0) * hookDamageShare) }
    }
    if (ability?.name === 'citadel_ability_melee_bebop' && source?.body?.side !== target?.body?.side) return {}
    return { block: true }
  }

  damaged(hit: DamagedEvent): void {
    this.hits.push(hit)
    if (hit.healthBefore <= 0 || hit.healthLost < hit.healthBefore) return
    const victim = Array.from(this.state.fighters.values()).find(fighter => fighter.life.kind === 'alive' && fighter.life.entity === hit.victim)
    const attacker = Array.from(this.state.fighters.values()).find(fighter => fighter.life.kind === 'alive' && fighter.life.entity === hit.attacker)
    const ref = victim && actor(victim)
    if (ref) this.deaths.push({ victim: ref, attacker: attacker ? actor(attacker) ?? null : null })
  }

  private fights(fighter: Fighter | undefined): boolean {
    return fighter?.life.kind === 'alive' && this.progress.ready(fighter.id) && fighter.life.protectionUntil <= this.state.now
  }

  private strikeHooks(contacts: ReturnType<typeof hookContacts>): void {
    if (!(playing(this.state) || this.state.phase.kind === 'warmup')) return
    for (const contact of contacts) {
      if (!this.fights(this.state.fighters.get(contact.caster)) || !this.fights(this.state.fighters.get(contact.victim))) continue
      const serial = this.casts.get(contact.caster)?.serial
      if (serial === undefined || this.struck.get(contact.caster) === serial) continue
      if (!strike({ victim: contact.target, attacker: contact.attacker, ability: contact.ability, amount: contact.amount })) {
        log('[BebopWars] ERROR Hook contact damage was refused; the pull will deal it')
        continue
      }
      this.struck.set(contact.caster, serial)
      // The game reports only its own hits, so read what this one removed.
      const pawn = this.player(contact.victim)?.pawn()
      const left = pawn?.entity === contact.target ? Math.max(0, pawn.health) : 0
      this.damaged({ victim: contact.target, attacker: contact.attacker, ability: contact.ability, healthBefore: contact.healthBefore, healthLost: contact.healthBefore - left, dealt: contact.amount })
      this.changed.add(contact.victim)
    }
  }

  private refundRebounds(): void {
    for (const hit of this.hits.splice(0)) {
      if (hit.healthLost <= 0) continue
      const source = this.frame.players.find(sample => sample.body?.hook?.entity === hit.ability)
      const target = this.frame.players.find(sample => sample.body?.entity === hit.victim)
      if (!source?.body || !target?.body || source.body.side === target.body.side) continue
      const cast = this.casts.get(source.id), player = this.player(source.id)
      if (!cast || cast.entity !== hit.ability || cast.rank !== 3 || cast.refunded || !player) continue
      const hook = player.abilities().find(ability => ability.entity === hit.ability)
      if (hook && player.setAbility({ ability: hookAbility, cooldownEnd: Math.max(this.frame.now, hook.cooldownEnd - 1) })) { cast.refunded = true; this.changed.add(source.id) }
    }
  }

  private observe(event: FrameEvent, executed: ReadonlySet<number>): Frame {
    const connections = players().filter(c => c.ready)
    const bodies = new Map(connections.map(c => [identity(c), c.player.pawn()]))
    for (const id of this.state.fighters.keys()) if (!bodies.has(id)) this.progress.disconnected(id)
    this.snapshots.clear()
    const owners = new Map<number, AccountId>()
    for (const [id, pawn] of bodies) if (pawn && pawn.hero !== 0) owners.set(pawn.entity, id)
    const pulls = new Map<AccountId, { kind: 'held'; owner: AccountId } | { kind: 'ambiguous' }>()
    for (const [id, pawn] of bodies) {
      if (!pawn || pawn.health <= 0 || pawn.hero === 0) continue
      const caster = readModifierField(pawn.entity, `${hookAbility}/modifier_citadel_hooktarget`, 'CBaseModifier', 'm_hCaster', 'handle')
      const owner = typeof caster === 'number' ? owners.get(caster) : undefined
      if (owner) pulls.set(id, { kind: 'held', owner })
    }
    const observed: Observation[] = connections.map(connection => {
      const id = identity(connection), pawn = bodies.get(id)
      const abilities = pawn && pawn.hero !== 0 ? connection.player.abilities() : []
      this.snapshots.set(id, { pawn, abilities })
      let body: Observation['body']
      if (pawn && pawn.hero !== 0 && (pawn.team === 2 || pawn.team === 3)) {
        const ability = abilities.find(value => value.name === hookAbility)
        if (ability) {
          const held = readField(ability.entity, 'CCitadel_Ability_Hook', 'm_hHookVictim', 'handle')
          const victim = typeof held === 'number' ? owners.get(held) : undefined
          const active = victim && pulls.get(victim)
          const transfer = this.transferred.get(id)
          const thrown = executed.has(ability.entity)
          const previous = this.casts.get(id)
          const rank = hookRank(ability.upgrades) ?? 0
          if (thrown || previous?.entity !== ability.entity) this.casts.set(id, { entity: ability.entity, serial: (previous?.serial ?? 0) + 1, rank, refunded: false })
          const cast = this.casts.get(id)?.serial ?? 0
          const sameCast = transfer?.entity === ability.entity && transfer.cast === cast
          if (transfer && !sameCast) this.transferred.delete(id)
          if (!sameCast && active && active.kind === 'held' && active.owner !== id) this.transferred.set(id, { entity: ability.entity, cast, cancelled: false })
          const hook: HookSample = {
            entity: ability.entity, casting: modifierState(pawn.entity, 'MODIFIER_STATE_CASTING_HOOK'),
            victim,
            startedAt: ability.cooldownStart, cooldownEnd: ability.cooldownEnd,
            executed: thrown,
          }
          const sprintActive = pawn.health > 0 && typeof readModifierField(pawn.entity, `${sprintDonor}/modifier_fleetfoot_boots`, 'CBaseModifier', 'm_hAbility', 'handle') === 'number'
          body = { nativeItems: observeEquipment(abilities), health: pawn.health, maxHealth: pawn.effectiveMaxHealth ?? pawn.maxHealth, souls: pawn.souls, abilityPoints: pawn.abilityPoints, hookRank: rank, entity: pawn.entity, side: pawn.team, alive: pawn.health > 0, position: pawn.position, velocity: pawn.velocity, hook, sprintActive }
        }
      }
      return { id, slot: connection.player.slot, generation: connection.generation, name: connection.name, bot: connection.bot, body }
    })
    const claimed = new Map<AccountId, number>()
    for (const sample of observed) {
      const hook = sample.body?.hook
      if (hook?.victim && !this.transferred.has(sample.id)) claimed.set(hook.victim, (claimed.get(hook.victim) ?? 0) + 1)
    }
    for (const [victim, count] of claimed) if (count > 1 && !pulls.has(victim)) pulls.set(victim, { kind: 'ambiguous' })
    const globes = new Map<number, GlobeSample>()
    for (const globe of this.state.globes) {
      const source = bodies.get(globe.actor.id)
      const flight = advanceGlobe(globe, event.timeSeconds, (start, end) => trace({ start, end, ...terrainTrace, ...(source ? { ignore: [source.entity] } : {}) }))
      const clear = observed.filter(p => {
        if (!p.body?.alive || p.body.side === globe.side || !burstContains(flight.position, p.body.position)) return false
        const end = { ...p.body.position, z: p.body.position.z + 40 }
        const ignore: TraceIgnore = source ? [source.entity, p.body.entity] : [p.body.entity]
        const hit = trace({ start: flight.position, end, ...terrainTrace, ignore })
        return hit === undefined || (!hit.startSolid && distance(hit.position, end) < 4)
      }).map(p => p.id)
      globes.set(globe.id, { ...flight, clear })
    }
    return { now: event.timeSeconds, players: observed, deaths: this.deaths.splice(0), globes, pulls }
  }

  private releaseTransferredHooks(): void {
    for (const sample of this.frame.players) {
      const transfer = this.transferred.get(sample.id), hook = sample.body?.hook
      // Cancelling the old caster before the shared victim modifier ends also cancels the rescue.
      if (!transfer || transfer.cancelled || !hook?.victim || this.frame.pulls.has(hook.victim)) continue
      if (transfer.entity !== hook.entity || transfer.cast !== this.casts.get(sample.id)?.serial) continue
      if (this.player(sample.id)?.press(cancelAbilityKey)) transfer.cancelled = true
    }
  }

  private settleSprints(executed: ReadonlySet<number>): void {
    for (const [id, pending] of this.sprintPending) {
      const fighter = this.state.fighters.get(id), observed = this.frame.players.find(p => p.id === id), body = observed?.body
      const current = fighter && actor(fighter)
      const status = activationStatus(pending.attempt, { actor: current?.generation === observed?.generation ? current : undefined, entity: body?.entity, alive: body?.alive ?? false, executed }, this.frame.now)
      if (status === 'pending') continue
      this.cancelSprint(id)
      if (status === 'timedOut') {
        pending.player.setAbility({ ability: sprintDonor, cooldownEnd: pending.failure.previousDeadline })
        this.failures.push(pending.failure)
      }
    }
  }

  private settleCasts(executed: ReadonlySet<number>): void {
    for (const [id, pending] of this.castPending) {
      const fighter = this.state.fighters.get(id)
      const live = fighter !== undefined && matches(fighter, pending.failure.actor) && fighter.life.kind === 'alive'
      const item = catalog[pending.product]
      const started = live && executed.has(pending.ability)
      if (live && !started && this.frame.now - pending.requestedAt < castSeconds) {
        if (item.aimed && !pending.confirmed && this.frame.now - pending.requestedAt >= confirmSeconds) pending.confirmed = pending.player.press(Buttons.attack)
        continue
      }
      this.cancelCast(id)
      if (!fighter || !live) continue
      if (started) pending.player.setAbility({ ability: item.nativeItem, cooldownEnd: deadlineOf(fighter, item.group) })
      else {
        // An aimed item that found no hero stays selected, and its key is what puts it away again.
        if (item.aimed) pending.player.press(pending.button)
        pending.player.setAbility({ ability: item.nativeItem, cooldownEnd: pending.failure.previousDeadline })
        this.failures.push(pending.failure)
      }
      this.changed.add(id)
    }
  }

  private cancelCast(id: AccountId): void {
    const pending = this.castPending.get(id)
    if (!pending) return
    if (pending.player.connection()?.generation === pending.generation) pending.player.cancelPress(pending.button | Buttons.attack)
    this.castPending.delete(id)
  }

  private cancelSprint(id: AccountId): void {
    const pending = this.sprintPending.get(id)
    if (!pending) return
    if (pending.player.connection()?.generation === pending.attempt.actor.generation) pending.player.cancelPress(pending.button)
    this.sprintPending.delete(id)
  }

  private launch(player: Player): Launch | undefined {
    const pawn = player.pawn()
    if (!pawn) return undefined
    return globeAim(pawn.eyePosition, pawn.cameraPosition ?? pawn.eyePosition, pawn.cameraAngles, (start, end) =>
      trace({ start, end, layers: terrainTrace.layers | Layers.hero | Layers.player | Layers.hitbox, ignore: [pawn.entity] }))
  }

  private sighted(player: Player, fighter: Fighter): AccountId | undefined {
    const pawn = player.pawn()
    if (!pawn || fighter.membership.kind !== 'seated') return undefined
    const side = fighter.membership.side
    const enemies = this.frame.players.flatMap(sample => sample.body && sample.body.alive && sample.body.side !== side ? [{ id: sample.id, position: sample.body.position }] : [])
    return inSights(pawn.cameraPosition ?? pawn.eyePosition, pawn.cameraAngles, enemies, knockdownRules.range, knockdownRules.cone,
      (start, end) => trace({ start, end, ...terrainTrace, ignore: [pawn.entity] }) === undefined)
  }

  private mark(player: Player): Vec3 | undefined {
    const pawn = player.pawn()
    if (!pawn) return undefined
    return pianoMark(pawn.cameraPosition ?? pawn.eyePosition, pawn.cameraAngles, (start, end) => trace({ start, end, ...terrainTrace, ignore: [pawn.entity] }))
  }

  private execute(command: Command): void {
    if (command.kind === 'piano') {
      const { piano } = command
      this.effects.pianoCast(piano)
      const player = this.player(piano.actor.id), fighter = this.state.fighters.get(piano.actor.id)
      player?.sound('Mods.Mystical.Piano.Cast')
      if (fighter) player?.setAbility({ ability: catalog.piano.nativeItem, cooldownEnd: fighter.setupUntil })
      this.changed.add(piano.actor.id)
      return
    }
    if (command.kind === 'pianoLand') {
      this.effects.pianoLanded(command.id, command.mark, this.state.now)
      return
    }
    if (command.kind === 'snowGlobe') {
      if (this.effects.globeLaunched(command.snowGlobe, this.state.now)) {
        const player = this.player(command.snowGlobe.actor.id)
        player?.sound('Kelvin.IceGrenade.Cast')
        const fighter = this.state.fighters.get(command.snowGlobe.actor.id)
        if (fighter) player?.setAbility({ ability: catalog.snowGlobe.nativeItem, cooldownEnd: fighter.setupUntil })
      } else {
        const fighter = this.state.fighters.get(command.snowGlobe.actor.id)
        if (matches(fighter, command.snowGlobe.actor)) {
          fighter.setupUntil = this.state.now
          fighter.notice = { text: 'Snow Globe unavailable; cooldown restored', until: this.state.now + 3 }
        }
        this.state.globes = this.state.globes.filter(globe => globe.id !== command.snowGlobe.id)
      }
      return
    }
    if (command.kind === 'impact') {
      this.effects.globeBurst(command.id, command.position, this.state.now)
      return
    }
    const fighter = this.state.fighters.get(command.actor.id)
    if (command.kind === 'reset') {
      if (fighter?.presence.kind === 'connected' && fighter.presence.generation === command.actor.generation && command.round === this.state.round) this.progress.reset(fighter.id, command.round)
      return
    }
    if (!matches(fighter, command.actor)) return
    const player = this.player(fighter.id)
    if (!player) return
    if (command.kind === 'buy' || command.kind === 'deploy' || command.kind === 'respawn' || command.kind === 'seat' || command.kind === 'sprint' || command.kind === 'echo' || command.kind === 'cast' || command.kind === 'shrink' || command.kind === 'knockdown') this.changed.add(fighter.id)
    switch (command.kind) {
      case 'income': {
        if (command.round !== this.state.round || command.amount !== fighter.income.pending) break
        const credited = this.progress.credit(player, fighter, this.state, command.amount)
        if (credited === 'deferred') break
        if (credited === 'failed') {
          this.failure = 'Soul reward could not be applied. Match paused.'
          break
        }
        fighter.income.pending = 0
        this.changed.add(fighter.id)
        break
      }
      case 'buy': {
        let result: Receipt['result'] = 'unavailable'
        const price = catalog[command.product].price
        const pawn = player.pawn()
        if (this.progress.ready(fighter.id) && command.round === this.state.round && purchaseAccess(this.state, fighter, this.frame).allowed && pawn) {
          if (pawn.souls < price) result = 'unaffordable'
          else if (player.adjustSouls(-price, true)) {
            this.cancelSprint(fighter.id)
            this.cancelCast(fighter.id)
            const next = { ...fighter.progression, owned: [...fighter.progression.owned, command.product] }
            equip(next, command.product)
            if (reconcileEquipment(player, equippedProducts(next), { ...fighter, now: this.state.now })) result = 'bought'
            else {
              const restored = reconcileEquipment(player, equippedProducts(fighter.progression), { ...fighter, now: this.state.now })
              if (!exactWallet(player, pawn.souls) || !restored) this.failure = 'A purchase could not be restored. Match paused.'
            }
          }
        }
        this.receipts.push({ kind: 'purchase', actor: command.actor, round: command.round, id: command.id, result })
        break
      }
      case 'seat':
        this.cancelSprint(fighter.id)
        if (player.pawn()?.hero === bebop?.id) player.changeTeam(command.side)
        else player.selectHero('hero_bebop', command.side)
        break
      case 'spectate': this.cancelSprint(fighter.id); player.spectate(); break
      case 'deploy':
        this.cancelSprint(fighter.id)
        player.teleport(command.position, { pitch: 0, yaw: command.side === 3 ? 270 : 90, roll: 0 }, zero)
        player.restoreStamina()
        break
      case 'respawn': player.respawn(); break
      case 'move': {
        const pawn = player.pawn()
        if (pawn) player.move(command.position, pawn.eyeAngles, command.velocity)
        break
      }
      case 'chill': {
        const pawn = player.pawn()
        if (!pawn || pawn.health <= 0 || fighter.life.kind !== 'alive') break
        if (!player.giveModifier(chillModifier, globeRules.chill)) {
          fighter.chillUntil = 0
          log('[BebopWars] ERROR Snow Globe chill was refused')
          break
        }
        this.effects.chill(command.id, pawn, fighter.chillUntil)
        if (!this.frame.pulls.has(fighter.id) && fighter.life.transit.kind === 'none') player.setVelocity(chilledMomentum(pawn.velocity))
        break
      }
      case 'stun': {
        const pawn = player.pawn()
        if (!pawn || pawn.health <= 0 || fighter.life.kind !== 'alive') break
        const given = pianoStuns.find(name => player.giveModifier(name, command.seconds))
        if (given === undefined) log('[BebopWars] ERROR stun was refused')
        else if (given !== this.pianoStun) { this.pianoStun = given; log(`[BebopWars] stuns with ${given}`) }
        break
      }
      case 'knockdown': {
        player.setAbility({ ability: catalog.knockdown.nativeItem, cooldownEnd: fighter.setupUntil })
        player.sound('Mods.Tech.Knockdown.Cast')
        const victim = this.state.fighters.get(command.victim.id)
        const marked = matches(victim, command.victim) ? this.player(victim.id) : undefined
        if (marked && !marked.giveModifier(knockdownMark, knockdownRules.delay)) log('[BebopWars] ERROR Knockdown mark was refused')
        break
      }
      case 'shrink': {
        if (fighter.life.kind === 'alive' && player.giveModifier(shrinkModifier, shrinkSeconds)) {
          player.setAbility({ ability: catalog.shrinkRay.nativeItem, cooldownEnd: fighter.utilityUntil })
          player.sound('Mods.Shrink.Ray.Cast')
        } else {
          player.setAbility({ ability: catalog.shrinkRay.nativeItem, cooldownEnd: command.previousDeadline })
          this.failures.push({ kind: 'failed', tool: 'shrinkRay', actor: command.actor, previousDeadline: command.previousDeadline, attemptedAt: command.attemptedAt })
        }
        break
      }
      case 'sprint': {
        const donor = this.snapshots.get(fighter.id)?.abilities.find(ability => ability.name === sprintDonor)
        const failure: Failure = { kind: 'failed', tool: 'sprint', actor: command.actor, previousDeadline: command.previousDeadline, attemptedAt: command.attemptedAt }
        const button = donor && nativeItemButton(donor.slot)
        if (!donor || button === undefined || fighter.life.kind !== 'alive' || !player.refreshAbility(sprintDonor) || !player.press(button)) {
          player.setAbility({ ability: sprintDonor, cooldownEnd: command.previousDeadline })
          this.failures.push(failure)
        } else this.sprintPending.set(fighter.id, { player, button, failure, attempt: { actor: command.actor, entity: fighter.life.entity, ability: donor.entity, requestedAt: this.state.now } })
        break
      }
      case 'cast': {
        const item = catalog[command.product]
        const donor = this.snapshots.get(fighter.id)?.abilities.find(ability => ability.name === item.nativeItem)
        const failure: Failure = { kind: 'failed', tool: command.product, actor: command.actor, previousDeadline: command.previousDeadline, attemptedAt: command.attemptedAt }
        const button = donor && nativeItemButton(donor.slot)
        if (!donor || button === undefined || fighter.life.kind !== 'alive' || fighter.presence.kind !== 'connected' || !player.refreshAbility(item.nativeItem) || !player.press(button)) {
          player.setAbility({ ability: item.nativeItem, cooldownEnd: command.previousDeadline })
          this.failures.push(failure)
        } else this.castPending.set(fighter.id, { product: command.product, ability: donor.entity, player, button, failure, generation: fighter.presence.generation, requestedAt: this.state.now, confirmed: false })
        break
      }
      case 'echo': {
        const item = catalog.echo.nativeItem
        const successful = this.idle(fighter.id) && player.setAbility({ ability: item, cooldownEnd: fighter.utilityUntil }) && player.refreshAbility(hookAbility)
        if (!successful) {
          player.setAbility({ ability: item, cooldownEnd: command.previousDeadline })
          this.failures.push({ kind: 'failed', tool: command.kind, actor: command.actor, previousDeadline: command.previousDeadline, attemptedAt: command.attemptedAt })
        }
        break
      }
      case 'saved':
        if (fighter.life.kind === 'alive' && fighter.membership.kind === 'seated') this.effects.rescue(command.id, fighter.life.position, fighter.membership.side, this.state.now)
        break
    }
  }

  private idle(id: AccountId): boolean {
    const hook = this.frame.players.find(p => p.id === id)?.body?.hook
    return hook !== undefined && !hookBusy(hook)
  }

  private reconcile(fighter: Fighter): void {
    const player = this.player(fighter.id)
    if (!player || fighter.presence.kind !== 'connected') return
    if (this.changed.delete(fighter.id)) this.snapshots.set(fighter.id, { pawn: player.pawn(), abilities: player.abilities() })
    const snapshot = this.snapshots.get(fighter.id)
    const pawn = snapshot?.pawn
    let nativeReady = this.progress.reconcile(player, fighter, this.state, pawn, snapshot?.abilities ?? [])
    if (this.sprintPending.has(fighter.id) && fighter.progression.utility !== 'sprint') this.cancelSprint(fighter.id)
    const casting = this.castPending.get(fighter.id)
    if (casting && fighter.progression[catalog[casting.product].group] !== casting.product) this.cancelCast(fighter.id)
    if (nativeReady && pawn && !this.sprintPending.has(fighter.id) && !this.castPending.has(fighter.id) && !reconcileEquipment(player, equippedProducts(fighter.progression), { ...fighter, now: this.state.now }, snapshot?.abilities)) nativeReady = false
    const alive = fighter.life.kind === 'alive'
    const context = `${fighter.presence.generation}:${fighter.serial}:${fighter.life.kind}:${fighter.menu}:${this.state.phase.kind}:${canAct(this.state, fighter)}:${nativeReady}`
    const previous = this.inputs.get(fighter.id)
    const realInput = this.heldInput.get(fighter.id)
    const gate = inputGate(previous?.gate, context, realInput?.generation === fighter.presence.generation ? realInput.buttons : 0n, actionKeys)
    const cursor = fighter.menu === 'loadout'
    if (previous?.cursor !== cursor || previous.generation !== fighter.presence.generation) freeCursor(player, cursor)
    const locked = !nativeReady || this.state.phase.kind === 'countdown' || this.state.phase.kind === 'results' || fighter.membership.kind === 'watching'
    const blocked = disabled | ((!nativeReady || !canAct(this.state, fighter) || !gate.armed) ? actionKeys | Buttons.melee | Buttons.parry : 0n) | ((cursor || locked || !alive) ? movementKeys : 0n)
    if (previous?.blocked !== blocked || previous.generation !== fighter.presence.generation) player.blockInput(blocked)
    this.inputs.set(fighter.id, { gate, cursor, generation: fighter.presence.generation, blocked })
    if (!pawn) return
    const protectedLife = fighter.life.kind === 'alive' && fighter.life.protectionUntil > this.state.now
    const held = {
      MODIFIER_STATE_IMMOBILIZED: pawn.health > 0 && (!alive || cursor || locked),
      MODIFIER_STATE_INVULNERABLE: protectedLife || locked,
      MODIFIER_STATE_TECH_UNTARGETABLE_BY_ENEMIES: protectedLife || locked,
      MODIFIER_STATE_TECH_UNTARGETABLE_BY_TEAMMATES: protectedLife || locked,
      MODIFIER_STATE_DISPLACEMENT_IMMUNE: protectedLife || locked,
    }
    const heldBefore = this.claims.get(pawn.entity) ?? new Map<string, boolean>()
    for (const [name, active] of Object.entries(held)) {
      if (heldBefore.get(name) !== active && holdModifierState(pawn.entity, name, active)) heldBefore.set(name, active)
    }
    this.claims.set(pawn.entity, heldBefore)
  }

  private render(): void {
    const people = this.frame.players.filter(p => !p.bot).map(p => p.id)
    const due = Array.from(this.state.fighters.values()).filter(fighter => people.includes(fighter.id) && (this.hudDue.get(fighter.id) ?? 0) <= this.state.now).sort((a, b) => (this.hudDue.get(a.id) ?? 0) - (this.hudDue.get(b.id) ?? 0))
    for (const fighter of due) {
      const player = this.player(fighter.id)
      if (!player) continue
      const ref = actor(fighter)
      if (!ref) continue
      drawHud(player, present(this.state, fighter, this.frame), action => this.pending.push({ kind: 'hud', actor: ref, action }))
      this.hudDue.set(fighter.id, this.state.now + 0.1)
      break
    }
  }

  private disableShops(): void {
    for (const entity of findEntities('trigger_item_shop')) fireInput(entity, 'Disable')
  }
}
