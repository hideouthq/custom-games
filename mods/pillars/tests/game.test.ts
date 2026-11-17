import { beforeEach, describe, expect, test } from 'bun:test'
import { type Connection, Player } from 'modlock'

import { bind } from '../.tools/modlock/js/src/host'
import {
  AbilitiesResponse,
  AbilityOptions,
  GiveItemRequest,
  HoldModifierStateRequest,
  ModifiersResponse,
  ReplaceAbilityRequest,
} from '../.tools/modlock/src/wasm/abilities/abilities.pb'
import { KillOptions } from '../.tools/modlock/src/wasm/combat/combat.pb'
import { EntityRequest } from '../.tools/modlock/src/wasm/entities/entities.pb'
import {
  FieldResponse,
  ReadFieldRequest,
  WriteFieldRequest,
} from '../.tools/modlock/src/wasm/fields/fields.pb'
import { TeleportRequest } from '../.tools/modlock/src/wasm/movement/movement.pb'
import {
  type Pawn,
  PawnResponse,
  PlayerRequest,
  SetStaminaRequest,
} from '../.tools/modlock/src/wasm/players/players.pb'
import { Call, Reply } from '../.tools/modlock/src/wasm/wasm.pb'
import { arena, combat, rules } from '../gameplay/config'
import { crateRounds, pool, type PoolHero } from '../gameplay/heroes'
import { Game } from '../gameplay/game'
import { Inventory } from '../gameplay/inventory'
import { lingerSeconds } from '../gameplay/loot'
import type { Round } from '../gameplay/round'
import { pillarStand } from '../gameplay/seating'

const step = 0.05

const pawns = new Map<number, Pawn>()
const held = new Map<number, { ability: number; made: number }[]>()
const fields = new Map<string, number>()
const calls: { method: string; request: Uint8Array }[] = []
const refused = new Set<string>()
let clock = 0

beforeEach(() => {
  for (let slot = 0; slot < 6; slot++) Player.release(slot)
  pawns.clear()
  held.clear()
  fields.clear()
  calls.length = 0
  refused.clear()
  clock = 0
  bind((bytes) => {
    const call = Call.fromBinary(bytes)
    const method = call.method ?? ''
    const request = call.request ?? new Uint8Array()
    calls.push({ method, request })
    if (refused.has(method)) {
      return Reply.toBinary({ error: 'refused' })
    }
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
    } else if (method === 'Abilities') {
      const slot = PlayerRequest.fromBinary(request).player ?? 0
      response = AbilitiesResponse.toBinary({
        abilities: [
          {
            name: 'citadel_weapon_viscous_set_2',
            slot: 20,
            entity: 500 + slot,
          },
          { name: 'citadel_weapon_viscous_set', slot: 21, entity: gunOf(slot) },
        ],
      })
    } else if (method === 'ReadField') {
      const read = ReadFieldRequest.fromBinary(request)
      const value = fields.get(`${read.entity}.${read.field}`)
      if (value !== undefined) {
        response = FieldResponse.toBinary({
          value: { value: { case: 'number', value } },
        })
      }
    } else if (method === 'WriteField') {
      const write = WriteFieldRequest.fromBinary(request)
      const value = write.value?.value
      if (value?.case === 'number') {
        fields.set(`${write.entity}.${write.field}`, value.value)
      }
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

function viscous(): PoolHero {
  const hero = pool.find((each) => each.name === 'hero_viscous')
  if (hero === undefined) throw new Error('no Viscous in the pool')
  return hero
}

function entityOf(slot: number): number {
  return 100 + slot
}

function gunOf(slot: number): number {
  return 300 + slot
}

function gun(slot: number, field: string): number | undefined {
  return fields.get(`${gunOf(slot)}.${field}`)
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
    hero: viscous().id,
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

function shown(from = 0): string[] {
  return calls
    .slice(from)
    .filter((call) => call.method === 'Ui')
    .map((call) => new TextDecoder().decode(call.request))
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
    live(game, 3)
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
    expect(
      shown(before).some((text) =>
        text.includes('Person 0 eliminated Person 1.'),
      ),
    ).toBe(true)
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
    const seated = sent('Teleport', TeleportRequest)
      .filter((teleport) => teleport.player === 1)
      .at(-1)?.position
    expect(seated).toBeDefined()
    const loser = pawns.get(0)
    if (loser?.position) loser.position = { ...loser.position, z: -2000 }
    run(game, clock + 0.1)
    expect(round.phase).toBe('intermission')
    const winner = pawns.get(1)
    if (winner?.position) winner.position = { ...winner.position, z: -400 }
    const before = calls.length
    run(game, clock + 0.1)
    expect(sent('Teleport', TeleportRequest, before)).toContainEqual(
      expect.objectContaining({ player: 1, position: seated }),
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

describe('reloads', () => {
  const clip = 'm_iClip'
  const gate = 'm_flReloadAvailableTime'

  test('a gun fired dry cannot start a reload until an Ammo Crate', () => {
    const game = dev()
    live(game, 2)
    const player = Player.of(0)
    fields.set(`${gunOf(0)}.${clip}`, 0)
    fields.set(`${gunOf(0)}.${gate}`, clock + 0.25)
    run(game, clock + 0.1)
    expect(gun(0, gate)).toBeGreaterThan(clock + 600)

    game.dev(player, 'give ammo')
    run(game, clock + 0.1)
    expect(gun(0, gate)).toBeLessThanOrEqual(clock)
  })

  test('the gun is the weapon in the primary slot, not a second weapon', () => {
    const game = dev()
    live(game, 2)
    fields.set(`${gunOf(0)}.${clip}`, 0)
    fields.set(`500.${clip}`, 0)
    run(game, clock + 0.1)
    expect(gun(0, gate)).toBeGreaterThan(clock + 600)
    expect(fields.get(`500.${gate}`)).toBeUndefined()
  })

  test('a reload takes from the reserve no more rounds than it holds', () => {
    const game = dev()
    const player = Player.of(0)
    live(game, 2)
    fields.set(`${gunOf(0)}.${clip}`, 0)
    run(game, clock + 0.1)
    game.dev(player, 'give ammo')
    run(game, clock + 0.1)
    fields.set(`${gunOf(0)}.${clip}`, 29)
    run(game, clock + 0.1)
    expect(gun(0, clip)).toBe(crateRounds(viscous()))
    expect(gun(0, gate)).toBeGreaterThan(clock + 600)
  })
})

describe('Infinite Rounds', () => {
  function released(from: number): number {
    return sent('HoldModifierState', HoldModifierStateRequest, from).filter(
      (hold) => hold.active === false,
    ).length
  }

  test('a second one keeps the clip endless for its own full time', () => {
    const game = dev()
    live(game, 2)
    const player = Player.of(0)
    const before = calls.length
    game.dev(player, 'give infinite')
    run(game, clock + 3)
    game.dev(player, 'give infinite')
    run(game, clock + combat.infiniteSeconds - 0.1)
    expect(released(before)).toBe(0)
    run(game, clock + 0.2)
    expect(released(before)).toBe(1)
  })
})

describe('stamina', () => {
  test("is anchored every frame, so a player's own game cannot show it regenerating", () => {
    const game = dev()
    live(game, 2)
    const before = calls.length
    const frames = 10
    run(game, clock + frames * step)
    const anchored = sent('SetStamina', SetStaminaRequest, before).filter(
      (request) => (request.player ?? 0) === 0,
    )
    expect(anchored.length).toBe(frames)
  })
})

describe('centre Legendary', () => {
  function hudAfterCentre(): string[] {
    const game = dev()
    live(game, 2)
    const before = calls.length
    run(game, clock + rules.centreSeconds + 0.1)
    return shown(before)
  }

  test('the HUD sends players to break the crate', () => {
    const hud = hudAfterCentre()
    expect(hud.some((text) => text.includes('heavy melee it'))).toBe(true)
    expect(hud.some((text) => text.includes('stand on it'))).toBe(false)
  })

  test('the HUD names no crate when the game refuses one', () => {
    refused.add('CreateEntity')
    const hud = hudAfterCentre()
    expect(hud.some((text) => text.includes('stand on it'))).toBe(true)
    expect(hud.some((text) => text.includes('heavy melee it'))).toBe(false)
  })
})
