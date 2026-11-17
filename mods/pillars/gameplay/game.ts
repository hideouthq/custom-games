import {
  type AbilityCastEvent,
  addBot,
  type Connection,
  createEntity,
  createParticle,
  createText,
  type DamagedEvent,
  type DamageEvent,
  type DamageResult,
  entityClass,
  entityPosition,
  findEntities,
  hide,
  hideHud,
  holdModifierState,
  killEntity,
  log,
  modifiers,
  type MovementSample,
  type Player,
  precache,
  readField,
  removeEntities,
  removeEntity,
  show,
  toast,
  type WorldObject,
  writeField,
} from 'modlock'
import { apply, arena as emptyMap } from 'modlock/console'

import { Centre } from './centre'
import { Credit, knock, type Melee, meleeDamage, meleeOf } from './combat'
import { arena, combat, rules, unitsPerMetre } from './config'
import { assignHero, donors, pool, type PoolHero, reserveAfter } from './heroes'
import { hud, type HudDrop, type HudRow, type HudView, samples } from './hud'
import { Inventory } from './inventory'
import {
  catalog,
  dropsFor,
  freshPity,
  lingerSeconds,
  legendary,
  type Loot,
  type Pity,
  roll,
} from './loot'
import {
  type Effect,
  personKey,
  type PlayerId,
  PlayerIds,
  Round,
  type View,
} from './round'
import {
  deckSpot,
  facingCentre,
  pillarStand,
  pillarTop,
  type Point,
  random,
} from './seating'

/**
 * Free-for-all makes everyone an enemy on the server, but a player's own game
 * draws teammates as allies and predicts their shoves that way, so players
 * are spread across both teams.
 */
const teams = [2, 3] as const

/**
 * A gun cannot start a reload before this time, in the server or in its
 * player's own prediction. A held modifier state only refused the refill at
 * the end, after the player's game had shown the reload and a full magazine.
 */
const reloadGate = 'm_flReloadAvailableTime'

const gateSeconds = 3600

const endlessClip = 'MODIFIER_STATE_INFINITE_CLIP'

const placeholders = [
  'targetdummy_ability_1',
  'targetdummy_ability_2',
  'targetdummy_ability_3',
  'targetdummy_ability_4',
]

const shoveSeconds = 5

const effectSeconds = 0.25

const staminaSlack = 0.02

const swapClass = 'CCitadel_Ability_ChronoSwap'

const gunClass = 'CCitadel_Ability_PrimaryWeapon'

/**
 * ESlot_Weapon_Primary: the slot the game binds each hero's gun to. Viscous
 * and Yamato carry a second weapon of the same class, and Billy's and
 * Silver's guns are classes of their own.
 */
const gunSlot = 21

/** A teleport any lower can leave a hero half inside a pillar's top. */
const standHeight = 24

const sunk = 6

const heroWaitSeconds = 10

const settleSeconds = 1.5

const stepSeconds = 0.25

const cardSeconds = 4.5

/**
 * Left alone, the game stands a dead hero on the map's origin, the centre
 * deck, as a ghost every other player sees.
 */
const grave: Point = { x: 9000, y: 9000, z: -7000 }

const graveSeconds = 0.5

const crateClass = 'citadel_breakable_prop'
const crateEntry = 'citadel_breakable_prop_tough_crate'
const crateGlow = 'particles/environment/powerup_spawner_ambient.vpcf'
/**
 * The map ships neither model, and a crate whose model was never loaded fails
 * the game's model assertion.
 */
const crateModels = [
  'models/items/item_crate_tough.vmdl',
  'models/items/item_crate_tough_2.vmdl',
  // A broken crate drops a souls idol; unloaded, it stalls the server.
  'models/props_gameplay/powerup_idol/powerup_idol.vmdl',
]

const crateSpoils = ['citadel_pickup_gold', 'citadel_pickup_modifier']

type Step = 'idle' | 'revive' | 'reset' | 'place' | 'ready'

interface Member {
  readonly id: PlayerId
  readonly player: Player
  readonly name: string
  readonly bot: boolean
  hero: PoolHero
  readonly joinedAt: number
  asked: boolean
  entity: number
  alive: boolean
  position: Point
  health: number
  maxHealth: number
  stamina: number
  maxStamina: number
  pips: number
  reserve: number
  lastClip: number
  grounded: boolean
  points: number
  unlocks: number
  onTeam: number
  damage: number
  inventory: Inventory
  pity: Pity
  seat: number
  step: Step
  stepAt: number
  laid: boolean
  watching: number
  struck: Melee | undefined
  gun: number
  gunOf: number
  endlessUntil: number
  drawn: string
  card: HudDrop | undefined
  cardUntil: number
  graveAt: number
}

interface Crate {
  readonly entity: number
  readonly prize: Loot
  readonly marks: WorldObject[]
}

function standOn(player: Player, spot: Point, yaw: number): void {
  player.teleport(
    { ...spot, z: spot.z + standHeight },
    { pitch: 0, yaw, roll: 0 },
    { x: 0, y: 0, z: 0 },
  )
}

export class Game {
  private readonly round: Round
  private readonly roll: () => number
  private readonly credit = new Credit()
  private readonly members = new Map<number, Member>()
  private readonly people = new Map<PlayerId, Member>()
  private readonly ids = new PlayerIds()
  private readonly byEntity = new Map<number, Member>()
  private readonly botHeroes = new Map<string, PoolHero>()
  private readonly classes = new Map<number, string>()
  private shove: { by: PlayerId; at: number } | undefined
  private effectsAt = 0
  private devMode = false
  private readonly centre = new Centre()
  private wantBots = 0
  private drops = 0
  private readonly before = new Map<PlayerId, number>()
  private readonly pinned = new Map<number, HudView>()
  private now = 0
  private joinedAt = 0
  private crate: Crate | undefined

  constructor(seed: number = Math.floor(Math.random() * 0xffffffff)) {
    this.roll = random(seed)
    this.round = new Round(random(seed ^ 0x9e3779b9))
  }

  start(args: readonly string[]): void {
    const refused = apply({
      ...emptyMap,
      // The stock Soul Urn would spawn at the map's origin, on the centre deck.
      citadel_crate_spawn_enabled: false,
      citadel_bot_brain_disable_attacks: true,
      citadel_bot_brain_disable_movement: true,
      // Kill souls would level the killer up, raising and then dropping their
      // health once the mode took the souls back.
      citadel_player_gold_reward_min: 0,
      citadel_player_gold_reward_max: 0,
      citadel_player_gold_reward_first_kill_bonus: 0,
      citadel_player_starting_death_penalty_gold: 0,
      citadel_no_orbs_on_hero_kill: true,
    })
    if (refused.length > 0) {
      log('settings refused: ' + refused.join(', '))
    }
    precache({
      heroes: [...pool.map((hero) => hero.name), ...donors],
      resources: [crateGlow, ...crateModels],
    })
    for (const arg of args) {
      if (arg === 'dev') {
        this.devMode = true
      }
      if (arg.startsWith('bots=')) {
        this.wantBots = Math.max(
          0,
          Math.min(rules.maxPlayers, Number(arg.slice(5)) || 0),
        )
      }
    }
  }

  /**
   * dev runs one test command when the server was started with the dev
   * argument: give <loot id>, item <item name>, deck, pillar <n> [yaw],
   * look <yaw> <pitch>, face <player> [height], team <player> <2|3>,
   * near <player>, mods [player], where, hurt <health>, kill,
   * swap <slot> <ability name>, find <class>, state, and hud <sample>
   * (any other word clears it).
   */
  dev(player: Player, line: string): void {
    const member = this.members.get(player.slot)
    if (!this.devMode || member === undefined) {
      return
    }
    const [action = '', first = '', second = '', third = ''] = line
      .trim()
      .split(/\s+/)
    const named = (each: Member) =>
      each.name.toLowerCase() === `${first} ${second}`.trim().toLowerCase()
    log(`dev ${member.name}: ${line}`)
    if (action === 'hud') {
      const sample = samples[first]
      if (sample === undefined) {
        this.pinned.delete(player.slot)
      } else {
        this.pinned.set(player.slot, sample)
      }
    } else if (action === 'give') {
      const loot = catalog.find((entry) => entry.id === first)
      if (loot !== undefined) {
        this.grant(member, loot)
      }
    } else if (action === 'deck' || action === 'pillar') {
      const spot =
        action === 'deck' ? deckSpot(0, 1) : pillarTop(Number(first) || 0)
      standOn(player, spot, Number(second) || 0)
    } else if (action === 'look') {
      player.teleport(member.position, {
        pitch: Number(second) || 0,
        yaw: Number(first) || 0,
        roll: 0,
      })
    } else if (action === 'hurt') {
      writeField(
        member.entity,
        'CBaseEntity',
        'm_iHealth',
        'int32',
        Number(first) || 100,
      )
    } else if (action === 'find') {
      const found = findEntities(first)
      const near = found
        .map((entity) => ({ entity, at: entityPosition(entity)?.position }))
        .filter(({ at }) => at !== undefined && Math.hypot(at.x, at.y) < 300)
      log(
        `dev find ${first}: ${found.length} total, ${near.length} near the origin ${near.map(({ entity, at }) => `${entity}@${Math.round(at?.z ?? 0)}:hp${String(readField(entity, 'CBaseEntity', 'm_iHealth', 'int32'))}:ctl${String(readField(entity, 'CBasePlayerPawn', 'm_hController', 'handle'))}:life${String(readField(entity, 'CBaseEntity', 'm_lifeState', 'uint8'))}:known${this.byEntity.has(entity)}`).join(' ')}`,
      )
    } else if (action === 'face') {
      const other = [...this.members.values()].find(
        (each) =>
          each !== member &&
          (named(each) || String(each.player.slot) === first),
      )
      if (other !== undefined) {
        const dx = other.position.x - member.position.x
        const dy = other.position.y - member.position.y
        const dz =
          other.position.z + (Number(third) || 40) - (member.position.z + 64)
        player.teleport(member.position, {
          pitch: (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI,
          yaw: (Math.atan2(dy, dx) * 180) / Math.PI,
          roll: 0,
        })
        log(
          `dev face ${other.name}: ${Math.round(Math.hypot(dx, dy) / unitsPerMetre)} m`,
        )
      }
    } else if (action === 'team' || action === 'near') {
      const other = [...this.members.values()].find(named)
      if (other !== undefined && action === 'team') {
        log(
          `dev team ${other.name} ${third}: ${other.player.changeTeam(Number(third))}`,
        )
      } else if (other !== undefined) {
        let nearest = 0
        for (let index = 1; index < arena.pillars; index++) {
          const top = pillarTop(index)
          const best = pillarTop(nearest)
          const gap = (spot: { x: number; y: number }) =>
            Math.hypot(spot.x - member.position.x, spot.y - member.position.y)
          if (gap(top) < gap(best)) nearest = index
        }
        standOn(other.player, pillarStand((nearest + 1) % arena.pillars), 0)
      }
    } else if (action === 'mods') {
      const other = [...this.members.values()].find(named) ?? member
      log(
        `dev mods ${other.name}: ${modifiers(other.entity)
          .map(
            (held) =>
              (held.name || held.className) +
              `[ability ${held.ability}, age ${held.age.toFixed(1)}s` +
              ((held.remaining ?? 0) > 0
                ? `, ${(held.remaining ?? 0).toFixed(1)}s left]`
                : ']'),
          )
          .join(' ')}`,
      )
    } else if (action === 'where') {
      log(
        `dev where: ${[...this.members.values()]
          .map(
            (each) =>
              `${each.name}[${each.onTeam}]@${Math.round(each.position.x)},${Math.round(each.position.y)},${Math.round(each.position.z)}${each.alive ? '' : '(dead)'}`,
          )
          .join(' ')}`,
      )
    } else if (action === 'item') {
      log(`dev giveItem ${first}: ${player.giveItem(first)}`)
    } else if (action === 'kill') {
      player.kill()
    } else if (action === 'swap') {
      log(
        `dev replaceAbility ${first} ${second}: ${player.replaceAbility(Number(first) || 0, second)}`,
      )
    } else if (action === 'state') {
      const held = player
        .abilities()
        .filter(
          (ability) => ability.slot < 4 || ability.name.startsWith('upgrade_'),
        )
        .map(
          (ability) =>
            `${ability.slot}:${ability.name}:${ability.upgrades}${ability.cooldownEnd > this.now ? `:cd${(ability.cooldownEnd - this.now).toFixed(1)}` : ''}`,
        )
        .join(' ')
      log(
        `dev state: phase ${this.round.phase}, team ${member.onTeam}, health ${Math.round(member.health)} of ${Math.round(member.maxHealth)}, stamina ${member.stamina.toFixed(2)} of ${member.maxStamina} (given ${member.pips.toFixed(2)}), clip ${this.clip(member)}, reserve ${member.reserve}, reload ${this.reloadHeld(member) ? 'blocked' : 'free'}, items ${member.inventory
          .held('item')
          .map((held) =>
            held === undefined ? '-' : `${held.loot.id}:${held.charges}`,
          )
          .join(
            ' ',
          )}${member.inventory.itemsDue ? ' (due)' : ''}, pos ${Math.round(member.position.x)} ${Math.round(member.position.y)} ${Math.round(member.position.z)}, abilities ${held}`,
      )
    }
  }

  world(): void {
    this.botHeroes.clear()
    this.crate = undefined
  }

  join(connection: Connection): void {
    const taken = new Set(
      [...this.members.values()].map((member) => member.hero.name),
    )
    const hero =
      this.botHeroes.get(connection.name) ?? assignHero(taken, this.roll)
    const player = connection.player
    let id = this.ids.of(
      personKey(connection.steamId, player.slot, connection.generation),
    )
    if (this.people.has(id)) {
      id = this.ids.of(personKey(0n, player.slot, connection.generation))
    }
    player.watchMovement(true)
    if (!connection.bot) {
      // A slot's interface must be reset before the game accepts changes to it.
      hide(player)
      hideHud(player, ['levelUp', 'souls', 'minimap', 'stats', 'topBar'])
    }
    const member: Member = {
      id,
      player,
      name: connection.name,
      bot: connection.bot,
      hero,
      joinedAt: this.now,
      asked: connection.bot,
      entity: 0,
      alive: false,
      position: { x: 0, y: 0, z: 0 },
      health: 0,
      maxHealth: 1,
      stamina: 0,
      maxStamina: 0,
      pips: 0,
      reserve: 0,
      lastClip: 0,
      grounded: true,
      points: 0,
      unlocks: 0,
      onTeam: 0,
      damage: 0,
      inventory: new Inventory(),
      pity: freshPity(),
      seat: 0,
      step: 'idle',
      stepAt: 0,
      laid: false,
      watching: -1,
      struck: undefined,
      gun: 0,
      gunOf: 0,
      endlessUntil: 0,
      drawn: '',
      card: undefined,
      cardUntil: 0,
      graveAt: 0,
    }
    this.members.set(player.slot, member)
    this.people.set(id, member)
    this.joinedAt = this.now
    log(`${connection.name} joined in slot ${player.slot} as player ${id}`)

    if (!connection.bot && !this.humanPlaying()) {
      this.round.abandon()
      log(`${connection.name} joined; restarting the round for them`)
    } else if (!connection.bot && this.round.playing) {
      player.announce(
        'ROUND IN PROGRESS',
        'You join the next round. Until then you watch.',
      )
    }
  }

  private humanPlaying(): boolean {
    for (const member of this.members.values()) {
      if (!member.bot && this.round.inRound(member.id)) {
        return true
      }
    }
    return false
  }

  private humanAlive(): boolean {
    for (const member of this.members.values()) {
      if (!member.bot && this.round.isLiving(member.id)) {
        return true
      }
    }
    return false
  }

  private settling(): boolean {
    if (
      this.botHeroes.size < this.wantBots ||
      this.now - this.joinedAt < settleSeconds
    ) {
      return true
    }
    for (const member of this.members.values()) {
      if (member.entity === 0 && this.now - member.joinedAt < heroWaitSeconds) {
        return true
      }
    }
    return false
  }

  leave(connection: Connection): void {
    const member = this.members.get(connection.player.slot)
    if (member !== undefined) {
      this.people.delete(member.id)
      this.centre.leave(member.id)
    }
    this.members.delete(connection.player.slot)
    this.pinned.delete(connection.player.slot)
  }

  frame(now: number, movement: readonly MovementSample[]): void {
    this.now = now
    this.seatBots()
    this.read()
    this.observe(movement)
    this.enforceVoid()
    if (this.wantBots > 0 && this.round.playing && !this.humanAlive()) {
      log('only bots are left; starting the next round')
      this.round.abandon()
      this.joinedAt = now + 2
    }

    const people = [...this.members.values()].some((member) => !member.bot)
    const views =
      this.round.phase === 'waiting' && (this.settling() || !people)
        ? []
        : this.views()
    const effects = this.round.tick(now, views, (id) => this.creditFor(id))
    for (const effect of effects) {
      this.apply(effect)
    }
    this.lookAtEffects()
    for (const member of this.members.values()) {
      if (this.now >= member.endlessUntil) {
        this.endEndless(member)
      }
      this.ready(member)
      this.lobby(member)
      this.bury(member)
      this.empty(member)
      this.holdStamina(member)
      this.ammo(member)
      this.draw(member)
    }
    this.offerCentre()
  }

  /**
   * A new or revived hero appears at the map's origin, inside the centre
   * column, and drops through it into the void.
   */
  spawned(player: Player): void {
    const member = this.members.get(player.slot)
    if (member === undefined) {
      return
    }
    if (member.step !== 'idle') {
      if (this.round.phase === 'countdown') {
        log(`${member.name} spawned; onto their seat, pillar ${member.seat}`)
        this.toPillar(member)
      }
      return
    }
    if (!this.round.inRound(member.id)) {
      member.seat = player.slot % arena.pillars
      log(`${member.name} spawned outside a round; onto pillar ${member.seat}`)
      this.toPillar(member)
    }
  }

  /** Outside play nothing kills a fall, so a hero in the void is put back. */
  private lobby(member: Member): void {
    const seated = this.round.inRound(member.id)
    if (
      !member.alive ||
      this.round.playing ||
      (this.round.phase === 'countdown' && seated)
    ) {
      return
    }
    const inColumn =
      Math.hypot(member.position.x, member.position.y) < arena.centreRadius &&
      member.position.z < arena.centreZ - sunk
    if (inColumn || member.position.z < arena.topZ - 200) {
      if (!seated) {
        member.seat = member.player.slot % arena.pillars
      }
      log(
        `${member.name} stood at ${Math.round(member.position.x)} ${Math.round(member.position.y)} ${Math.round(member.position.z)} between rounds; onto pillar ${member.seat}`,
      )
      this.toPillar(member)
    }
  }

  /**
   * The game regenerates stamina as usual, here and in the player's own
   * prediction, so the two agree; what regenerates is taken back each tick.
   */
  private holdStamina(member: Member): void {
    if (
      !member.alive ||
      member.step !== 'ready' ||
      !this.round.isLiving(member.id)
    ) {
      return
    }
    if (member.stamina < member.pips - staminaSlack) {
      if (this.devMode) {
        log(
          `dev stamina ${member.name}: spent ${(member.pips - member.stamina).toFixed(2)}, ${member.stamina.toFixed(2)} left`,
        )
      }
      member.pips = Math.max(0, member.stamina)
    } else if (!member.bot) {
      // A player's own game regenerates stamina from stock data between
      // updates; anchoring it every frame keeps that drift under a pixel.
      member.player.setStamina(member.pips)
    }
  }

  private givePips(member: Member, pips: number): void {
    member.pips = Math.max(
      0,
      Math.min(pips, rules.maxStamina, member.maxStamina || rules.maxStamina),
    )
    const ok = member.player.setStamina(member.pips)
    if (this.devMode) {
      log(
        `dev stamina ${member.name}: given ${member.pips} of ${member.maxStamina}, had ${member.stamina.toFixed(2)}${ok ? '' : ', REFUSED'}`,
      )
    }
    member.stamina = member.pips
  }

  private ammo(member: Member): void {
    if (
      !member.alive ||
      member.step !== 'ready' ||
      !this.round.isLiving(member.id)
    ) {
      return
    }
    let clip = this.clip(member)
    const endless = this.now < member.endlessUntil
    if (!endless && clip > member.lastClip) {
      // A reload fills the magazine whatever the reserve holds.
      const loaded = clip - member.lastClip
      if (loaded > member.reserve) {
        clip = member.lastClip + member.reserve
        this.setClip(member, clip)
        member.reserve = 0
      } else {
        member.reserve -= loaded
      }
    }
    member.lastClip = clip
    const blocked = member.reserve <= 0 || clip >= member.hero.clip
    const gun = this.gunOf(member)
    // The game moves the gate itself as a magazine runs dry.
    if (gun !== 0 && blocked !== this.reloadHeld(member)) {
      writeField(
        gun,
        gunClass,
        reloadGate,
        'float32',
        blocked ? this.now + gateSeconds : this.now,
      )
    }
  }

  private reloadHeld(member: Member): boolean {
    const gun = this.gunOf(member)
    const at =
      gun === 0 ? undefined : readField(gun, gunClass, reloadGate, 'float32')
    return typeof at === 'number' && at > this.now + gateSeconds / 2
  }

  private draw(member: Member): void {
    if (member.bot) {
      return
    }
    const view = this.pinned.get(member.player.slot) ?? this.viewFor(member)
    const drawn = JSON.stringify(view)
    if (drawn === member.drawn) {
      return
    }
    member.drawn = drawn
    show(member.player, hud(view))
  }

  private viewFor(member: Member): HudView {
    const id = member.id
    const phase = this.round.phase
    const playing = this.round.playing

    const span =
      phase === 'live' ? rules.dropSeconds : rules.overtimeDropSeconds
    const until = playing ? this.round.dropAt : this.round.deadline
    const seconds =
      phase === 'waiting' ? 0 : Math.max(0, Math.ceil(until - this.now))

    const winner = this.round.winner
    const rows: HudRow[] = []
    for (const standing of this.round.standings()) {
      const other = this.people.get(standing.id)
      if (other !== undefined) {
        rows.push({
          name: other.name,
          hero: other.hero.id,
          points: standing.points,
          wins: standing.wins,
          eliminations: standing.eliminations,
          gained: standing.points - (this.before.get(standing.id) ?? 0),
          out: playing && !this.round.isLiving(standing.id),
          self: other === member,
          winner: standing.id === winner,
        })
      }
    }
    return {
      phase,
      round: this.round.number,
      rounds: rules.rounds,
      alive: this.round.survivors().length,
      seconds,
      dropFill: playing ? Math.min(1, Math.max(0, 1 - seconds / span)) : 0,
      standing: !playing
        ? 'in'
        : this.round.isLiving(id)
          ? 'in'
          : this.round.inRound(id)
            ? 'out'
            : 'watching',
      watched: this.people.get(member.watching)?.name,
      centre:
        playing && this.centre.open
          ? this.crate === undefined
            ? 'deck'
            : 'crate'
          : undefined,
      drop: this.now < member.cardUntil ? member.card : undefined,
      reserve: member.reserve,
      rows,
    }
  }

  private offerCentre(): void {
    if (this.centre.sweeping(this.now)) {
      for (const spoil of crateSpoils) {
        removeEntities(spoil)
      }
    }
    if (!this.round.playing || this.round.phase === 'final') {
      this.centre.close()
      this.clearCrate()
      return
    }
    const centre = this.centre.tick(this.now)
    if (centre === 'waiting') {
      return
    }
    if (centre === 'appears') {
      this.crate = this.placeCrate()
      this.tell(
        this.crate === undefined
          ? 'A Legendary waits on the centre deck.'
          : `A Legendary crate waits on the centre deck: heavy melee it for ${this.crate.prize.label}.`,
      )
    }
    const crate = this.crate
    if (crate !== undefined) {
      const breaker = readField(
        crate.entity,
        'CCitadel_BreakableProp',
        'm_hBreaker',
        'handle',
      )
      const by =
        typeof breaker === 'number' ? this.byEntity.get(breaker) : undefined
      if (by !== undefined) {
        this.opened(by)
      }
      return
    }
    const taker = this.centre.hold(
      this.now,
      [...this.members.values()].map((member) => ({
        id: member.id,
        onDeck:
          member.alive &&
          this.round.isLiving(member.id) &&
          Math.hypot(member.position.x, member.position.y) <=
            arena.centreRadius &&
          member.position.z >= arena.centreZ - 20,
      })),
    )
    const member = taker === undefined ? undefined : this.people.get(taker)
    const prize = member === undefined ? undefined : legendary(this.roll)
    if (member !== undefined && prize !== undefined) {
      log(`centre legendary ${prize.id} to ${member.name}`)
      this.tell(`${member.name} took ${prize.label} from the centre.`)
      this.grant(member, prize)
    }
  }

  private placeCrate(): Crate | undefined {
    const prize = legendary(this.roll)
    if (prize === undefined) {
      return undefined
    }
    const deck = { x: 0, y: 0, z: arena.centreZ }
    const crate = {
      designerName: crateClass,
      subclass: crateEntry,
      team: 4,
      position: deck,
      facing: { pitch: 0, yaw: 0, roll: 0 },
    }
    // The stock crate first appears three minutes in, and comes back. A
    // field the game will not take cancels the crate, so try once without.
    const entity =
      createEntity({
        ...crate,
        fields: [
          {
            className: 'CCitadel_BreakableProp',
            field: 'm_flOverrideInitialSpawnTime',
            type: 'float32',
            value: 0.01,
          },
          {
            className: 'CCitadel_BreakableProp',
            field: 'm_flOverrideRespawnTime',
            type: 'float32',
            value: 99999,
          },
        ],
      }) ?? createEntity(crate)
    if (entity === undefined) {
      log('the centre crate was refused; the deck gives the Legendary instead')
      return undefined
    }
    const marks: WorldObject[] = []
    const glow = createParticle({ resource: crateGlow, position: deck })
    if (glow !== undefined) {
      marks.push(glow)
    }
    const label = createText({
      text: `LEGENDARY: ${prize.label.toUpperCase()} · HEAVY MELEE TO BREAK`,
      position: { ...deck, z: deck.z + 120 },
      faceCamera: true,
      fontSize: 48,
      color: 0xffc94a,
    })
    if (label !== undefined) {
      marks.push(label)
    }
    log(`centre crate ${entity} holds ${prize.id}`)
    return { entity, prize, marks }
  }

  private opened(member: Member): void {
    const crate = this.crate
    if (crate === undefined) {
      return
    }
    this.clearCrate()
    this.centre.broken(this.now)
    log(`centre crate ${crate.prize.id} to ${member.name}`)
    this.tell(`${member.name} broke the crate and took ${crate.prize.label}.`)
    if (member.alive && this.round.isLiving(member.id)) {
      this.grant(member, crate.prize)
    }
  }

  private clearCrate(): void {
    const crate = this.crate
    if (crate === undefined) {
      return
    }
    this.crate = undefined
    removeEntity(crate.entity)
    for (const mark of crate.marks) {
      mark.remove()
    }
  }

  /** The game gives a same-team melee hit no damage, so the mode sets it. */
  damage(hit: DamageEvent): DamageResult | void {
    const victim = this.byEntity.get(hit.victim)
    if (victim === undefined) {
      return
    }
    const attacker = this.byEntity.get(hit.attacker)
    if (
      !this.round.playing ||
      !this.round.isLiving(victim.id) ||
      attacker === victim ||
      (attacker !== undefined && !this.round.isLiving(attacker.id))
    ) {
      return { block: true }
    }
    victim.struck = attacker === undefined ? undefined : meleeOf(hit.flags)
    if (victim.struck !== undefined) {
      return { amount: meleeDamage(victim.struck) }
    }
    if (this.classOf(hit.ability) === swapClass) {
      return { amount: 0 }
    }
  }

  damaged(hit: DamagedEvent): void {
    const victim = this.byEntity.get(hit.victim)
    const attacker = this.byEntity.get(hit.attacker)
    if (victim === undefined || attacker === undefined || attacker === victim) {
      return
    }
    this.credit.hit(victim.id, attacker.id, this.now)
    attacker.damage += hit.healthLost
    const melee = victim.struck
    victim.struck = undefined
    if (hit.healthLost >= hit.healthBefore) {
      return
    }

    const left = hit.healthBefore - hit.healthLost
    const missing = 1 - left / victim.maxHealth
    const scale = this.round.knockScale()
    if (melee !== undefined) {
      const push = knock(
        attacker.position,
        victim.position,
        melee,
        missing,
        scale,
      )
      const ok = victim.player.setVelocity(push)
      // The game plays no impact for a same-team melee hit, so the mode does.
      victim.player.sound(
        melee === 'heavy'
          ? 'Ability.Melee.Impact.Heavy.Player'
          : 'Ability.Melee.Impact.Player',
      )
      log(
        `${melee} melee ${attacker.name} -> ${victim.name}: ${Math.round(hit.healthLost)} damage, knock ${Math.round(Math.hypot(push.x, push.y))} u/s ${ok ? 'applied' : 'REFUSED'}`,
      )
      return
    }
    if (hit.ability !== this.gunOf(attacker)) {
      log(
        `hit ${attacker.name} -> ${victim.name}: ${this.classOf(hit.ability) || 'unknown'}, ${Math.round(hit.healthLost)} damage`,
      )
    }
  }

  private seatBots(): void {
    if (this.botHeroes.size >= this.wantBots) {
      return
    }
    const taken = new Set([
      ...[...this.members.values()].map((member) => member.hero.name),
      ...[...this.botHeroes.values()].map((hero) => hero.name),
    ])
    const hero = assignHero(taken, this.roll)
    const name = `Bot ${this.botHeroes.size + 1}`
    this.botHeroes.set(name, hero)
    if (
      addBot({ name, team: this.smallerTeam(), hero: hero.name }) === undefined
    ) {
      log('a practice bot could not join')
    }
  }

  private read(): void {
    this.byEntity.clear()
    for (const member of this.members.values()) {
      const pawn = member.player.pawn()
      if (pawn === undefined || pawn.hero === 0) {
        // The game seats a new player without a hero; ask for theirs once.
        if (pawn !== undefined && !member.asked) {
          const side = teams.find((each) => each === pawn.team)
          member.asked =
            member.player.selectHero(
              member.hero.name,
              side ?? this.smallerTeam(),
            ) !== undefined
        }
        member.entity = 0
        member.alive = false
        continue
      }
      member.entity = pawn.entity
      if (pawn.hero !== member.hero.id) {
        const actual = pool.find((hero) => hero.id === pawn.hero)
        if (actual !== undefined) {
          member.hero = actual
        }
      }
      member.alive = pawn.health > 0
      member.position = pawn.position
      member.health = pawn.health
      member.maxHealth = Math.max(1, pawn.effectiveMaxHealth ?? pawn.maxHealth)
      member.stamina = pawn.stamina ?? 0
      member.maxStamina = pawn.maxStamina ?? 0
      member.points = pawn.abilityPoints
      member.unlocks = pawn.abilityUnlocks
      member.onTeam = pawn.team
      // A kill pays souls and levels, which unlock the hero's own abilities.
      if (pawn.souls > 0) {
        log(`${member.name} held ${pawn.souls} souls; taken back`)
        member.player.adjustSouls(-pawn.souls, true)
      }
      if (member.step === 'idle' || member.step === 'ready') {
        if (pawn.abilityPoints > 0 || pawn.abilityUnlocks > 0) {
          member.player.adjustAbilityPoints(
            -pawn.abilityPoints,
            -pawn.abilityUnlocks,
          )
        }
      }
      if (member.alive) {
        member.laid = false
      }
      this.byEntity.set(pawn.entity, member)
    }
  }

  private observe(movement: readonly MovementSample[]): void {
    for (const sample of movement) {
      const member = this.members.get(sample.player.slot)
      if (member === undefined) {
        continue
      }
      member.grounded = sample.grounded
      const crate = this.crate
      for (const done of sample.interactions) {
        if (
          crate !== undefined &&
          done.kind === 'propBroken' &&
          done.entity === crate.entity
        ) {
          this.opened(member)
        }
      }
    }
  }

  cast(event: AbilityCastEvent): void {
    const member = this.members.get(event.player.slot)
    const native = event.name
    if (this.devMode && member !== undefined) {
      log(
        `dev cast ${member.name}: ${native || '?'} slot ${event.slot} entity ${event.ability} target ${event.target}`,
      )
    }
    if (member === undefined || native === '') {
      return
    }
    const spent = member.inventory.spend(native, event.ability, this.now)
    if (spent === undefined) {
      return
    }
    if (spent.loot.role === 'force') {
      const target = this.byEntity.get(event.target)
      if (target !== undefined && target !== member) {
        this.credit.hit(target.id, member.id, this.now)
      } else {
        this.shove = { by: member.id, at: this.now }
      }
      log(
        `shove ${native} by ${member.name} at ${target === undefined || target === member ? 'nobody' : target.name}`,
      )
    }
    if (spent.lingers === undefined) {
      return
    }
    this.lock(member, native, spent.lingers)
    // A cooldown the game starts later, as a channel ends, runs as long, so
    // the drop cannot come ready again before its slot empties.
    this.pace(member, native, spent.lingers)
  }

  private lock(member: Member, native: string, seconds: number): void {
    member.player.setAbility({
      ability: native,
      cooldownEnd: this.now + seconds,
    })
  }

  /**
   * A cooldown set this way holds for that ability entity only, so a replaced
   * ability or a rebuilt item needs it again.
   */
  private pace(member: Member, native: string, seconds: number): void {
    if (!member.player.setAbility({ ability: native, cooldown: seconds })) {
      log(`cooldown of ${native} for ${member.name} REFUSED`)
    }
  }

  private smallerTeam(): number {
    const count = (side: number) =>
      [...this.members.values()].filter(
        (member) => member.entity !== 0 && member.onTeam === side,
      ).length
    return count(teams[1]) < count(teams[0]) ? teams[1] : teams[0]
  }

  private emptySlots(member: Member): void {
    for (const [slot, held] of member.inventory.held('ability').entries()) {
      if (held === undefined) {
        member.player.replaceAbility(slot, placeholders[slot] ?? '')
      }
    }
  }

  private lookAtEffects(): void {
    if (this.now < this.effectsAt) {
      return
    }
    const watching = [...this.members.values()].filter((member) =>
      member.inventory.watching(),
    )
    if (watching.length === 0) {
      return
    }
    this.effectsAt = this.now + effectSeconds
    const held: { ability: number; age: number }[] = []
    for (const member of this.members.values()) {
      if (member.alive && member.entity !== 0) {
        for (const modifier of modifiers(member.entity)) {
          if (modifier.ability !== 0) {
            held.push({ ability: modifier.ability, age: modifier.age })
          }
        }
      }
    }
    for (const member of watching) {
      member.inventory.observe(held, this.now)
    }
  }

  private empty(member: Member): void {
    for (const emptied of member.inventory.expire(this.now)) {
      log(
        `${member.name}'s spent ${emptied.native} ${emptied.playedOut ? 'played out' : 'timed out'} after ${emptied.after.toFixed(1)} s`,
      )
      if (emptied.kind === 'ability') {
        member.player.replaceAbility(
          emptied.slot,
          placeholders[emptied.slot] ?? '',
        )
      }
    }
    this.settleItems(member)
  }

  private settleItems(member: Member): void {
    const settled = member.inventory.settle(this.now)
    if (settled === 'rebuild') {
      this.rebuildItems(member)
      return
    }
    if (settled === undefined) {
      return
    }
    for (const held of member.inventory.held('item')) {
      if (held !== undefined && held.charges <= 0 && held.loot.native) {
        this.lock(member, held.loot.native, settled - this.now)
      }
    }
  }

  /** The game has no call to take one item away, so all are given again. */
  private rebuildItems(member: Member): void {
    member.player.clearItems()
    for (const [slot, held] of member.inventory.held('item').entries()) {
      if (held === undefined) {
        continue
      }
      if (held.charges <= 0) {
        member.inventory.clear('item', slot)
      } else if (held.loot.native !== undefined) {
        member.player.giveItem(held.loot.native)
        this.pace(member, held.loot.native, rules.chargeSeconds)
      }
    }
  }

  private enforceVoid(): void {
    if (!this.round.playing) {
      return
    }
    const floor = this.round.killZ(this.now)
    for (const member of this.members.values()) {
      if (!member.alive) {
        continue
      }
      if (!this.round.isLiving(member.id)) {
        log(`removing ${member.name}: alive but not in the round`)
        member.player.kill()
        member.alive = false
        continue
      }
      if (member.position.z >= floor) {
        continue
      }
      log(
        `${member.name} fell below the kill plane at z ${Math.round(member.position.z)}`,
      )
      const by = this.creditFor(member.id)
      const killer = by === undefined ? undefined : this.people.get(by)
      if (killer !== undefined && killer.entity !== 0) {
        killEntity({ victim: member.entity, attacker: killer.entity })
      } else {
        member.player.kill()
      }
      member.alive = false
    }
  }

  private views(): View[] {
    const views: View[] = []
    for (const member of this.members.values()) {
      if (member.entity !== 0) {
        views.push({
          id: member.id,
          alive: member.alive,
          healthFraction: member.health / member.maxHealth,
          damageDealt: member.damage,
        })
      }
    }
    return views
  }

  private apply(effect: Effect): void {
    switch (effect.kind) {
      case 'phase':
        log(
          `phase ${effect.phase}, round ${effect.round}, ${this.members.size} connected`,
        )
        this.announcePhase(effect)
        if (effect.phase === 'countdown') {
          this.credit.clear()
          this.before.clear()
          for (const standing of this.round.standings()) {
            this.before.set(standing.id, standing.points)
          }
        }
        break
      case 'seat': {
        const member = this.people.get(effect.id)
        if (member !== undefined) {
          log(
            `seat ${member.name} (${member.hero.label}) on pillar ${effect.pillar}`,
          )
          member.seat = effect.pillar
          member.damage = 0
          member.inventory = new Inventory()
          member.pity = freshPity()
          member.card = undefined
          member.step = 'revive'
          member.stepAt = this.now
        }
        break
      }
      case 'release':
        for (const member of this.members.values()) {
          member.player.freeze(false)
        }
        break
      case 'drop':
        for (const id of effect.ids) {
          const member = this.people.get(id)
          if (member?.alive) {
            const holding = new Set(
              [
                ...member.inventory.held('ability'),
                ...member.inventory.held('item'),
              ].flatMap((held) => (held === undefined ? [] : [held.loot.id])),
            )
            const loot = roll(
              this.roll,
              member.pity,
              effect.mobility,
              dropsFor(member.health < member.maxHealth),
              holding,
            )
            if (!member.bot) {
              log(`drop ${loot.id} to ${member.name}`)
            }
            this.grant(member, loot)
          }
        }
        break
      case 'eliminated': {
        const fallen = this.people.get(effect.id)?.name ?? 'A player'
        const by =
          effect.by === undefined ? undefined : this.people.get(effect.by)?.name
        log(`eliminated ${fallen} by ${by ?? 'nobody'}, place ${effect.place}`)
        this.tell(
          by === undefined ? `${fallen} fell.` : `${by} eliminated ${fallen}.`,
        )
        break
      }
      case 'finalStand':
        for (const [index, id] of effect.ids.entries()) {
          const member = this.people.get(id)
          if (member !== undefined) {
            this.toDeck(member, index, effect.ids.length)
          }
        }
        break
      case 'roundEnd': {
        const winner =
          effect.winner === undefined
            ? undefined
            : this.people.get(effect.winner)
        log(`round ${effect.round} won by ${winner?.name ?? 'nobody'}`)
        break
      }
      case 'matchEnd': {
        const [first] = effect.standings
        const name =
          first === undefined ? undefined : this.people.get(first.id)?.name
        log(`match won by ${name ?? 'nobody'}, ${first?.points ?? 0} points`)
        break
      }
    }
  }

  private ready(member: Member): void {
    if (member.step === 'ready') {
      this.keepOnPillar(member)
      return
    }
    if (member.step === 'idle' || this.now < member.stepAt) {
      return
    }
    if (this.round.phase !== 'countdown') {
      member.step = 'idle'
      return
    }
    member.stepAt = this.now + stepSeconds
    if (member.step === 'revive') {
      if (member.entity === 0) {
        return
      }
      if (!member.alive) {
        member.player.respawn()
        return
      }
      member.player.unwatch()
      member.watching = -1
      // A revived hero appears at the map's origin, inside the centre column,
      // so it goes to its pillar at once and again after each later step.
      this.toPillar(member)
      member.step = 'reset'
      return
    }
    if (!member.alive) {
      return
    }
    if (member.step === 'reset') {
      member.player.resetHero(0)
      this.toPillar(member)
      member.step = 'place'
      return
    }
    this.toPillar(member)
    member.player.freeze(true)
    member.player.clearItems()
    if (member.points > 0 || member.unlocks > 0) {
      member.player.adjustAbilityPoints(-member.points, -member.unlocks)
    }
    this.givePips(member, rules.startStamina)
    member.gun = 0
    this.emptySlots(member)
    this.endEndless(member)
    member.reserve = 0
    this.setClip(member, member.hero.clip)
    member.step = 'ready'
  }

  private toPillar(member: Member): void {
    standOn(member.player, pillarStand(member.seat), facingCentre(member.seat))
  }

  private keepOnPillar(member: Member): void {
    if (this.round.phase !== 'countdown' || !member.alive) {
      return
    }
    const top = pillarStand(member.seat)
    const off = Math.hypot(member.position.x - top.x, member.position.y - top.y)
    if (member.position.z < top.z - sunk || off > arena.topSize / 2) {
      log(
        `${member.name} stood at ${Math.round(member.position.x)} ${Math.round(member.position.y)} ${Math.round(member.position.z)} in the countdown; back onto pillar ${member.seat}`,
      )
      this.toPillar(member)
    }
  }

  /** The dead hero is kept; unseating the player crashes clients. */
  private bury(member: Member): void {
    if (member.entity === 0 || member.alive) {
      return
    }
    if (!member.laid) {
      // The game schedules a respawn on every death; cancel it once.
      writeField(
        member.entity,
        'CCitadelPlayerPawn',
        'm_flRespawnTime',
        'float32',
        0,
      )
      member.laid = true
      member.watching = -1
      member.graveAt = 0
      member.player.clearItems()
      member.inventory = new Inventory()
      this.endEndless(member)
    }
    if (this.now >= member.graveAt) {
      member.graveAt = this.now + graveSeconds
      const away = Math.hypot(
        member.position.x - grave.x,
        member.position.y - grave.y,
        member.position.z - grave.z,
      )
      if (away > 200) {
        const moved = member.player.teleport(grave, {
          pitch: 0,
          yaw: 0,
          roll: 0,
        })
        log(
          `grave: ${member.name} lay at ${Math.round(member.position.x)} ${Math.round(member.position.y)} ${Math.round(member.position.z)}, ${moved ? 'moved' : 'MOVE REFUSED'}`,
        )
      }
    }
    if (member.bot || !this.round.playing) {
      return
    }
    const current = this.people.get(member.watching)
    if (current?.alive && this.round.isLiving(member.watching)) {
      return
    }
    const target = this.round
      .survivors()
      .map((id) => this.people.get(id))
      .find((other) => other !== undefined && other.alive && other !== member)
    if (target !== undefined && member.player.watch(target.entity, true)) {
      member.watching = target.id
    }
  }

  private creditFor(victim: PlayerId): PlayerId | undefined {
    const hitter = this.credit.of(victim, this.now)
    if (hitter !== undefined) {
      return hitter
    }
    const shove = this.shove
    return shove !== undefined &&
      shove.by !== victim &&
      this.now - shove.at <= shoveSeconds
      ? shove.by
      : undefined
  }

  private classOf(ability: number): string {
    if (ability === 0) {
      return ''
    }
    let name = this.classes.get(ability)
    if (name === undefined) {
      name = entityClass(ability)?.className ?? ''
      this.classes.set(ability, name)
    }
    return name
  }

  private endEndless(member: Member): void {
    if (member.endlessUntil === 0) {
      return
    }
    member.endlessUntil = 0
    holdModifierState(member.entity, endlessClip, false)
  }

  private grant(member: Member, loot: Loot): void {
    let where = 'Used at once'
    let charges = 1
    if (loot.kind === 'heal') {
      member.player.heal(combat.medkitHealth)
    } else if (loot.kind === 'infinite') {
      holdModifierState(member.entity, endlessClip)
      member.endlessUntil = this.now + combat.infiniteSeconds
    } else if (loot.kind === 'buff') {
      member.player.giveModifier(
        `${loot.native}/${loot.modifier}`,
        loot.lasts ?? lingerSeconds,
      )
    } else if (loot.kind === 'ammo') {
      member.reserve = reserveAfter(member.hero, member.reserve)
      where = `Reserve ${member.reserve} · reload with R`
    } else if (loot.kind === 'stamina') {
      this.givePips(member, Math.floor(member.pips + staminaSlack) + 1)
    } else if (loot.native !== undefined) {
      const gain = member.inventory.add(loot)
      if (gain === undefined) {
        return
      }
      if (gain.stacked) {
        member.player.refreshAbility(loot.native)
        this.pace(member, loot.native, rules.chargeSeconds)
      } else if (gain.kind === 'ability') {
        member.player.replaceAbility(gain.slot, loot.native)
        member.player.setAbility({ ability: loot.native, upgrades: 1 })
        this.pace(member, loot.native, rules.chargeSeconds)
      } else if (gain.replaced !== undefined) {
        this.settleItems(member)
      } else {
        member.player.giveItem(loot.native)
        this.pace(member, loot.native, rules.chargeSeconds)
      }
      where = `${gain.kind === 'ability' ? 'Ability' : 'Item'} ${gain.slot + 1}`
      charges = member.inventory.held(gain.kind)[gain.slot]?.charges ?? 1
    }
    member.card = {
      serial: ++this.drops,
      label: loot.label,
      role: loot.role,
      hint: loot.hint,
      item: loot.kind === 'ability' ? undefined : loot.native,
      where,
      charges,
    }
    member.cardUntil = this.now + cardSeconds
  }

  private toDeck(member: Member, index: number, count: number): void {
    const spot = deckSpot(index, count)
    const yaw = count <= 1 ? 0 : (Math.atan2(-spot.y, -spot.x) * 180) / Math.PI
    standOn(member.player, spot, yaw)
    this.givePips(member, 0)
    const gone = member.inventory.drop((loot) => loot.role === 'mobility')
    if (gone.some((loot) => loot.kind === 'ability')) {
      this.emptySlots(member)
    }
    if (gone.some((loot) => loot.kind === 'item')) {
      this.rebuildItems(member)
    }
  }

  private gunOf(member: Member): number {
    if (member.gunOf !== member.entity || member.gun === 0) {
      member.gunOf = member.entity
      member.gun =
        member.player.abilities().find((ability) => ability.slot === gunSlot)
          ?.entity ?? 0
    }
    return member.gun
  }

  private clip(member: Member): number {
    const gun = this.gunOf(member)
    const rounds =
      gun === 0 ? undefined : readField(gun, gunClass, 'm_iClip', 'int32')
    if (typeof rounds !== 'number') {
      // The hero was given a new gun; find it again next frame.
      member.gun = 0
      return 0
    }
    return rounds
  }

  private setClip(member: Member, rounds: number): void {
    // A rebuilt hero has a new gun; look it up again when the old one is gone.
    for (let attempt = 0; attempt < 2; attempt++) {
      const gun = this.gunOf(member)
      if (gun === 0) {
        return
      }
      if (writeField(gun, gunClass, 'm_iClip', 'int32', rounds)) {
        member.lastClip = rounds
        return
      }
      member.gun = 0
    }
  }

  private announcePhase(effect: Extract<Effect, { kind: 'phase' }>): void {
    switch (effect.phase) {
      case 'countdown':
        this.announce(
          `ROUND ${effect.round} OF ${rules.rounds}`,
          'Last one standing wins. Drops decide the rest.',
        )
        break
      case 'live':
        this.tell('Go!')
        break
      case 'overtime':
        this.announce(
          'OVERTIME',
          'Faster drops, harder hits, and the void is rising.',
        )
        break
      case 'final':
        this.announce(
          'FINAL STAND',
          `Everyone to the centre. Top of the deck is ${Math.round((2 * arena.centreRadius) / unitsPerMetre)} m wide.`,
        )
        break
    }
  }

  private announce(title: string, text: string): void {
    for (const member of this.members.values()) {
      if (!member.bot) {
        member.player.announce(title, text)
      }
    }
  }

  private tell(text: string): void {
    for (const member of this.members.values()) {
      if (!member.bot) {
        toast(member.player, text)
      }
    }
  }
}
