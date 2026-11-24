import {
  Buttons,
  Layers,
  Strays,
  blockInput,
  createParticle,
  entityClass,
  findEntities,
  freeCursor,
  heroNamed,
  holdModifierState,
  killEntity,
  log,
  precache,
  pushEntity,
  readField,
  trace,
  vector,
  watchInput,
  writeField,
  type Angles,
  type Connection,
  type Pawn,
  type MovementSample,
  type Player,
  type WorldObject,
} from 'modlock'
import { apply, arena } from 'modlock/console'
import { ballEffect, blockEffect, hero, rules } from './config'
import { Block } from './block'
import { blinkDestination, movementHeading } from './blink'
import {
  Special,
  isSpecialId,
  specialCarrier,
  specials,
  type SpecialId,
} from './special'
import type { Vec3 } from './geometry'
import { cleanHud, drawHud, notice } from './hud'
import { Scores, type Contender } from './score'
import {
  Round,
  type Body,
  type Participant,
  type PlayerId,
  type RoundEvent,
} from './round'

type SpectatorCamera =
  | { kind: 'pending' }
  | { kind: 'attached'; hero: number; camera: number; target: number }

type SeatState =
  | { kind: 'spawning'; position: Vec3; facing: Angles; retryAt: number }
  | { kind: 'settling'; entity: number; until: number }
  | { kind: 'playing'; entity: number }
  | { kind: 'eliminated'; spectateAt: number }
  | { kind: 'spectating'; retryAt: number; camera: SpectatorCamera }

interface Seat {
  connection: Connection
  state: SeatState
  block: Block
  special: Special
  pendingSpecial: boolean
  movement: MovementSample | undefined
  penalty: { entity: number; until: number } | undefined
  charge: { object: WorldObject; entity: number } | undefined
}
const yamatoId = heroNamed(hero)?.id
const blockButtons = Buttons.parry | Buttons.attack
const specialButton = Buttons.ability3
const blinkEffect = 'particles/upgrades/warp_stone_travel_beam.vpcf'
const chargeEffect =
  'particles/abilities/yamato/yamato_power_slash_charge_body_glow.vpcf'
const terrain = Layers.solid | Layers.staticLevel | Layers.playerClip
const blocked =
  Buttons.attack |
  Buttons.altFire |
  Buttons.reload |
  Buttons.melee |
  Buttons.ability1 |
  Buttons.ability2 |
  Buttons.ability3 |
  Buttons.ultimate |
  Buttons.parry

export function playerId(connection: Connection): PlayerId {
  return `${connection.player.slot}:${connection.generation}`
}

function scoreKey(connection: Connection): string {
  return connection.bot || connection.steamId === 0n
    ? playerId(connection)
    : `steam:${connection.steamId}`
}

function nativeObserver(pawn: Pawn): number | undefined {
  for (const controller of findEntities('citadel_player_controller')) {
    if (
      readField(
        controller,
        'CCitadelPlayerController',
        'm_hHeroPawn',
        'handle',
      ) !== pawn.entity
    )
      continue
    const camera = readField(
      controller,
      'CBasePlayerController',
      'm_hPawn',
      'handle',
    )
    if (
      typeof camera === 'number' &&
      camera !== 0xffffffff &&
      camera !== pawn.entity &&
      entityClass(camera)?.className === 'CCitadelObserverPawn'
    )
      return camera
  }
  return undefined
}

function freshSeat(connection: Connection): Seat {
  const special = new Special()
  if (connection.bot) special.choose('powerSlash')
  return {
    connection,
    state: { kind: 'spectating', retryAt: 0, camera: { kind: 'pending' } },
    block: new Block(),
    special,
    pendingSpecial: false,
    movement: undefined,
    penalty: undefined,
    charge: undefined,
  }
}

function selectOrRespawn(seat: Seat, pawn: Pawn | undefined): void {
  const player = seat.connection.player
  if (!pawn || pawn.hero !== yamatoId) {
    if (!seat.connection.bot) player.selectHero(hero, 2)
  } else if (pawn.health <= 0) player.respawn()
}

function disableRespawn(pawn: Pawn): void {
  if (
    !writeField(
      pawn.entity,
      'CCitadelPlayerPawn',
      'm_flRespawnTime',
      'float32',
      0,
    )
  )
    throw new Error('Could not disable native respawn for an eliminated player')
}

export class Game {
  round = new Round()
  readonly scores = new Scores()
  readonly seats = new Map<PlayerId, Seat>()
  private readonly choices = new Map<bigint, SpecialId>()
  private ball: WorldObject | undefined
  private strays = new Strays()
  private flashes: { object: WorldObject; until: number }[] = []
  private nextUi = 0
  private resumeCueUntil = 0
  private winnerName = ''
  private time = 0

  start(): void {
    if (yamatoId === undefined)
      throw new Error('The pinned runtime does not identify Yamato')
    const refused = apply({
      ...arena,
      sv_cheats: true,
      citadel_allow_duplicate_heroes: true,
      mp_forcerespawn: false,
      citadel_allow_purchasing_anywhere: false,
    })
    if (refused.length)
      throw new Error(`Required arena settings refused: ${refused.join(', ')}`)
    if (!blockInput(blocked))
      throw new Error('Could not block native combat inputs')
    watchInput(blockButtons | specialButton)
    precache({
      heroes: [hero, 'hero_unicorn'],
      resources: [ballEffect, blockEffect, blinkEffect, chargeEffect],
    })
    log(
      'Rooftop Rally loaded: custom block, one life per round, two players minimum.',
    )
  }

  world(): void {
    this.round = new Round()
    this.ball = undefined
    this.strays = new Strays()
    this.flashes = []
    this.time = 0
    this.nextUi = 0
    this.resumeCueUntil = 0
    this.winnerName = ''
    this.choices.clear()
    this.scores.reset()
    for (const seat of this.seats.values()) {
      Object.assign(seat, freshSeat(seat.connection))
      if (!seat.connection.bot) freeCursor(seat.connection.player, true)
    }
  }

  join(connection: Connection): void {
    const seat = freshSeat(connection)
    this.seats.set(playerId(connection), seat)
    if (!connection.bot) {
      const saved = this.choices.get(connection.steamId)
      if (saved) seat.special.choose(saved)
      cleanHud(connection.player)
      freeCursor(connection.player, !seat.special.choice)
    }
    connection.player.watchMovement(true)
    if (this.round.lobby)
      this.spawn(seat, this.seats.size - 1, Math.max(8, this.seats.size))
  }

  leave(connection: Connection): void {
    const seat = this.seats.get(playerId(connection))
    if (seat) {
      this.clearPenalty(seat)
      this.cancelSpecial(seat)
    }
    this.seats.delete(playerId(connection))
    const key = scoreKey(connection)
    if (key === playerId(connection)) this.scores.forget(key)
  }

  /**
   * An away player is out of the rally in play, as a leaver is, and does not
   * count towards the next one, but keeps their seat for their return.
   */
  presence(connection: Connection): void {
    const seat = this.seats.get(playerId(connection))
    if (seat) seat.connection = connection
  }

  frame(now: number, movement: readonly MovementSample[] = []): void {
    this.time = now
    this.strays.sweep(now)
    this.flashes = this.flashes.filter((flash) => {
      if (now < flash.until) return true
      flash.object.remove()
      return false
    })
    const participants: Participant[] = []
    const requests: { seat: Seat; pawn: Pawn | undefined }[] = []
    const specialRequests: { seat: Seat; pawn: Pawn | undefined }[] = []
    const samples = new Map(movement.map((sample) => [sample.player, sample]))
    for (const [id, seat] of this.seats) {
      if (seat.connection.away) continue
      const pawn = seat.connection.player.pawn()
      this.maintainSeat(seat, pawn, now)
      this.showCharge(seat, pawn)
      const sample = samples.get(seat.connection.player)
      if (sample && pawn?.entity === sample.pawn) seat.movement = sample
      if (seat.block.takeRequest()) requests.push({ seat, pawn })
      if (seat.pendingSpecial) specialRequests.push({ seat, pawn })
      seat.pendingSpecial = false
      participants.push({
        id,
        bot: seat.connection.bot,
        ready: seat.special.choice !== undefined,
        body: this.body(seat, pawn),
      })
    }
    const events = this.round.tick(now, participants)
    for (const event of events) this.applyEvent(event)
    if (this.round.phase.kind === 'serve' || this.round.phase.kind === 'reset')
      this.scores.clearSender()
    for (const { seat, pawn } of specialRequests)
      this.activateSpecial(seat, pawn)
    for (const { seat, pawn } of requests) this.tryBlock(seat, pawn)
    this.drawBall()
    if (now >= this.nextUi || events.length) {
      this.nextUi = now + 0.1
      this.drawHud(now)
    }
  }

  spawned(player: Player, pawn: Pawn): void {
    const seat = this.seatFor(player)
    if (
      !seat ||
      seat.connection.away ||
      (seat.state.kind !== 'eliminated' && seat.state.kind !== 'spectating') ||
      this.round.lobby ||
      pawn.hero !== yamatoId ||
      pawn.health <= 0
    )
      return
    killEntity({ victim: pawn.entity })
    disableRespawn(pawn)
    if (seat.state.kind === 'spectating')
      seat.state.camera = { kind: 'pending' }
    this.rallyLog({
      kind: 'spawn-held',
      player: playerId(seat.connection),
      state: seat.state.kind,
      hero: pawn.entity,
    })
  }

  input(player: Player, pressed: bigint, released: bigint): void {
    const seat = this.seatFor(player)
    seat?.block.input(pressed & blockButtons, released & blockButtons)
    if (seat && pressed & specialButton) seat.pendingSpecial = true
  }

  choose(player: Player, value: string): boolean {
    const seat = this.seatFor(player)
    if (!seat || !isSpecialId(value) || !seat.special.choose(value))
      return false
    if (!seat.connection.bot && seat.connection.steamId !== 0n)
      this.choices.set(seat.connection.steamId, value)
    freeCursor(player, false)
    if (seat.state.kind === 'playing' || seat.state.kind === 'settling')
      this.syncSpecial(seat)
    this.nextUi = 0
    return true
  }

  requestSpecial(player: Player): void {
    const seat = this.seatFor(player)
    if (seat) seat.pendingSpecial = true
  }

  private syncSpecial(seat: Seat): void {
    const choice = seat.special.choice
    if (!choice) return
    const player = seat.connection.player
    const ability = player
      .abilities()
      .find((ability) => ability.name === specialCarrier)
    if (!ability) throw new Error('Special ability HUD carrier is missing')
    const end = seat.special.readyAt
    const start = end > 0 ? end - specials[choice].cooldown : 0
    if (
      !player.setAbility({
        ability: specialCarrier,
        upgrades: 1,
        cooldownEnd: end,
      }) ||
      !writeField(
        ability.entity,
        'CCitadelBaseAbility',
        'm_flCooldownStart',
        'float32',
        start,
      )
    ) {
      throw new Error(
        'Could not synchronize the native special ability cooldown',
      )
    }
  }

  private canUseSpecial(seat: Seat, pawn: Pawn | undefined): pawn is Pawn {
    const phase = this.round.phase.kind
    return (
      seat.special.choice !== undefined &&
      !seat.penalty &&
      seat.state.kind === 'playing' &&
      pawn !== undefined &&
      pawn.health > 0 &&
      seat.state.entity === pawn.entity &&
      this.round.living.has(playerId(seat.connection)) &&
      phase !== 'waiting' &&
      phase !== 'intermission' &&
      seat.special.canActivate(this.time) &&
      (seat.special.choice !== 'timeFreeze' ||
        this.round.canFreeze(playerId(seat.connection)))
    )
  }

  private activateSpecial(seat: Seat, pawn: Pawn | undefined): void {
    const choice = seat.special.choice
    if (!choice || !this.canUseSpecial(seat, pawn)) return
    const player = seat.connection.player
    switch (choice) {
      case 'powerSlash':
        player.sound('Yamato.A1.PowerSlash.Start')
        break
      case 'blink': {
        const heading = movementHeading(
          pawn.eyeAngles.yaw,
          seat.movement?.command,
        )
        const destination = blinkDestination({
          origin: pawn.position,
          heading,
          trace: (start, end) =>
            trace({
              start,
              end,
              layers: terrain,
              exclude: Layers.hero | Layers.player | Layers.hitbox,
              ignore: [pawn.entity],
            }),
        })
        if (
          !destination ||
          !player.teleport(destination, pawn.eyeAngles, {
            x: 0,
            y: 0,
            z: pawn.velocity.z,
          })
        )
          return
        this.round.relocate(playerId(seat.connection), destination)
        const effect = createParticle({
          resource: blinkEffect,
          position: pawn.position,
          point: { index: 1, position: destination },
        })
        if (effect)
          this.flashes.push({ object: effect, until: this.time + 0.6 })
        player.sound('Mods.Weapon.Warp.Stone.Cast')
        break
      }
      case 'timeFreeze':
        if (!this.round.freeze(this.time, playerId(seat.connection))) return
        break
      default: {
        const exhaustive: never = choice
        return exhaustive
      }
    }
    seat.special.activate(this.time)
    this.syncSpecial(seat)
    this.showCharge(seat, pawn)
    this.nextUi = 0
  }

  private cancelSpecial(seat: Seat): void {
    seat.special.cancelLife()
    seat.pendingSpecial = false
    this.showCharge(seat, undefined)
  }

  private showCharge(seat: Seat, pawn: Pawn | undefined): void {
    const want =
      seat.special.armed && pawn !== undefined && pawn.health > 0
        ? pawn.entity
        : undefined
    if (seat.charge && seat.charge.entity !== want) {
      seat.charge.object.remove()
      seat.charge = undefined
    }
    if (want === undefined || seat.charge || !pawn) return
    const object = createParticle({
      resource: chargeEffect,
      position: pawn.position,
      parent: pawn.entity,
    })
    if (object) seat.charge = { object, entity: want }
  }

  block(player: Player): boolean {
    const seat = this.seatFor(player)
    return seat ? this.tryBlock(seat, player.pawn()) : false
  }

  private seatFor(player: Player): Seat | undefined {
    for (const seat of this.seats.values())
      if (seat.connection.player === player) return seat
    return undefined
  }

  private tryBlock(seat: Seat, pawn: Pawn | undefined): boolean {
    if (
      seat.penalty ||
      seat.state.kind !== 'playing' ||
      !pawn ||
      pawn.health <= 0 ||
      pawn.entity !== seat.state.entity ||
      !this.round.ballInPlay ||
      !this.round.living.has(playerId(seat.connection)) ||
      !seat.block.press(this.time)
    )
      return false
    const effect = createParticle({
      resource: blockEffect,
      position: pawn.position,
      point: { index: 2, position: { x: rules.blockRadius, y: 0, z: 0 } },
      facing: { pitch: 0, yaw: pawn.eyeAngles.yaw, roll: 0 },
      parent: pawn.entity,
    })
    if (effect) this.flashes.push({ object: effect, until: this.time + 0.6 })
    seat.connection.player.sound('Yamato.CrimsonSlash.Cast')
    this.rallyLog({ kind: 'parry', player: playerId(seat.connection) })
    return true
  }

  private spawn(seat: Seat, index: number, count: number): void {
    this.clearPenalty(seat)
    this.cancelSpecial(seat)
    seat.block.reset()
    seat.special.resetRound()
    seat.movement = undefined
    const angle = (index * Math.PI * 2) / count
    seat.state = {
      kind: 'spawning',
      retryAt: this.time + 1,
      position: {
        x: Math.cos(angle) * rules.spawnRadius,
        y: Math.sin(angle) * rules.spawnRadius,
        z: 16,
      },
      facing: { pitch: 0, yaw: (angle * 180) / Math.PI + 180, roll: 0 },
    }
    const player = seat.connection.player
    player.startingSouls(0)
    selectOrRespawn(seat, player.pawn())
  }

  private maintainSeat(seat: Seat, pawn: Pawn | undefined, now: number): void {
    const player = seat.connection.player,
      state = seat.state
    if (
      seat.penalty &&
      (now >= seat.penalty.until ||
        pawn?.entity !== seat.penalty.entity ||
        pawn.health <= 0)
    )
      this.clearPenalty(seat)
    if (
      state.kind === 'playing' &&
      pawn &&
      pawn.health > 0 &&
      pawn.stamina !== undefined &&
      pawn.maxStamina !== undefined &&
      pawn.stamina < pawn.maxStamina
    ) {
      if (!player.restoreStamina())
        throw new Error('Could not refill player stamina')
    }
    if (state.kind === 'spawning') {
      if (pawn && pawn.hero === yamatoId && pawn.health > 0) {
        const abilities = player.abilities()
        if (!abilities.some((ability) => ability.name === specialCarrier))
          return
        if (!player.unwatch()) return
        player.clearItems()
        player.adjustSouls(-pawn.souls, true)
        player.heal(pawn.effectiveMaxHealth ?? pawn.maxHealth)
        if (pawn.abilityPoints || pawn.abilityUnlocks)
          player.adjustAbilityPoints(-pawn.abilityPoints, -pawn.abilityUnlocks)
        for (const ability of abilities)
          if (ability.slot >= 0 && ability.slot <= 3)
            player.setAbility({ ability: ability.name, upgrades: 0 })
        this.syncSpecial(seat)
        player.watchMovement(true)
        for (const flag of [
          'MODIFIER_STATE_DISARMED',
          'MODIFIER_STATE_MELEE_DISABLED',
          'MODIFIER_STATE_PARRY_DISABLED',
          'MODIFIER_STATE_UNIT_STATUS_HIDDEN',
          'MODIFIER_STATE_SILENCED_HIDDEN',
        ]) {
          if (!holdModifierState(pawn.entity, flag, true))
            throw new Error(`Could not apply ${flag}`)
        }
        player.teleport(state.position, state.facing, { x: 0, y: 0, z: 0 })
        seat.state = {
          kind: 'settling',
          entity: pawn.entity,
          until: now + 0.15,
        }
      } else if (now >= state.retryAt) {
        selectOrRespawn(seat, pawn)
        state.retryAt = now + 1
      }
    } else if (state.kind === 'settling') {
      if (
        now >= state.until &&
        pawn?.entity === state.entity &&
        pawn.health > 0
      )
        seat.state = { kind: 'playing', entity: state.entity }
    } else if (state.kind === 'eliminated') {
      if (now >= state.spectateAt) {
        seat.state = {
          kind: 'spectating',
          retryAt: now,
          camera: { kind: 'pending' },
        }
      }
    } else if (state.kind === 'spectating') {
      if (this.round.lobby)
        this.spawn(
          seat,
          [...this.seats.values()].indexOf(seat),
          this.seats.size,
        )
      else this.maintainSpectator(seat, state, pawn, now)
    } else if (this.round.lobby) {
      if (
        !pawn ||
        pawn.hero !== yamatoId ||
        pawn.health <= 0 ||
        pawn.position.z < rules.minimumHeight
      )
        this.spawn(seat, 0, 8)
    } else if (
      pawn &&
      pawn.entity !== state.entity &&
      this.round.living.has(playerId(seat.connection))
    ) {
      player.kill()
    }
  }

  private maintainSpectator(
    seat: Seat,
    state: Extract<SeatState, { kind: 'spectating' }>,
    pawn: Pawn | undefined,
    now: number,
  ): void {
    const player = seat.connection.player
    const previous = state.camera
    const observed =
      previous.kind === 'attached'
        ? readField(
            previous.camera,
            'CPlayer_ObserverServices',
            'm_hObserverTarget',
            'handle',
          )
        : undefined
    const livingTarget =
      typeof observed === 'number' &&
      [...this.round.living].some((id) => {
        const target = this.seats.get(id)
        return (
          target?.state.kind === 'playing' &&
          target.state.entity === observed &&
          (target.connection.player.pawn()?.health ?? 0) > 0
        )
      })
    if (
      previous.kind === 'attached' &&
      livingTarget &&
      typeof observed === 'number'
    )
      previous.target = observed
    if (
      now < state.retryAt &&
      (previous.kind === 'pending' || observed === undefined || livingTarget)
    )
      return
    state.retryAt = now + 1
    if (!pawn || pawn.hero !== yamatoId) {
      state.camera = { kind: 'pending' }
      if (!seat.connection.bot)
        this.rallyLog({
          kind: 'spectator-select',
          player: playerId(seat.connection),
          selected: player.selectHero(hero, 2) ?? null,
        })
      return
    }
    if (pawn.health > 0) {
      state.camera = { kind: 'pending' }
      killEntity({ victim: pawn.entity })
      disableRespawn(pawn)
      return
    }
    if (
      readField(
        pawn.entity,
        'CCitadelPlayerPawn',
        'm_flRespawnTime',
        'float32',
      ) !== 0
    )
      disableRespawn(pawn)
    if (seat.connection.bot) return
    const camera = nativeObserver(pawn)
    if (
      camera === undefined ||
      (state.camera.kind === 'attached' &&
        state.camera.hero === pawn.entity &&
        state.camera.camera === camera &&
        (observed === undefined || livingTarget))
    )
      return
    state.camera = { kind: 'pending' }
    const targets = [...this.round.living]
      .filter((id) => id !== playerId(seat.connection))
      .map((id) => this.seats.get(id)?.connection.player.pawn())
      .filter((p): p is Pawn => !!p && p.hero === yamatoId && p.health > 0)
    const target =
      (previous.kind === 'attached' &&
        targets.find((p) => p.entity !== previous.target)) ||
      targets[0]
    if (!target) return
    const attached = player.watch(target.entity)
    if (attached)
      state.camera = {
        kind: 'attached',
        hero: pawn.entity,
        camera,
        target: target.entity,
      }
    this.rallyLog({
      kind: 'spectator-watch',
      player: playerId(seat.connection),
      hero: pawn.entity,
      camera,
      target: target.entity,
      attached,
    })
  }

  private body(seat: Seat, pawn: Pawn | undefined): Body | undefined {
    const state = seat.state
    if (state.kind !== 'playing' || !pawn || state.entity !== pawn.entity)
      return undefined
    return {
      alive: pawn.health > 0 && pawn.hero === yamatoId,
      position: pawn.position,
      look: vector.forward(pawn.eyeAngles),
      parries: seat.penalty
        ? []
        : [seat.block.window].filter((window) => window !== undefined),
      empowered: seat.special.armed,
    }
  }

  private rallyLog(fields: object): void {
    log('RALLY ' + JSON.stringify({ time: this.time, ...fields }))
  }

  private clearPenalty(seat: Seat): void {
    if (
      seat.penalty &&
      seat.connection.player.pawn()?.entity === seat.penalty.entity
    ) {
      if (
        !holdModifierState(seat.penalty.entity, 'MODIFIER_STATE_STUNNED', false)
      )
        throw new Error('Could not release orbit stun')
    }
    seat.penalty = undefined
  }

  private applyEvent(event: RoundEvent): void {
    this.rallyLog({ round: this.round.number, ...event })
    switch (event.kind) {
      case 'spawn':
        event.players.forEach((id, i) => {
          const seat = this.seats.get(id)
          if (seat) this.spawn(seat, i, event.players.length)
        })
        return
      case 'target': {
        const seat = this.seats.get(event.player)
        if (event.refresh) seat?.block.refresh(this.time)
        seat?.connection.player.sound('Unicorn.Dazzling.Orb.Cast')
        return
      }
      case 'eliminate': {
        const seat = this.seats.get(event.player)
        if (!seat) return
        if (event.reason === 'ball') this.scores.hit(scoreKey(seat.connection))
        this.clearPenalty(seat)
        this.cancelSpecial(seat)
        const pawn = seat.connection.player.pawn()
        // A returning client whose hero lies dead drops the connection, so an
        // away player's hero is killed once they are back and spectating.
        if (pawn && !seat.connection.away) {
          if (pawn.health > 0) killEntity({ victim: pawn.entity })
          disableRespawn(pawn)
        }
        seat.state = { kind: 'eliminated', spectateAt: this.time + 0.5 }
        return
      }
      case 'block': {
        const seat = this.seats.get(event.player)
        if (!seat) return
        this.scores.parry(scoreKey(seat.connection))
        if (event.empowered) {
          seat.special.consumePower()
          this.showCharge(seat, undefined)
          seat.connection.player.sound('Yamato.A1.PowerSlash.Cast.Max')
        }
        seat.connection.player.sound('Player.Melee.Parry.Success.Shared')
        return
      }
      case 'orbit': {
        const seat = this.seats.get(event.player)
        const pawn = seat?.connection.player.pawn()
        if (!seat || !pawn || pawn.health <= 0) return
        if (!holdModifierState(pawn.entity, 'MODIFIER_STATE_STUNNED', true))
          throw new Error('Could not apply orbit stun')
        seat.penalty = {
          entity: pawn.entity,
          until: this.time + rules.orbitPenalty,
        }
        if (!pushEntity(pawn.entity, event.push))
          throw new Error('Could not apply orbit push')
        return
      }
      case 'resume':
        this.resumeCueUntil = this.time + 0.4
        return
      case 'winner': {
        for (const seat of this.seats.values()) this.clearPenalty(seat)
        const winner = event.player ? this.seats.get(event.player) : undefined
        this.scores.win(winner ? scoreKey(winner.connection) : undefined)
        this.winnerName = event.player
          ? (winner?.connection.name ?? 'Last survivor')
          : 'Nobody'
        return
      }
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  }

  private drawBall(): void {
    const ball = this.round.ballInPlay
    if (ball) {
      if (!this.ball) {
        this.ball = createParticle({
          resource: ballEffect,
          position: ball.position,
        })
        if (!this.ball) throw new Error('Could not create the rally ball')
      }
      this.ball.move(ball.position)
    } else if (this.ball) {
      this.ball.remove()
      this.ball = undefined
    }
  }

  private drawHud(now: number): void {
    const phase = this.round.phase
    const ball = this.round.ballInPlay
    const contenders: Contender[] = [...this.seats].map(([id, seat]) => ({
      key: scoreKey(seat.connection),
      name: seat.connection.name,
      alive: this.round.lobby || this.round.living.has(id),
    }))
    const context = {
      now,
      round: this.round.number,
      remaining: this.round.living.size,
      seats: [...this.seats.values()].filter((seat) => !seat.connection.away)
        .length,
      winnerName: this.winnerName,
      resumeCueUntil: this.resumeCueUntil,
    }
    for (const [id, seat] of this.seats) {
      if (seat.connection.bot) continue
      const player = seat.connection.player
      drawHud(player, {
        notice: notice(
          phase,
          {
            chosen: seat.special.choice !== undefined,
            spectating:
              seat.state.kind === 'spectating' ||
              seat.state.kind === 'eliminated',
            targeted: ball?.target === id,
            penaltyUntil: seat.penalty?.until,
            blockCooldown: seat.block.cooldown(now),
          },
          context,
        ),
        special: {
          choice: seat.special.choice ?? null,
          armed: seat.special.armed,
          available: this.canUseSpecial(seat, player.pawn()),
        },
        standings: seat.special.choice
          ? {
              rows: this.scores.board(contenders, scoreKey(seat.connection)),
              full: phase.kind === 'intermission',
            }
          : undefined,
        rally: { count: this.round.rally, live: ball !== undefined },
      })
    }
  }
}
