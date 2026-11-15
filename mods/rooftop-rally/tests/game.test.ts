import { beforeEach, expect, test } from 'bun:test'
import * as sdk from '../.tools/modlock/js/src/index'
import { bind } from '../.tools/modlock/js/src/host'
import {
  Call,
  Reply,
  ServerCommandRequest,
} from '../.tools/modlock/src/wasm/wasm.pb'
import {
  BotResponse,
  HeroResponse,
  PawnResponse,
  PlayerRequest,
  SelectHeroRequest,
  WatchRequest,
  type Pawn,
} from '../.tools/modlock/src/wasm/players/players.pb'
import {
  AbilitiesResponse,
  AbilityOptions,
} from '../.tools/modlock/src/wasm/abilities/abilities.pb'
import { specialCarrier, type SpecialId } from '../gameplay/special'
import { ObjectResponse } from '../.tools/modlock/src/wasm/objects/objects.pb'
import { TeleportRequest } from '../.tools/modlock/src/wasm/movement/movement.pb'
import {
  FieldResponse,
  FieldType,
  ReadFieldRequest,
  WriteFieldRequest,
  type FieldValue,
} from '../.tools/modlock/src/wasm/fields/fields.pb'
import {
  EntitiesResponse,
  EntityClassResponse,
  EntityRequest,
  FindEntitiesRequest,
} from '../.tools/modlock/src/wasm/entities/entities.pb'
import {
  HitOptions,
  KillOptions,
} from '../.tools/modlock/src/wasm/combat/combat.pb'
import { Kind, UiRequest, type Node } from '../.tools/modlock/src/wasm/ui/ui.pb'

import { Game, playerId } from '../gameplay/game'
import { PracticeOpponent } from '../gameplay/practice'

const pawns = new Map<number, Pawn>()
const calls: { method: string; request: Uint8Array }[] = []
let objectId = 0
let botSlot = 2
const leftUiSlots = new Set<number>()
const screens = new Map<number, Map<string, Node>>()
const controllers = new Set<number>()
/** heroEntities are the hero pawns the game lists as 'player' entities. */
const heroEntities = new Set<number>()
const fields = new Map<string, FieldValue>()
const classes = new Map<number, string>()
let refuseWatch = false
let refuseSelection = false

beforeEach(() => {
  for (let slot = 0; slot < 4; slot++) sdk.Player.release(slot)
  pawns.clear()
  calls.length = 0
  objectId = 0
  botSlot = 2
  leftUiSlots.clear()
  screens.clear()
  controllers.clear()
  heroEntities.clear()
  fields.clear()
  classes.clear()
  refuseWatch = false
  refuseSelection = false
  bind((bytes) => {
    const call = Call.fromBinary(bytes)
    const method = call.method ?? ''
    const request = call.request ?? new Uint8Array()
    calls.push({ method, request })
    let response: Uint8Array = new Uint8Array()
    if (method === 'Ui') {
      const ui = UiRequest.fromBinary(request)
      const slot = ui.player ?? 0
      if (leftUiSlots.has(slot) && !ui.change?.reset)
        return Reply.toBinary({
          error: 'the player left; send their whole interface with a reset',
        })
      if (ui.change?.reset) leftUiSlots.delete(slot)
      const tree = ui.change?.reset
        ? new Map<string, Node>()
        : (screens.get(slot) ?? new Map<string, Node>())
      for (const id of ui.change?.removed ?? []) tree.delete(id)
      for (const node of ui.change?.set ?? []) tree.set(node.id ?? '', node)
      screens.set(slot, tree)
    }
    if (method === 'Watch' && refuseWatch)
      return Reply.toBinary({ error: 'camera not ready' })
    if (method === 'SelectHero' && refuseSelection)
      return Reply.toBinary({ error: 'hero not ready' })
    if (method === 'Watch') {
      const watch = WatchRequest.fromBinary(request)
      const hero = pawns.get(watch.player ?? 0)?.entity
      for (const controller of controllers) {
        const owned = fields.get(
          `${controller}:CCitadelPlayerController:m_hHeroPawn`,
        )
        const active = fields.get(`${controller}:CBasePlayerController:m_hPawn`)
        if (
          owned?.value?.case === 'number' &&
          owned.value.value === hero &&
          active?.value?.case === 'number' &&
          watch.target !== undefined
        )
          field(
            active.value.value,
            'CPlayer_ObserverServices',
            'm_hObserverTarget',
            watch.target,
          )
      }
    } else if (method === 'SelectHero')
      response = HeroResponse.toBinary({ hero: 27 })
    else if (method === 'FindEntities') {
      const className = FindEntitiesRequest.fromBinary(request).className
      response = EntitiesResponse.toBinary({
        entities:
          className === 'citadel_player_controller'
            ? [...controllers]
            : className === 'player'
              ? [...heroEntities]
              : [],
      })
    } else if (method === 'ReadField') {
      const read = ReadFieldRequest.fromBinary(request)
      response = FieldResponse.toBinary({
        value:
          read.type === FieldType.HANDLE ||
          read.type === FieldType.FLOAT32 ||
          read.type === FieldType.INT32
            ? fields.get(`${read.entity}:${read.className}:${read.field}`)
            : undefined,
      })
    } else if (method === 'WriteField') {
      const write = WriteFieldRequest.fromBinary(request)
      if (write.value)
        fields.set(
          `${write.entity}:${write.className}:${write.field}`,
          write.value,
        )
    } else if (method === 'KillEntity') {
      const victim = KillOptions.fromBinary(request).victim
      for (const [slot, pawn] of pawns) {
        if (victim !== undefined && pawn.entity === victim) {
          pawns.set(slot, { ...pawn, health: 0 })
          field(victim, 'CCitadelPlayerPawn', 'm_flRespawnTime', 15)
        }
      }
    } else if (method === 'EntityClass') {
      const className = classes.get(
        EntityRequest.fromBinary(request).entity ?? 0,
      )
      response = EntityClassResponse.toBinary({
        name: className ? { className } : undefined,
      })
    } else if (method === 'Pawn')
      response = PawnResponse.toBinary({
        pawn: pawns.get(PlayerRequest.fromBinary(request).player ?? 0),
      })
    else if (method === 'Abilities')
      response = AbilitiesResponse.toBinary({
        abilities: [
          {
            name: specialCarrier,
            entity: 1000 + (PlayerRequest.fromBinary(request).player ?? 0),
            slot: 2,
          },
        ],
      })
    else if (method === 'CreateParticle')
      response = ObjectResponse.toBinary({ object: ++objectId })
    else if (method === 'AddBot')
      response = BotResponse.toBinary({ player: botSlot })
    return Reply.toBinary({ response })
  })
})

function join(
  game: Game,
  slot: number,
  bot = false,
  generation = 1,
  choice: SpecialId | null = 'powerSlash',
): sdk.Connection {
  const connection: sdk.Connection = {
    player: sdk.Player.of(slot),
    bot,
    generation,
    ready: true,
    name: bot ? 'Practice Yamato' : `Human ${slot}`,
    steamId: bot ? 0n : BigInt(slot + 1),
    roles: [],
  }
  pawns.set(slot, {
    entity: slot + 10 * generation,
    hero: 27,
    health: 100,
    maxHealth: 100,
    generation,
    position: { x: slot ? -600 : 600, y: 0, z: 0 },
    eyeAngles: { pitch: 0, yaw: 0, roll: 0 },
  })
  game.join(connection)
  if (!bot && choice) game.choose(connection.player, choice)
  const seat = game.seats.get(playerId(connection))
  if (!seat) throw new Error('Join did not create a seat')
  seat.state = { kind: 'playing', entity: slot + 10 * generation }
  game.round.living.add(playerId(connection))
  return connection
}

function serving(choice: SpecialId = 'powerSlash'): {
  game: Game
  human: sdk.Connection
} {
  const game = new Game()
  const human = join(game, 0, false, 1, choice)
  join(game, 1)
  game.round.phase = {
    kind: 'serve',
    target: playerId(human),
    until: 100,
    position: { x: 0, y: 0, z: 100 },
  }
  return { game, human }
}

test('the mode leaves the starting souls of the next match on this client alone', () => {
  new Game().start()
  const commands = calls
    .filter((c) => c.method === 'ServerCommand')
    .map((c) => ServerCommandRequest.fromBinary(c.request).command ?? '')
  expect(commands).toContain('citadel_allow_duplicate_heroes 1')
  expect(
    commands.filter((command) =>
      command.startsWith('citadel_player_starting_gold'),
    ),
  ).toEqual([])
})

test('a press and release before a frame activate at that frame clock when cooldown expires', () => {
  const { game, human } = serving()
  game.frame(10)
  game.input(human.player, sdk.Buttons.attack, 0n)
  game.input(human.player, 0n, sdk.Buttons.attack)
  game.frame(10.015625)
  const block = game.seats.get(playerId(human))?.block
  expect(block?.window?.started).toBe(10.015625)
  game.frame(10.8125)
  game.input(human.player, sdk.Buttons.parry, 0n)
  game.input(human.player, 0n, sdk.Buttons.parry)
  game.frame(10.828125)
  expect(block?.window?.started).toBe(10.828125)
  game.frame(11.7)
  expect(block?.window?.started).toBe(10.828125)
})

test('a new press cannot erase protection earlier in a long frame or save an earlier hit', () => {
  for (const oldWindow of [true, false]) {
    const { game, human } = serving()
    game.frame(10)
    if (oldWindow) game.block(human.player)
    game.round.phase = {
      kind: 'flight',
      target: playerId(human),
      selectedAt: 9,
      safeUntil: 9,
      position: { x: 751, y: 0, z: 65 },
      velocity: { x: -10_000, y: 0, z: 0 },
      power: 0,
      orbitSeconds: 0,
      enteredBlockSphere: false,
    }
    game.input(human.player, sdk.Buttons.attack, 0n)
    game.input(human.player, 0n, sdk.Buttons.attack)
    game.frame(11)
    expect(game.round.living.has(playerId(human))).toBe(oldWindow)
    expect(game.round.phase).toMatchObject({
      kind: oldWindow ? 'flight' : 'intermission',
    })
  }
})

test('a new world forgets expired objects and penalties, then starts a fresh round for remaining players', () => {
  const { game, human } = serving()
  game.frame(10)
  game.block(human.player)
  const oldObjects = objectId
  const seat = game.seats.get(playerId(human))
  if (!seat) throw new Error('Missing player')
  seat.penalty = { entity: 10, until: 50 }
  game.world()
  expect(game.round.phase.kind).toBe('waiting')
  expect(game.round.living.size).toBe(0)
  expect(seat.penalty).toBeUndefined()
  expect(seat.block.window).toBeUndefined()
  calls.length = 0
  for (const seat of game.seats.values())
    game.choose(seat.connection.player, 'powerSlash')
  for (const time of [0, 0.1, 0.3, 3, 3.1, 3.3]) game.frame(time)
  expect(game.round.phase.kind).toBe('serve')
  expect(game.round.living.size).toBe(2)
  expect(objectId).toBeGreaterThan(oldObjects)
  expect(calls.some((c) => c.method === 'RemoveObject')).toBe(false)
})

test('practice bot departure allows replacement and never blocks for a human reusing its slot', () => {
  const game = new Game()
  join(game, 0)
  const practice = new PracticeOpponent()
  practice.enabled = true
  practice.frame(1, game)
  const bot = join(game, botSlot, true)
  practice.frame(1.1, game)
  expect(calls.some((c) => c.method === 'Drive')).toBe(true)

  practice.leave(bot)
  game.leave(bot)
  sdk.Player.release(botSlot)
  const human = join(game, botSlot, false, 2)
  game.round.phase = {
    kind: 'flight',
    target: playerId(human),
    selectedAt: 1.2,
    safeUntil: 1.2,
    position: { x: -600, y: 0, z: 65 },
    velocity: { x: 0, y: 0, z: 0 },
    power: 0,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  botSlot = 3
  calls.length = 0
  practice.frame(2, game)
  expect(calls.some((c) => c.method === 'AddBot')).toBe(true)
  expect(
    calls.some((c) => c.method === 'Drive' || c.method === 'CreateParticle'),
  ).toBe(false)
  expect(game.block(bot.player)).toBe(false)
  expect(game.seats.get(playerId(human))?.block.window).toBeUndefined()
})

test('a world reset replaces the practice bot and drops its old input state', () => {
  const game = new Game()
  const practice = new PracticeOpponent()
  practice.enabled = true
  practice.frame(1, game)
  practice.reset()
  calls.length = 0
  practice.frame(0.5, game)
  expect(calls.some((c) => c.method === 'AddBot')).toBe(false)
  practice.frame(1, game)
  expect(calls.some((c) => c.method === 'AddBot')).toBe(true)
})

test('a bot waits for its AddBot pawn rather than calling the human hero selector', () => {
  const game = new Game()
  const connection = join(game, 2, true)
  game.leave(connection)
  pawns.delete(2)
  calls.length = 0
  game.join(connection)
  game.frame(2)
  expect(calls.some((c) => c.method === 'SelectHero')).toBe(false)
  expect(game.seats.get(playerId(connection))?.state.kind).toBe('spawning')
})

function movement(
  connection: sdk.Connection,
  dashing: boolean,
): sdk.MovementSample {
  const pawn = connection.player.pawn()
  if (!pawn) throw new Error('Missing pawn')
  const zero = { x: 0, y: 0, z: 0 }
  return {
    player: connection.player,
    pawn: pawn.entity,
    position: pawn.position,
    velocity: zero,
    grounded: true,
    sliding: false,
    mantling: false,
    climbing: false,
    dashing,
    jumpAbility: 0,
    wallJumps: 0,
    mantleAbility: 0,
    mantleStart: 0,
    wallContact: zero,
    wallNormal: zero,
    wallJumpNormal: zero,
    wallJumpFacing: 0,
    actions: dashing ? ['groundDash'] : [],
    casts: [],
    interactions: [],
    command: {
      held: 0n,
      changed: 0n,
      scroll: 0n,
      forward: 0,
      left: 1,
      up: 0,
      grounded: true,
    },
  }
}

test('a choice is validated, retained across reconnect, and discarded on a new world', () => {
  const game = new Game()
  const human = join(game, 0, false, 1, null)
  expect(game.choose(human.player, 'unknown')).toBe(false)
  expect(game.choose(human.player, 'blink')).toBe(true)
  expect(game.choose(human.player, 'timeFreeze')).toBe(false)
  game.leave(human)
  sdk.Player.release(0)
  const replacement = join(game, 0, false, 2, null)
  expect(game.seats.get(playerId(replacement))?.special.choice).toBe('blink')
  expect(game.choose(human.player, 'powerSlash')).toBe(false)
  game.world()
  expect(game.seats.get(playerId(replacement))?.special.choice).toBeUndefined()
})

test('rejoining sends a fresh interface before any cached HUD delta', () => {
  const { game, human } = serving('blink')
  game.frame(10)
  game.leave(human)
  leftUiSlots.add(human.player.slot)
  sdk.Player.release(human.player.slot)
  const reconnect = {
    ...human,
    generation: 2,
    player: sdk.Player.of(human.player.slot),
  }
  calls.length = 0
  expect(() => game.join(reconnect)).not.toThrow()
  const ui = calls
    .filter((call) => call.method === 'Ui')
    .map((call) => UiRequest.fromBinary(call.request))
  expect(ui[0]?.change?.reset).toBe(true)
  expect(game.seats.get(playerId(reconnect))?.special.choice).toBe('blink')
})

test('a new round restores the camera after the dead hero has respawned', () => {
  const { game, spectator: human, pawn } = spectatorGame()
  nativeCamera()
  game.frame(0)
  expect(watches()).toHaveLength(1)
  calls.length = 0
  game.round.phase = { kind: 'countdown', until: 10 }
  game.frame(10)
  expect(game.seats.get(playerId(human))?.state.kind).toBe('spawning')
  expect(
    calls.some(
      (call) =>
        call.method === 'Respawn' &&
        (PlayerRequest.fromBinary(call.request).player ?? 0) ===
          human.player.slot,
    ),
  ).toBe(true)
  expect(calls.some((call) => call.method === 'Unwatch')).toBe(false)
  calls.length = 0
  pawns.set(human.player.slot, { ...pawn, health: 100 })
  game.frame(10.1)
  expect(
    calls.some(
      (call) =>
        call.method === 'Unwatch' &&
        (PlayerRequest.fromBinary(call.request).player ?? 0) ===
          human.player.slot,
    ),
  ).toBe(true)
  game.frame(10.3)
  expect(game.seats.get(playerId(human))?.state.kind).toBe('playing')
})

function field(
  entity: number,
  className: string,
  name: string,
  value: number,
): void {
  fields.set(`${entity}:${className}:${name}`, {
    value: { case: 'number', value },
  })
}

function nativeCamera(hero = 12, camera = 82, controller = 72): void {
  controllers.add(controller)
  field(controller, 'CCitadelPlayerController', 'm_hHeroPawn', hero)
  field(controller, 'CBasePlayerController', 'm_hPawn', camera)
  classes.set(camera, 'CCitadelObserverPawn')
}

function spectatorGame(bot = false) {
  const { game, human } = serving()
  const spectator: sdk.Connection = {
    ...human,
    player: sdk.Player.of(2),
    steamId: bot ? 0n : 3n,
    bot,
  }
  const pawn = { entity: 12, hero: 27, health: 0, generation: 1 } satisfies Pawn
  pawns.set(2, pawn)
  game.join(spectator)
  calls.length = 0
  return { game, spectator, pawn }
}

function watches() {
  return calls
    .filter((call) => call.method === 'Watch')
    .map((call) => WatchRequest.fromBinary(call.request))
}

function nativeRespawnTick(now: number): void {
  for (const [slot, pawn] of pawns) {
    const timer = fields.get(
      `${pawn.entity}:CCitadelPlayerPawn:m_flRespawnTime`,
    )?.value
    if (
      (pawn.health ?? 0) <= 0 &&
      timer?.case === 'number' &&
      timer.value > 0 &&
      timer.value <= now
    )
      pawns.set(slot, { ...pawn, health: pawn.maxHealth ?? 100 })
  }
}

test('elimination disables the native respawn timer until the next round', () => {
  const { game, human } = serving()
  join(game, 2)
  const pawn = pawns.get(0)
  if (!pawn) throw new Error('Missing player')
  pawns.set(0, { ...pawn, position: { x: 5000, y: 0, z: 0 } })
  game.round.phase = {
    kind: 'serve',
    target: '1:1',
    until: 100,
    position: { x: 0, y: 0, z: 100 },
  }
  game.frame(0)
  expect(game.round.living.has(playerId(human))).toBe(false)
  expect(pawns.get(0)?.health).toBe(0)
  nativeCamera(10, 80, 70)
  for (const now of [1, 2, 16, 30]) {
    nativeRespawnTick(now)
    expect(pawns.get(0)?.health).toBe(0)
    game.frame(now)
  }
  expect(calls.filter((call) => call.method === 'KillEntity')).toHaveLength(1)
  expect(calls.some((call) => call.method === 'Respawn')).toBe(false)
  calls.length = 0
  game.round.phase = { kind: 'countdown', until: 31 }
  game.frame(31)
  expect(
    calls.some(
      (call) =>
        call.method === 'Respawn' &&
        (PlayerRequest.fromBinary(call.request).player ?? 0) === 0,
    ),
  ).toBe(true)
  pawns.set(0, { ...pawn, health: 100 })
  game.frame(31.1)
  game.frame(31.3)
  expect(game.seats.get(playerId(human))?.state.kind).toBe('playing')
})

test('an already dead player has its native respawn timer disabled on elimination', () => {
  const { game } = serving()
  join(game, 2)
  const pawn = pawns.get(0)
  if (!pawn) throw new Error('Missing player')
  pawns.set(0, { ...pawn, health: 0 })
  field(10, 'CCitadelPlayerPawn', 'm_flRespawnTime', 15)
  game.frame(0)
  nativeRespawnTick(16)
  expect(pawns.get(0)?.health).toBe(0)
  expect(calls.some((call) => call.method === 'KillEntity')).toBe(false)
})

test('a live mid-round arrival stays dead after entering spectating', () => {
  const { game, pawn } = spectatorGame()
  pawns.set(2, { ...pawn, health: 100 })
  game.frame(0)
  nativeCamera()
  for (const now of [1, 16, 30]) {
    nativeRespawnTick(now)
    expect(pawns.get(2)?.health).toBe(0)
    game.frame(now)
  }
  expect(calls.filter((call) => call.method === 'KillEntity')).toHaveLength(1)
  expect(watches()).toHaveLength(1)
})

test('an already dead mid-round arrival stays dead past its native respawn deadline', () => {
  const { game, pawn } = spectatorGame()
  field(pawn.entity, 'CCitadelPlayerPawn', 'm_flRespawnTime', 15)
  nativeCamera()
  game.frame(0)
  for (const now of [1, 16, 30]) {
    nativeRespawnTick(now)
    expect(pawns.get(2)?.health).toBe(0)
    game.frame(now)
  }
  expect(calls.some((call) => call.method === 'KillEntity')).toBe(false)
  expect(watches()).toHaveLength(1)
})

test('mid-round reconnect retries missing, hero-zero, and wrong-hero pawns without killing placeholders', () => {
  const { game, spectator, pawn } = spectatorGame()
  game.leave(spectator)
  sdk.Player.release(2)
  const reconnect = {
    ...spectator,
    player: sdk.Player.of(2),
    generation: 2,
  }
  pawns.delete(2)
  refuseSelection = true
  game.join(reconnect)
  game.frame(0)
  game.frame(0.2)
  pawns.set(2, { ...pawn, hero: 0, health: 100, generation: 2 })
  refuseSelection = false
  game.frame(1)
  game.frame(1.2)
  game.frame(2)
  pawns.set(2, { ...pawn, hero: 1, health: 100, generation: 2 })
  game.frame(3)
  const selections = calls
    .filter((call) => call.method === 'SelectHero')
    .map((call) => SelectHeroRequest.fromBinary(call.request))
  expect(selections).toHaveLength(4)
  expect(selections.every((selection) => selection.player === 2)).toBe(true)
  expect(selections.every((selection) => selection.team === 2)).toBe(true)
  expect(calls.some((call) => call.method === 'KillEntity')).toBe(false)
  expect(watches()).toHaveLength(0)
})

test('spectator repair kills only the ready Yamato and waits for a later dead snapshot before watching', () => {
  const { game, pawn } = spectatorGame()
  nativeCamera()
  pawns.set(2, { ...pawn, health: 100 })
  game.frame(0)
  game.frame(0.2)
  expect(
    calls
      .filter((call) => call.method === 'KillEntity')
      .map((call) => KillOptions.fromBinary(call.request).victim),
  ).toEqual([12])
  expect(watches()).toHaveLength(0)
  pawns.set(2, pawn)
  game.frame(1)
  expect(watches()).toHaveLength(1)
  expect(calls.some((call) => call.method === 'SelectHero')).toBe(false)
})

test('dead spectator waits for its own retained hero and active native observer pawn', () => {
  const { game } = spectatorGame()
  game.frame(0)
  nativeCamera(99)
  game.frame(1)
  field(72, 'CCitadelPlayerController', 'm_hHeroPawn', 12)
  field(72, 'CBasePlayerController', 'm_hPawn', 12)
  game.frame(2)
  field(72, 'CBasePlayerController', 'm_hPawn', 0xffffffff)
  game.frame(3)
  expect(
    calls.some(
      (call) =>
        call.method === 'EntityClass' &&
        EntityRequest.fromBinary(call.request).entity === 0xffffffff,
    ),
  ).toBe(false)
  field(72, 'CBasePlayerController', 'm_hPawn', 83)
  game.frame(4)
  classes.set(83, 'CCitadelPlayerPawn')
  game.frame(5)
  fields.set('72:CBasePlayerController:m_hPawn', {
    value: { case: 'text', value: '83' },
  })
  game.frame(6)
  expect(watches()).toHaveLength(0)
  nativeCamera()
  // The dead hero no longer owns m_hController after native camera rebinding.
  field(12, 'CBasePlayerPawn', 'm_hController', 0xffffffff)
  game.frame(7)
  expect(watches()).toEqual([{ player: 2, target: 10 }])
})

test('a successful watch leaves native target and view choices alone for the same hero and camera', () => {
  const { game } = spectatorGame()
  join(game, 3)
  nativeCamera()
  game.frame(0)
  expect(watches()).toEqual([{ player: 2, target: 10 }])
  field(82, 'CPlayer_ObserverServices', 'm_hObserverTarget', 13)
  field(82, 'CPlayer_ObserverServices', 'm_iObserverMode', 3)
  game.round.living.delete('1:1')
  game.round.living.add('1:1')
  pawns.set(0, { ...pawns.get(0), entity: 10, hero: 27, health: 0 })
  for (const now of [0.1, 0.5, 1, 2, 3]) game.frame(now)
  expect(watches()).toEqual([{ player: 2, target: 10 }])
})

test('native cycling past the eliminated hero continues to another living player', () => {
  const { game } = spectatorGame()
  nativeCamera()
  game.frame(0)
  field(82, 'CPlayer_ObserverServices', 'm_hObserverTarget', 12)
  game.frame(0.1)
  expect(watches()).toEqual([
    { player: 2, target: 10 },
    { player: 2, target: 11 },
  ])
  game.frame(0.2)
  game.frame(2)
  expect(watches()).toHaveLength(2)
})

test('spectating transfers away from a target who dies or leaves the round', () => {
  const { game } = spectatorGame()
  join(game, 3)
  nativeCamera()
  game.frame(0)
  field(82, 'CPlayer_ObserverServices', 'm_hObserverTarget', 13)
  game.frame(0.1)
  game.round.living.delete('3:1')
  game.frame(0.2)
  expect(watches()).toEqual([
    { player: 2, target: 10 },
    { player: 2, target: 10 },
  ])
  pawns.set(0, { ...pawns.get(0), entity: 10, hero: 27, health: 0 })
  game.frame(0.3)
  expect(watches().at(-1)?.target).toBe(11)
})

test('watch failures retry at most once per second and successful attachment survives until its camera or hero changes', () => {
  const { game, pawn } = spectatorGame()
  nativeCamera()
  refuseWatch = true
  game.frame(0)
  game.frame(0.2)
  game.frame(0.9)
  expect(watches()).toHaveLength(1)
  refuseWatch = false
  game.frame(1)
  fields.delete('72:CBasePlayerController:m_hPawn')
  game.frame(2)
  expect(watches()).toHaveLength(2)
  nativeCamera()
  game.frame(3)
  expect(watches()).toHaveLength(2)
  nativeCamera(12, 84)
  game.frame(4)
  game.frame(5)
  expect(watches()).toHaveLength(3)
  pawns.set(2, { ...pawn, entity: 22 })
  nativeCamera(22, 84)
  game.frame(6)
  game.frame(7)
  expect(watches()).toHaveLength(4)
})

test('spectator waits without a living Yamato target and attaches when one appears', () => {
  const { game } = spectatorGame()
  game.round.phase = { kind: 'intermission', until: 100, winner: undefined }
  game.round.living.clear()
  game.round.living.add('2:1')
  nativeCamera()
  game.frame(0)
  game.round.living.add('0:1')
  pawns.set(0, { ...pawns.get(0), entity: 10, hero: 0, health: 100 })
  game.frame(1)
  expect(watches()).toHaveLength(0)
  pawns.set(0, { ...pawns.get(0), hero: 27 })
  game.frame(2)
  expect(watches()).toEqual([{ player: 2, target: 10 }])
})

test('a fresh connection gets a fresh camera attachment even when the native hero and camera handles are reused', () => {
  const { game, spectator } = spectatorGame()
  nativeCamera()
  game.frame(0)
  game.leave(spectator)
  sdk.Player.release(2)
  const reconnect = {
    ...spectator,
    player: sdk.Player.of(2),
    generation: 2,
  }
  game.join(reconnect)
  game.frame(1)
  game.frame(2)
  expect(watches()).toHaveLength(2)
  expect(game.seats.has(playerId(spectator))).toBe(false)
  expect(game.seats.has(playerId(reconnect))).toBe(true)
})

test('mid-round bots never use human hero selection or camera attachment', () => {
  const { game, pawn } = spectatorGame(true)
  pawns.set(2, { ...pawn, hero: 0, health: 100 })
  nativeCamera()
  game.frame(0)
  game.frame(1)
  pawns.set(2, pawn)
  game.frame(2)
  expect(calls.some((call) => call.method === 'SelectHero')).toBe(false)
  expect(calls.some((call) => call.method === 'KillEntity')).toBe(false)
  expect(watches()).toHaveLength(0)
})

test('special input synchronizes the actual native ability cooldown once', () => {
  const { game, human } = serving()
  calls.length = 0
  game.input(human.player, sdk.Buttons.ability3, 0n)
  game.frame(10)
  const changes = calls
    .filter((c) => c.method === 'SetAbility')
    .map((c) => AbilityOptions.fromBinary(c.request))
  expect(changes).toEqual([
    { ability: specialCarrier, upgrades: 1, cooldownEnd: 30 },
  ])
  expect(changes[0]?.player ?? 0).toBe(0)
  const fields = calls
    .filter((c) => c.method === 'WriteField')
    .map((c) => WriteFieldRequest.fromBinary(c.request))
  expect(fields).toHaveLength(1)
  expect(fields[0]?.field).toBe('m_flCooldownStart')
  game.requestSpecial(human.player)
  game.frame(11)
  expect(calls.filter((c) => c.method === 'SetAbility')).toHaveLength(1)
})

test('Power Slash is consumed by one successful return', () => {
  const { game, human } = serving()
  game.requestSpecial(human.player)
  game.frame(10)
  expect(game.seats.get(playerId(human))?.special.armed).toBe(true)
  game.round.phase = {
    kind: 'flight',
    target: playerId(human),
    selectedAt: 9,
    safeUntil: 9,
    position: { x: 740, y: 0, z: 65 },
    velocity: { x: -1000, y: 0, z: 0 },
    power: 1000,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  game.block(human.player)
  game.frame(10.01)
  expect(game.seats.get(playerId(human))?.special.armed).toBe(false)
  expect(game.round.phase).toMatchObject({ kind: 'flight', target: '1:1' })
})

test('Power Slash charges outside ball play and glows on the player until the charged return', () => {
  const { game, human } = serving()
  game.round.phase = { kind: 'reset', until: 100 }
  calls.length = 0
  game.requestSpecial(human.player)
  game.frame(10)
  const seat = game.seats.get(playerId(human))!
  expect(seat.special.armed).toBe(true)
  expect(calls.filter((c) => c.method === 'CreateParticle')).toHaveLength(1)
  expect(seat.charge).toBeDefined()
  game.frame(10.1)
  expect(calls.filter((c) => c.method === 'CreateParticle')).toHaveLength(1)
  game.round.phase = {
    kind: 'flight',
    target: playerId(human),
    selectedAt: 9,
    safeUntil: 9,
    position: { x: 740, y: 0, z: 65 },
    velocity: { x: -1000, y: 0, z: 0 },
    power: 1000,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  calls.length = 0
  game.block(human.player)
  game.frame(10.2)
  expect(seat.special.armed).toBe(false)
  expect(seat.charge).toBeUndefined()
  expect(calls.some((c) => c.method === 'RemoveObject')).toBe(true)
})

test('Blink uses movement direction, not crosshair direction, and preserves vertical motion', () => {
  const { game, human } = serving('blink')
  game.requestSpecial(human.player)
  calls.length = 0
  game.frame(10, [movement(human, false)])
  const teleports = calls
    .filter((c) => c.method === 'Teleport')
    .map((c) => TeleportRequest.fromBinary(c.request))
  expect(teleports).toHaveLength(1)
  expect(teleports[0]?.position?.x).toBe(600)
  expect(teleports[0]?.position?.y).toBeCloseTo(12 / 0.0254, 3)
  expect(game.seats.get(playerId(human))?.special.readyAt).toBe(28)
})

test('spectators, penalized players, and stale connections cannot activate specials', () => {
  const { game, human } = serving()
  const seat = game.seats.get(playerId(human))!
  seat.penalty = { entity: human.player.pawn()!.entity, until: 50 }
  game.requestSpecial(human.player)
  game.frame(10)
  expect(seat.special.armed).toBe(false)
  seat.penalty = undefined
  game.round.living.delete(playerId(human))
  game.requestSpecial(human.player)
  game.frame(10.1)
  expect(seat.special.armed).toBe(false)
  game.leave(human)
  game.requestSpecial(human.player)
  expect(seat.pendingSpecial).toBe(false)
})

function movingFreezeGame() {
  const setup = serving('timeFreeze')
  setup.game.frame(10)
  setup.game.round.phase = {
    kind: 'flight',
    target: playerId(setup.human),
    selectedAt: 9,
    safeUntil: 9,
    position: { x: 0, y: 0, z: 65 },
    velocity: { x: 100, y: 0, z: 0 },
    power: 0,
    orbitSeconds: 2,
    enteredBlockSphere: false,
  }
  return setup
}

interface Hud {
  notice?: Record<string, unknown>
  special?: Record<string, unknown>
  scores?: { rows: Record<string, unknown>[]; full: boolean }
  rally?: { count: number; live: boolean }
  choices?: { choices: unknown[]; nativeAbilityId: number; playerSlot: number }
}

function hud(slot: number): Hud {
  const view: Record<string, unknown> = {}
  for (const node of screens.get(slot)?.values() ?? []) {
    if (node.layout === 'rally.xml' && node.data)
      view.notice = JSON.parse(node.data)
    else if (node.kind === Kind.ROUTE && node.route && node.data)
      view[node.route] = JSON.parse(node.data)
  }
  return view
}

test('Time Freeze starts one native cooldown after accepted input and leaves the existing ball visible', () => {
  const { game, human } = movingFreezeGame()
  calls.length = 0
  game.input(human.player, sdk.Buttons.ability3, 0n)
  game.input(human.player, 0n, sdk.Buttons.ability3)
  game.frame(10.01)
  expect(game.round.phase.kind).toBe('frozen')
  expect(game.seats.get(playerId(human))?.special.readyAt).toBeCloseTo(32.01)
  const changes = calls
    .filter((c) => c.method === 'SetAbility')
    .map((c) => AbilityOptions.fromBinary(c.request))
  expect(changes).toHaveLength(1)
  expect(changes[0]?.cooldownEnd).toBeCloseTo(32.01, 3)
  game.requestSpecial(human.player)
  game.frame(10.2)
  expect(calls.filter((c) => c.method === 'SetAbility')).toHaveLength(1)
  expect(
    calls.some(
      (c) => c.method === 'RemoveObject' || c.method === 'CreateParticle',
    ),
  ).toBe(false)
})

test('Time Freeze freezes a ball flying at another player', () => {
  const { game, human } = movingFreezeGame()
  if (game.round.phase.kind !== 'flight') throw new Error('Fixture')
  game.round.phase.target = '1:1'
  game.round.phase.position.x = -400
  game.requestSpecial(human.player)
  game.frame(10.01)
  expect(game.round.phase.kind as string).toBe('frozen')
  expect(game.seats.get(playerId(human))?.special.readyAt).toBeCloseTo(
    10.01 + 22,
  )
})

test('Time Freeze rejected during serve or within the block sphere costs no cooldown', () => {
  for (const condition of ['serve', 'sphere', 'alreadyEntered'] as const) {
    const { game, human } = movingFreezeGame()
    if (game.round.phase.kind !== 'flight') throw new Error('Fixture')
    if (condition === 'sphere') game.round.phase.position.x = 450
    if (condition === 'alreadyEntered')
      game.round.phase.enteredBlockSphere = true
    if (condition === 'serve')
      game.round.phase = {
        kind: 'serve',
        target: playerId(human),
        until: 100,
        position: { x: 0, y: 0, z: 100 },
      }
    calls.length = 0
    game.requestSpecial(human.player)
    game.frame(10.01)
    expect(game.round.phase.kind).not.toBe('frozen')
    expect(game.seats.get(playerId(human))?.special.readyAt).toBe(0)
    expect(calls.some((c) => c.method === 'SetAbility')).toBe(false)
  }
})

test('queued Time Freeze input cannot undo a hit earlier in its processing frame', () => {
  const { game, human } = movingFreezeGame()
  if (game.round.phase.kind !== 'flight') throw new Error('Fixture')
  game.round.phase.position.x = 751
  game.round.phase.velocity.x = -10000
  calls.length = 0
  game.requestSpecial(human.player)
  game.frame(10.1)
  expect(game.round.phase).toMatchObject({ kind: 'intermission' })
  expect(game.round.living.has(playerId(human))).toBe(false)
  expect(game.seats.get(playerId(human))?.special.readyAt).toBe(0)
  expect(calls.some((c) => c.method === 'SetAbility')).toBe(false)
})

test('everyone including spectators gets a freeze countdown and visible restart cue with the same target', () => {
  const { game, human } = movingFreezeGame()
  const spectator = join(game, 2)
  const seat = game.seats.get(playerId(spectator))!
  seat.state = {
    kind: 'spectating',
    retryAt: 100,
    camera: { kind: 'pending' },
  }
  game.round.living.delete(playerId(spectator))
  game.requestSpecial(human.player)
  calls.length = 0
  game.frame(10.01)
  for (const slot of [0, 1, 2]) {
    expect(hud(slot).notice).toMatchObject({
      title: 'TIME FROZEN · 0.6s',
      ballCue: 'frozen',
      targeted: slot === 0,
    })
  }
  expect(hud(2).notice).toMatchObject({ spectating: true })
  calls.length = 0
  game.frame(10.51)
  for (const slot of [0, 1, 2]) {
    expect(hud(slot).notice).toMatchObject({
      ballCue: 'restarting',
      detail: 'BALL RESTARTING',
    })
  }
  calls.length = 0
  game.frame(10.62)
  for (const slot of [0, 1, 2]) {
    expect(hud(slot).notice).toMatchObject({
      title: 'BALL RESUMED',
      ballCue: 'resumed',
      targeted: slot === 0,
    })
  }
})

test('parry can be activated during Time Freeze and its normal window still expires', () => {
  const { game, human } = movingFreezeGame()
  game.requestSpecial(human.player)
  game.frame(10.01)
  expect(game.block(human.player)).toBe(true)
  const block = game.seats.get(playerId(human))!.block
  expect(block.window).toEqual({ started: 10.01, ends: 10.41 })
  game.frame(10.62)
  expect(block.window).toEqual({ started: 10.01, ends: 10.41 })
  expect(block.cooldown(10.62)).toBeCloseTo(0.19)
})

test('Time Freeze readiness follows target and sphere eligibility in the native HUD', () => {
  const { game } = movingFreezeGame()
  calls.length = 0
  game.frame(10.11)
  expect(hud(0).special).toMatchObject({ available: true })
  if (game.round.phase.kind !== 'flight') throw new Error('Fixture')
  game.round.phase.position.x = 451
  game.round.phase.velocity.x = 0
  calls.length = 0
  game.frame(10.22)
  expect(hud(0).special).toMatchObject({ available: false })
})

test('a return that eliminates its target scores a parry, a knockout and the round for the sender', () => {
  const { game, human } = serving()
  game.frame(10)
  game.round.phase = {
    kind: 'flight',
    target: playerId(human),
    selectedAt: 9,
    safeUntil: 9,
    position: { x: 740, y: 0, z: 65 },
    velocity: { x: -1000, y: 0, z: 0 },
    power: 1000,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  game.block(human.player)
  game.frame(10.01)
  expect(game.round.phase).toMatchObject({ kind: 'flight', target: '1:1' })
  game.round.phase = {
    kind: 'flight',
    target: '1:1',
    selectedAt: 9,
    safeUntil: 9,
    position: { x: -500, y: 0, z: 65 },
    velocity: { x: -10_000, y: 0, z: 0 },
    power: 0,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  calls.length = 0
  game.frame(11)
  expect(game.round.phase).toMatchObject({ kind: 'intermission' })
  const scores = hud(0).scores
  expect(scores?.full).toBe(true)
  expect(scores?.rows).toEqual([
    {
      rank: 1,
      name: 'Human 0',
      wins: 1,
      knockouts: 1,
      parries: 1,
      streak: 1,
      alive: true,
      self: true,
      leader: true,
    },
    {
      rank: 2,
      name: 'Human 1',
      wins: 0,
      knockouts: 0,
      parries: 0,
      streak: 0,
      alive: false,
      self: false,
      leader: false,
    },
  ])
})

test('a served ball that hits its first target credits nobody', () => {
  const { game, human } = serving()
  game.frame(10)
  game.round.phase = {
    kind: 'flight',
    target: playerId(human),
    selectedAt: 9,
    safeUntil: 9,
    position: { x: 700, y: 0, z: 65 },
    velocity: { x: -10_000, y: 0, z: 0 },
    power: 0,
    orbitSeconds: 0,
    enteredBlockSphere: false,
  }
  calls.length = 0
  game.frame(11)
  expect(hud(1).scores?.rows[0]).toMatchObject({
    name: 'Human 1',
    wins: 1,
    knockouts: 0,
    self: true,
  })
})

test('a human keeps a score across a reconnect and a new world clears it', () => {
  const { game, human } = serving()
  game.scores.win(`steam:${human.steamId}`)
  game.leave(human)
  join(game, 0, false, 2)
  calls.length = 0
  game.frame(10)
  expect(hud(0).scores?.rows[0]).toMatchObject({
    name: 'Human 0',
    wins: 1,
    self: true,
    leader: true,
  })
  const reconnect = game.seats.get('0:2')!.connection
  game.world()
  game.frame(0.1)
  expect(hud(0).scores).toBeUndefined()
  game.choose(reconnect.player, 'blink')
  game.frame(0.2)
  expect(
    hud(0).scores?.rows.every(
      (score) => score.wins === 0 && score.leader === false,
    ),
  ).toBe(true)
})

function sentNodes(slot: number): Node[] {
  return calls
    .filter((call) => call.method === 'Ui')
    .map((call) => UiRequest.fromBinary(call.request))
    .filter((ui) => (ui.player ?? 0) === slot)
    .flatMap((ui) => ui.change?.set ?? [])
}

test('a joining player gets the special cards once after the reset, and the notice is all the layout data holds', () => {
  const { game } = serving()
  game.frame(10)
  expect(hud(0).choices).toMatchObject({ nativeAbilityId: expect.any(Number) })
  expect(hud(0).choices?.playerSlot).toBe(0)
  expect(hud(0).choices?.choices).toHaveLength(3)
  expect(Object.keys(hud(0).notice ?? {}).sort()).toEqual([
    'ballCue',
    'detail',
    'spectating',
    'targeted',
    'title',
  ])
  expect(hud(0).special).toEqual({
    choice: 'powerSlash',
    armed: false,
    available: true,
  })
  expect(hud(0).rally).toEqual({ count: 0, live: true })
  calls.length = 0
  game.frame(10.2)
  expect(sentNodes(0)).toEqual([])
  game.round.rally = 3
  game.frame(10.4)
  expect(sentNodes(0).map((node) => node.id)).toEqual(['route:rally'])
  expect(hud(0).rally).toEqual({ count: 3, live: true })
})

test('a player still choosing gets no standings, so the boards stay behind the picker', () => {
  const game = new Game()
  join(game, 0, false, 1, null)
  join(game, 1)
  game.frame(1)
  expect(hud(0).special).toMatchObject({ choice: null })
  expect(hud(0).scores).toBeUndefined()
  expect(hud(1).scores?.rows).toHaveLength(2)
})

function ownController(hero: number, controller: number): void {
  field(hero, 'CBasePlayerPawn', 'm_hController', controller)
  field(controller, 'CCitadelPlayerController', 'm_hHeroPawn', hero)
}

function damaged(): number[] {
  return calls
    .filter((call) => call.method === 'Damage')
    .map((call) => HitOptions.fromBinary(call.request).victim ?? 0)
}

test("a leaver's living Yamato is laid down once nobody holds it, while connected and spectating heroes are kept", () => {
  const { game, spectator, pawn } = spectatorGame()
  const leaver = game.seats.get('1:1')!.connection
  nativeCamera(pawn.entity, 82, 72)
  ownController(pawn.entity, 72)
  ownController(10, 70)
  // A disconnected controller can keep naming its old hero.
  ownController(11, 71)
  field(71, 'CBasePlayerController', 'm_iConnected', 4)
  field(11, 'CBaseEntity', 'm_iHealth', 100)
  for (const entity of [10, 11, pawn.entity]) heroEntities.add(entity)
  game.leave(leaver)
  for (const now of [0, 1, 2]) game.frame(now)
  expect(damaged()).toEqual([])
  game.frame(3)
  expect(damaged()).toEqual([11])
  expect(fields.get('11:CCitadelPlayerPawn:m_flRespawnTime')?.value).toEqual({
    case: 'number',
    value: 1e9,
  })
  expect(game.seats.has(playerId(spectator))).toBe(true)
  expect(pawns.get(0)?.health).toBe(100)
})

test('a new world restarts the stray sweep with its clock', () => {
  const { game } = serving()
  game.frame(500)
  heroEntities.add(50)
  field(50, 'CBaseEntity', 'm_iHealth', 100)
  game.world()
  for (const now of [0, 1, 2, 3]) game.frame(now)
  expect(damaged()).toEqual([50])
})

test('a hero that spawns for an eliminated or spectating player is killed at once with its respawn held', () => {
  const { game, human } = serving()
  const other = game.seats.get('1:1')!
  const seat = game.seats.get(playerId(human))!
  game.frame(10)
  const pawn = human.player.pawn()!
  const kills = () =>
    calls
      .filter((call) => call.method === 'KillEntity')
      .map((call) => KillOptions.fromBinary(call.request).victim)

  calls.length = 0
  game.spawned(human.player, pawn)
  seat.state = {
    kind: 'spawning',
    position: { x: 0, y: 0, z: 0 },
    facing: { pitch: 0, yaw: 0, roll: 0 },
    retryAt: 20,
  }
  game.spawned(human.player, pawn)
  expect(kills()).toEqual([])

  seat.state = { kind: 'eliminated', spectateAt: 20 }
  game.spawned(human.player, pawn)
  expect(kills()).toEqual([pawn.entity])
  expect(
    fields.get(`${pawn.entity}:CCitadelPlayerPawn:m_flRespawnTime`)?.value,
  ).toEqual({ case: 'number', value: 0 })

  calls.length = 0
  seat.state = {
    kind: 'spectating',
    retryAt: 20,
    camera: { kind: 'attached', hero: pawn.entity, camera: 82, target: 11 },
  }
  game.spawned(human.player, pawn)
  expect(kills()).toEqual([pawn.entity])
  expect(seat.state).toMatchObject({ camera: { kind: 'pending' } })

  calls.length = 0
  game.spawned(human.player, { ...pawn, hero: 0 })
  game.spawned(human.player, { ...pawn, hero: 1 })
  game.round.phase = { kind: 'countdown', until: 30 }
  game.spawned(human.player, pawn)
  game.round.phase = { kind: 'waiting' }
  game.spawned(human.player, pawn)
  game.leave(other.connection)
  game.round.phase = { kind: 'spawning', until: 30 }
  game.spawned(other.connection.player, other.connection.player.pawn()!)
  expect(kills()).toEqual([])
})
