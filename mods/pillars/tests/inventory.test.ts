import { describe, expect, test } from 'bun:test'

import { Inventory } from '../gameplay/inventory'
import { catalog, lingerSeconds, type Loot } from '../gameplay/loot'

function named(id: string): Loot {
  const loot = catalog.find((entry) => entry.id === id)
  if (loot === undefined) throw new Error('no loot ' + id)
  return loot
}

function spend(inventory: Inventory, id: string, ability = 0, now = 0) {
  return inventory.spend(named(id).native ?? '', ability, now)
}

describe('inventory', () => {
  test('fills empty slots, then replaces the oldest of its kind', () => {
    const inventory = new Inventory()
    expect(inventory.add(named('warp'))).toEqual({
      kind: 'item',
      slot: 0,
      replaced: undefined,
      stacked: false,
    })
    inventory.add(named('leap'))
    inventory.add(named('knockdown'))
    inventory.add(named('hex'))
    const gain = inventory.add(named('anchor'))
    expect(gain).toEqual({
      kind: 'item',
      slot: 0,
      replaced: named('warp'),
      stacked: false,
    })
    expect(inventory.add(named('pillow'))?.kind).toBe('ability')
    expect(inventory.held('ability')[0]?.loot.id).toBe('pillow')
  })

  test('a second copy adds charges and counts as the newest', () => {
    const inventory = new Inventory()
    inventory.add(named('warp'))
    inventory.add(named('leap'))
    inventory.add(named('knockdown'))
    inventory.add(named('hex'))
    expect(inventory.add(named('warp'))).toEqual({
      kind: 'item',
      slot: 0,
      stacked: true,
    })
    expect(inventory.held('item')[0]?.charges).toBe(2)
    expect(inventory.add(named('anchor'))?.replaced?.id).toBe('leap')
  })

  test('ammo and stamina take no slot', () => {
    const inventory = new Inventory()
    expect(inventory.add(named('ammo'))).toBeUndefined()
    expect(inventory.add(named('pip'))).toBeUndefined()
  })

  test('a drop is one use, a second copy adds one, and a spent drop keeps its slot', () => {
    const inventory = new Inventory()
    inventory.add(named('pillow'))
    inventory.add(named('pillow'))
    const where = inventory.find('ability_familiar_ability02')
    expect(where).toEqual({ kind: 'ability', slot: 0 })
    expect(spend(inventory, 'pillow')).toEqual({ loot: named('pillow') })
    expect(spend(inventory, 'pillow')).toEqual({
      loot: named('pillow'),
      lingers: lingerSeconds,
    })
    expect(spend(inventory, 'pillow')).toEqual({ loot: named('pillow') })
    expect(inventory.find('ability_familiar_ability02')).toEqual(where)
    expect(inventory.held('ability')[0]?.charges).toBe(0)
  })

  test('a new drop takes an empty slot, then the oldest spent one, then the oldest', () => {
    const inventory = new Inventory()
    for (const id of ['warp', 'leap', 'knockdown', 'hex']) {
      inventory.add(named(id))
    }
    spend(inventory, 'knockdown')
    spend(inventory, 'leap')
    expect(inventory.add(named('anchor'))).toMatchObject({
      slot: 1,
      replaced: named('leap'),
    })
    expect(inventory.add(named('shift'))).toMatchObject({
      slot: 2,
      replaced: named('knockdown'),
    })
    expect(inventory.add(named('unstoppable'))).toMatchObject({
      slot: 0,
      replaced: named('warp'),
    })
  })

  test('a copy of a spent drop makes it ready again', () => {
    const inventory = new Inventory()
    inventory.add(named('warp'))
    spend(inventory, 'warp')
    expect(inventory.add(named('warp'))).toMatchObject({
      slot: 0,
      stacked: true,
    })
    expect(inventory.held('item')[0]?.charges).toBe(1)
  })

  test('drop removes what matches and reports it', () => {
    const inventory = new Inventory()
    inventory.add(named('grapple'))
    inventory.add(named('pillow'))
    inventory.add(named('warp'))
    inventory.add(named('anchor'))
    const gone = inventory.drop((loot) => loot.role === 'mobility')
    expect(gone.map((loot) => loot.id).sort()).toEqual(['grapple', 'warp'])
    expect(inventory.find('ability_familiar_ability02')).toBeDefined()
    expect(inventory.find('upgrade_warp_stone')).toBeUndefined()
  })
})

describe('spent drops', () => {
  test('an ability empties its slot once its linger is up', () => {
    const inventory = new Inventory()
    inventory.add(named('hook'))
    expect(spend(inventory, 'hook', 900, 10)?.lingers).toBe(lingerSeconds)
    expect(inventory.watching()).toBe(false)
    expect(inventory.expire(10 + lingerSeconds - 0.05)).toEqual([])
    expect(inventory.expire(10 + lingerSeconds)).toEqual([
      {
        native: 'citadel_ability_hook',
        kind: 'ability',
        slot: 0,
        playedOut: false,
        after: lingerSeconds,
      },
    ])
    expect(inventory.held('ability')[0]).toBeUndefined()
    expect(inventory.settle(10 + lingerSeconds)).toBeUndefined()
  })

  test('a drop picked up again before it empties keeps its slot', () => {
    const inventory = new Inventory()
    inventory.add(named('hook'))
    spend(inventory, 'hook')
    inventory.add(named('hook'))
    expect(inventory.expire(lingerSeconds)).toEqual([])
    expect(inventory.held('ability')[0]?.charges).toBe(1)
  })

  test('an item is due again once its modifier has been gone two looks', () => {
    const inventory = new Inventory()
    inventory.add(named('anchor'))
    spend(inventory, 'anchor', 901, 0)
    expect(inventory.watching()).toBe(true)
    inventory.observe([{ ability: 901, age: 0.1 }], 0.25)
    inventory.observe([], 0.5)
    expect(inventory.expire(0.5)).toEqual([])
    inventory.observe([{ ability: 902, age: 0.1 }], 0.75)
    expect(inventory.expire(0.75)).toEqual([
      expect.objectContaining({ kind: 'item', slot: 0, playedOut: true }),
    ])
    expect(inventory.itemsDue).toBe(true)
    expect(inventory.settle(0.75)).toBe('rebuild')
    expect(inventory.itemsDue).toBe(false)
  })

  test('a modifier older than the cast is not its effect', () => {
    const inventory = new Inventory()
    inventory.add(named('anchor'))
    spend(inventory, 'anchor', 901, 3)
    inventory.observe([{ ability: 901, age: 3 }], 3.25)
    inventory.observe([], 3.5)
    inventory.observe([], 3.75)
    expect(inventory.expire(3.75)).toEqual([])
    expect(inventory.expire(3 + lingerSeconds)).toEqual([
      expect.objectContaining({ playedOut: false }),
    ])
  })

  test('items wait for the last item effect, and the wait is told once', () => {
    const inventory = new Inventory()
    inventory.add(named('warp'))
    inventory.add(named('cloak'))
    spend(inventory, 'cloak', 903, 0)
    spend(inventory, 'warp', 904, 0)
    expect(inventory.expire(lingerSeconds)).toHaveLength(1)
    expect(inventory.settle(lingerSeconds)).toBe(13)
    expect(inventory.settle(lingerSeconds + 1)).toBeUndefined()
    expect(inventory.expire(13)).toHaveLength(1)
    expect(inventory.settle(13)).toBe('rebuild')
  })

  test('an item that replaces another is due at once', () => {
    const inventory = new Inventory()
    for (const id of ['warp', 'leap', 'knockdown', 'hex']) {
      inventory.add(named(id))
    }
    expect(inventory.itemsDue).toBe(false)
    inventory.add(named('anchor'))
    expect(inventory.settle(0)).toBe('rebuild')
  })
})
