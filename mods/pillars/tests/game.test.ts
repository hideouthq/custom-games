import { beforeEach, describe, expect, test } from 'bun:test'
import { type Connection, Player } from 'modlock'

import { bind } from '../.tools/modlock/js/src/host'
import {
  AbilityOptions,
  GiveItemRequest,
  ModifiersResponse,
  ReplaceAbilityRequest,
} from '../.tools/modlock/src/wasm/abilities/abilities.pb'
import { KillOptions } from '../.tools/modlock/src/wasm/combat/combat.pb'
import { EntityRequest } from '../.tools/modlock/src/wasm/entities/entities.pb'
import { TeleportRequest } from '../.tools/modlock/src/wasm/movement/movement.pb'
import {
  type Pawn,
  PawnResponse,
  PlayerRequest,
} from '../.tools/modlock/src/wasm/players/players.pb'
import { Call, Reply } from '../.tools/modlock/src/wasm/wasm.pb'
import { arena, rules } from '../gameplay/config'
import { Game } from '../gameplay/game'
import { Inventory, lingerSeconds } from '../gameplay/loot'
import type { Round } from '../gameplay/round'
import { pillarStand } from '../gameplay/seating'

const step = 0.05

const pawns = new Map<number, Pawn>()
const held = new Map<number, { ability: number; made: number }[]>()
const calls: { method: string; request: Uint8Array }[] = []
let clock = 0

beforeEach(() => {
  for (let slot = 0; slot < 6; slot++) Player.release(slot)
  pawns.clear()
  held.clear()
  calls.length = 0
  clock = 0
  bind((bytes) => {
    const call = Call.fromBinary(bytes)
    const method = call.method ?? ''
    const request = call.request ?? new Uint8Array()
    calls.push({ method, request })
    let response: Uint8Array = new Uint8Array()
    if (method === 'Pawn') {
      const slot = PlayerRequest.fromBinary(request).player ?? 0
      response = PawnResponse.toBinary({ pawn: pawns.get(slot) })
    } else if (method === 'Teleport') {
      const teleport = TeleportRequest.fromBinary(request)
      const pawn = pawns.get(teleport.player ?? 0)
      if (pawn !== undefined && teleport.position !== undefined) {
        pawn.position = teleport.position
      }
    } else if (method === 'Respawn') {
      const pawn = pawns.get(PlayerRequest.fromBinary(request).player ?? 0)
      if (pawn !== undefined) pawn.health = 800
    } else if (method === 'KillEntity') {
      const victim = KillOptions.fromBinary(request).victim
      for (const pawn of pawns.values()) {
        if (pawn.entity === victim) pawn.health = 0
      }
    } else if (method === 'Kill') {
      const pawn = pawns.get(PlayerRequest.fromBinary(request).player ?? 0)
      if (pawn !== undefined) pawn.health = 0
    } else if (method === 'Modifiers') {
      const entity = EntityRequest.fromBinary(request).entity ?? 0
      response = ModifiersResponse.toBinary({
        modifiers: (held.get(entity) ?? []).map((modifier) => ({
          name: 'modifier_test',
          ability: modifier.ability,
          age: clock - modifier.made,
        })),
      })
    }
    return Reply.toBinary({ response })
  })
})

function sent<T>(
  method: string,
  type: { fromBinary(bytes: Uint8Array): T },
  from = 0,
): T[] {
  return calls
    .slice(from)
    .filter((call) => call.method === method)
    .map((call) => type.fromBinary(call.request))
}

function entityOf(slot: number): number {
  return 100 + slot
}

function join(
  game: Game,
  slot: number,
  steamId = BigInt(slot + 1),
  generation = 1,
): Connection {
  const stand = pillarStand(slot)
  pawns.set(slot, {
    entity: entityOf(slot),
    hero: 6,
    team: 2,
    health: 800,
    maxHealth: 800,
    position: { x: stand.x, y: stand.y, z: stand.z + 24 },
    stamina: 1,
    maxStamina: 3,
    generation,
  })
  const connection: Connection = {
    player: Player.of(slot),
    steamId,
    name: `Person ${slot}`,
    bot: false,
    ready: true,
    generation,
    roles: [],
  }
  game.join(connection)
  return connection
}

function run(game: Game, until: number): void {
  while (clock < until - 1e-9) {
    clock = Math.round((clock + step) * 1000) / 1000
    game.frame(clock, [])
  }
}

function dev(): Game {
  const game = new Game(7)
  game.start(['dev'])
  return game
}

function cast(
  game: Game,
  slot: number,
  name: string,
  ability: number,
  target = 0,
): void {
  game.cast({
    caster: entityOf(slot),
    player: Player.of(slot),
    ability,
    name,
    slot: 0,
    target,
  })
}

function live(game: Game, count: number): Round {
  for (let slot = 0; slot < count; slot++) join(game, slot)
  const round = game['round']
  while (round.phase !== 'live' && clock < 30) run(game, clock + step)
  expect(round.phase).toBe('live')
  return round
}

function empty(game: Game, slot: number): void {
  const member = game['members'].get(slot)
  if (member !== undefined) member.inventory = new Inventory()
}

function cooldowns(ability: string, from = 0): (number | undefined)[] {
  return sent('SetAbility', AbilityOptions, from)
    .filter((options) => options.ability === ability)
    .flatMap((options) =>
      options.cooldown === undefined ? [] : [options.cooldown],
    )
}

function locks(ability: string, from = 0): number {
  return sent('SetAbility', AbilityOptions, from).filter(
    (options) =>
      options.ability === ability && options.cooldownEnd !== undefined,
  ).length
}

describe('casts', () => {
  test('a cast spends a charge by the name the event gives', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give hook')
    game.dev(player, 'give hook')
    const before = calls.length
    cast(game, 0, 'citadel_ability_hook', 900)
    expect(locks('citadel_ability_hook', before)).toBe(0)
    cast(game, 0, 'citadel_ability_hook', 900)
    expect(locks('citadel_ability_hook', before)).toBe(1)
    expect(calls.some((call) => call.method === 'Abilities')).toBe(false)
  })

  test('a cast of something not dropped, or by nobody, spends nothing', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give hook')
    const before = calls.length
    cast(game, 0, 'citadel_ability_lash', 900)
    cast(game, 3, 'citadel_ability_hook', 900)
    cast(game, 0, '', 900)
    expect(locks('citadel_ability_hook', before)).toBe(0)
    cast(game, 0, 'citadel_ability_hook', 900)
    expect(locks('citadel_ability_hook', before)).toBe(1)
  })
})

describe('charges', () => {
  test('every dropped ability and item recharges in chargeSeconds', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give hook')
    expect(sent('ReplaceAbility', ReplaceAbilityRequest)).toContainEqual(
      expect.objectContaining({ ability: 'citadel_ability_hook' }),
    )
    expect(cooldowns('citadel_ability_hook')).toEqual([rules.chargeSeconds])
    game.dev(player, 'give warp')
    expect(sent('GiveItem', GiveItemRequest)).toContainEqual(
      expect.objectContaining({ item: 'upgrade_warp_stone' }),
    )
    expect(cooldowns('upgrade_warp_stone')).toEqual([rules.chargeSeconds])
    const before = calls.length
    game.dev(player, 'give hook')
    expect(calls.slice(before).map((call) => call.method)).toContain(
      'RefreshAbility',
    )
    expect(cooldowns('citadel_ability_hook', before)).toEqual([
      rules.chargeSeconds,
    ])
  })

  test('nothing refreshes a charge on a timer any more', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give hook')
    game.dev(player, 'give hook')
    const before = calls.length
    cast(game, 0, 'citadel_ability_hook', 900)
    run(game, clock + rules.chargeSeconds + 1)
    expect(
      calls.slice(before).filter((call) => call.method === 'RefreshAbility'),
    ).toEqual([])
  })

  test('a spent drop is locked and paced for its linger, then emptied', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give hook')
    const before = calls.length
    cast(game, 0, 'citadel_ability_hook', 900)
    const options = sent('SetAbility', AbilityOptions, before)
    expect(options).toContainEqual(
      expect.objectContaining({
        ability: 'citadel_ability_hook',
        cooldownEnd: clock + lingerSeconds,
      }),
    )
    expect(cooldowns('citadel_ability_hook', before)).toEqual([lingerSeconds])
    run(game, clock + lingerSeconds - 0.2)
    expect(sent('ReplaceAbility', ReplaceAbilityRequest, before)).toEqual([])
    run(game, clock + 0.3)
    expect(sent('ReplaceAbility', ReplaceAbilityRequest, before)).toEqual([
      expect.objectContaining({ ability: 'targetdummy_ability_1' }),
    ])
  })

  test('rebuilt items get the short cooldown again', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give warp')
    game.dev(player, 'give anchor')
    cast(game, 0, 'upgrade_metal_skin', 901)
    const before = calls.length
    run(game, clock + lingerSeconds + 0.2)
    expect(calls.slice(before).map((call) => call.method)).toContain(
      'ClearItems',
    )
    expect(sent('GiveItem', GiveItemRequest, before)).toEqual([
      expect.objectContaining({ item: 'upgrade_warp_stone' }),
    ])
    expect(cooldowns('upgrade_warp_stone', before)).toEqual([
      rules.chargeSeconds,
    ])
  })
})

describe('spent items', () => {
  function spendAnchor(game: Game, slot = 0): number {
    const player = Player.of(slot)
    game.dev(player, 'give warp')
    game.dev(player, 'give anchor')
    const before = calls.length
    cast(game, slot, 'upgrade_metal_skin', 901)
    return before
  }

  function rebuilt(from: number): boolean {
    return calls.slice(from).some((call) => call.method === 'ClearItems')
  }

  test('empty once the modifier their cast applied is gone', () => {
    const game = dev()
    join(game, 0)
    run(game, 0.5)
    const before = spendAnchor(game)
    held.set(entityOf(0), [{ ability: 901, made: clock }])
    run(game, clock + 2)
    expect(rebuilt(before)).toBe(false)
    held.set(entityOf(0), [])
    run(game, clock + 0.6)
    expect(rebuilt(before)).toBe(true)
  })

  test('wait out their time when no modifier of theirs is ever seen', () => {
    const game = dev()
    join(game, 0)
    run(game, 0.5)
    const at = clock
    const before = spendAnchor(game)
    run(game, at + lingerSeconds - 0.2)
    expect(rebuilt(before)).toBe(false)
    run(game, at + lingerSeconds + 0.2)
    expect(rebuilt(before)).toBe(true)
  })

  test('ignore a modifier the item held before its cast', () => {
    const game = dev()
    join(game, 0)
    run(game, 0.5)
    held.set(entityOf(0), [{ ability: 901, made: 0 }])
    const at = clock
    const before = spendAnchor(game)
    run(game, at + 3)
    held.set(entityOf(0), [])
    run(game, at + lingerSeconds - 0.2)
    expect(rebuilt(before)).toBe(false)
  })

  test('look for the effect on the other heroes too', () => {
    const game = dev()
    live(game, 2)
    empty(game, 0)
    game.dev(Player.of(0), 'give shrink')
    const before = calls.length
    cast(game, 0, 'upgrade_shrink_ray', 902, entityOf(1))
    held.set(entityOf(1), [{ ability: 902, made: clock }])
    run(game, clock + 3)
    expect(rebuilt(before)).toBe(false)
    held.set(entityOf(1), [])
    run(game, clock + 0.6)
    expect(rebuilt(before)).toBe(true)
  })

  test('are locked once, not every frame, while another item plays', () => {
    const game = dev()
    const player = join(game, 0).player
    run(game, 0.5)
    game.dev(player, 'give warp')
    game.dev(player, 'give cloak')
    const at = clock
    cast(game, 0, 'upgrade_cloaking_device_active', 903)
    cast(game, 0, 'upgrade_warp_stone', 904)
    const before = calls.length
    run(game, at + 12.5)
    expect(locks('upgrade_warp_stone', before)).toBe(1)
    expect(locks('upgrade_cloaking_device_active', before)).toBe(1)
    expect(rebuilt(before)).toBe(false)
    run(game, at + 13.2)
    expect(rebuilt(before)).toBe(true)
  })

  test('are not looked at without a spent item', () => {
    const game = dev()
    join(game, 0)
    run(game, 2)
    expect(calls.some((call) => call.method === 'Modifiers')).toBe(false)
  })
})

describe('shove credit', () => {
  test('goes to whoever shoved the one who fell, else to the latest shove', () => {
    const game = dev()
    const round = live(game, 3)
    for (const slot of [0, 2]) empty(game, slot)
    game.dev(Player.of(0), 'give hook')
    game.dev(Player.of(2), 'give pillow')
    cast(game, 0, 'citadel_ability_hook', 905, entityOf(1))
    cast(game, 2, 'ability_familiar_ability02', 906)
    const before = calls.length
    const fallen = pawns.get(1)
    if (fallen?.position) fallen.position = { ...fallen.position, z: -2000 }
    run(game, clock + 0.1)
    expect(sent('KillEntity', KillOptions, before)).toEqual([
      expect.objectContaining({
        victim: entityOf(1),
        attacker: entityOf(0),
      }),
    ])
    expect(round.isLiving(game['members'].get(1)?.id ?? -1)).toBe(false)
    const next = calls.length
    const second = pawns.get(0)
    if (second?.position) second.position = { ...second.position, z: -2000 }
    run(game, clock + 0.1)
    expect(sent('KillEntity', KillOptions, next)).toEqual([
      expect.objectContaining({
        victim: entityOf(0),
        attacker: entityOf(2),
      }),
    ])
  })
})

describe('spawns', () => {
  test('stand a hero outside a round on a pillar at once', () => {
    const game = dev()
    join(game, 3)
    const pawn = pawns.get(3)
    if (pawn) pawn.position = { x: 0, y: 0, z: -100 }
    const before = calls.length
    game.spawned(Player.of(3))
    const stand = pillarStand(3 % arena.pillars)
    expect(sent('Teleport', TeleportRequest, before)).toEqual([
      expect.objectContaining({
        position: { x: stand.x, y: stand.y, z: stand.z + 24 },
      }),
    ])
  })

  test('stand a revived hero on its seat as it spawns', () => {
    const game = dev()
    join(game, 0)
    join(game, 1)
    const pawn = pawns.get(1)
    if (pawn) pawn.health = 0
    const round = game['round']
    while (round.phase !== 'countdown') run(game, clock + step)
    while (!calls.some((call) => call.method === 'Respawn')) {
      run(game, clock + step)
    }
    if (pawn) pawn.position = { x: 0, y: 0, z: -100 }
    const before = calls.length
    game.spawned(Player.of(1))
    const seat = game['members'].get(1)?.seat ?? -1
    const stand = pillarStand(seat)
    expect(sent('Teleport', TeleportRequest, before)).toEqual([
      expect.objectContaining({
        position: { x: stand.x, y: stand.y, z: stand.z + 24 },
      }),
    ])
  })

  test('stand a hero who falls between rounds back on their pillar', () => {
    const game = dev()
    const round = live(game, 2)
    const loser = pawns.get(0)
    if (loser?.position) loser.position = { ...loser.position, z: -2000 }
    run(game, clock + 0.1)
    expect(round.phase).toBe('intermission')
    const winner = pawns.get(1)
    if (winner?.position) winner.position = { ...winner.position, z: -400 }
    const before = calls.length
    run(game, clock + 0.1)
    const stand = pillarStand(game['members'].get(1)?.seat ?? -1)
    expect(sent('Teleport', TeleportRequest, before)).toContainEqual(
      expect.objectContaining({
        position: { x: stand.x, y: stand.y, z: stand.z + 24 },
      }),
    )
  })

  test('leave a hero in a round in play alone', () => {
    const game = dev()
    live(game, 2)
    const before = calls.length
    game.spawned(Player.of(1))
    expect(sent('Teleport', TeleportRequest, before)).toEqual([])
  })
})

describe('scores', () => {
  test('stay with the person, not the slot', () => {
    const game = dev()
    const round = live(game, 2)
    const winner = game['members'].get(1)?.id ?? -1
    const pawn = pawns.get(0)
    if (pawn?.position) pawn.position = { ...pawn.position, z: -2000 }
    run(game, clock + 0.1)
    expect(round.phase).toBe('intermission')
    const points = (id: number) =>
      round.standings().find((standing) => standing.id === id)?.points ?? 0
    expect(points(winner)).toBeGreaterThan(0)

    const left = Player.of(1)
    game.leave({
      player: left,
      steamId: 2n,
      name: 'Person 1',
      bot: false,
      ready: true,
      generation: 1,
      roles: [],
    })
    Player.release(1)
    join(game, 1, 50n, 2)
    const newcomer = game['members'].get(1)?.id ?? -1
    expect(newcomer).not.toBe(winner)
    expect(points(newcomer)).toBe(0)

    join(game, 4, 2n, 1)
    expect(game['members'].get(4)?.id).toBe(winner)
  })
})
