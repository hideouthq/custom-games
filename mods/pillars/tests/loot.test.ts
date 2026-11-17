import { describe, expect, test } from 'bun:test'
import {
  ammoEvery,
  catalog,
  dropsFor,
  freshPity,
  type Loot,
  moveEvery,
  repeatGap,
  repeats,
  roll,
  weights,
} from '../gameplay/loot'
import manifest from '../gameplay/mod.json'
import { arena } from '../gameplay/config'
import { pillarTop, random } from '../gameplay/seating'

function named(id: string): Loot {
  const loot = catalog.find((entry) => entry.id === id)
  if (loot === undefined) throw new Error('no loot ' + id)
  return loot
}

describe('catalog', () => {
  test('ids are unique, native loot names a game entry, every role can drop', () => {
    expect(new Set(catalog.map((loot) => loot.id)).size).toBe(catalog.length)
    for (const loot of catalog) {
      expect(loot.hint.length).toBeGreaterThan(0)
      expect(loot.native !== undefined).toBe(
        loot.kind === 'ability' || loot.kind === 'item' || loot.kind === 'buff',
      )
      expect(loot.modifier !== undefined).toBe(loot.kind === 'buff')
    }
    for (const role of Object.keys(weights)) {
      expect(catalog.some((loot) => loot.role === role)).toBe(true)
    }
  })

  test('leaves out loot that failed its same-team test', () => {
    expect(
      catalog.some((loot) => loot.native === 'upgrade_mystical_piano'),
    ).toBe(false)
  })
})

describe('roll', () => {
  test('abilities and items make up most drops, and Grapple is not common', () => {
    const next = random(11)
    const pity = freshPity()
    const drops = Array.from({ length: 4000 }, () => roll(next, pity, true))
    const share = (matches: (loot: Loot) => boolean) =>
      drops.filter(matches).length / drops.length
    const abilities = share((loot) => loot.kind === 'ability')
    expect(abilities).toBeGreaterThan(0.28)
    expect(share((loot) => loot.id === 'grapple')).toBeLessThan(0.1)
    expect(share((loot) => loot.role === 'stamina')).toBeGreaterThan(
      share((loot) => loot.id === 'grapple') * 2,
    )
    expect(share((loot) => loot.kind === 'item')).toBeGreaterThan(0.2)
    expect(
      share((loot) => loot.kind === 'ability' || loot.kind === 'item'),
    ).toBeGreaterThan(0.55)
    expect(share((loot) => loot.role === 'ammo')).toBeLessThan(0.2)
    expect(share((loot) => loot.role === 'stamina')).toBeLessThan(0.2)
  })

  test('ammo and movement never stay away longer than their guarantees', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed)
      const pity = freshPity()
      const roles = Array.from(
        { length: 200 },
        () => roll(next, pity, true).role,
      )
      for (let start = 0; start + ammoEvery <= roles.length; start++) {
        expect(roles.slice(start, start + ammoEvery)).toContain('ammo')
      }
      for (let start = 0; start + moveEvery + 1 <= roles.length; start++) {
        const window = roles.slice(start, start + moveEvery + 1)
        expect(
          window.some((role) => role === 'stamina' || role === 'mobility'),
        ).toBe(true)
      }
    }
  })

  test('no ability or item comes again within repeatGap drops', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed)
      const pity = freshPity()
      const drops = Array.from({ length: 300 }, () => roll(next, pity, true))
      for (let at = 1; at < drops.length; at++) {
        const drop = drops[at] as Loot
        if (repeats(drop)) continue
        const before = drops
          .slice(Math.max(0, at - repeatGap), at)
          .map((loot) => loot.id)
        expect(before).not.toContain(drop.id)
      }
    }
  })

  test('what a player holds does not drop again while another drop can', () => {
    const next = random(5)
    const pity = freshPity()
    const holding = new Set(['warp', 'pillow', 'anchor'])
    for (let drop = 0; drop < 500; drop++) {
      const drop = roll(next, pity, true, catalog, holding)
      expect(holding.has(drop.id)).toBe(false)
    }
  })

  test('a Medkit drops only to a hurt player', () => {
    const rolled = (hurt: boolean) => {
      const next = random(9)
      const pity = freshPity()
      return Array.from(
        { length: 2000 },
        () => roll(next, pity, true, dropsFor(hurt)).id,
      )
    }
    expect(rolled(false)).not.toContain('medkit')
    expect(rolled(true)).toContain('medkit')
  })

  test('without mobility neither stamina nor mobility drops', () => {
    const next = random(7)
    const pity = freshPity()
    for (let drop = 0; drop < 300; drop++) {
      const role = roll(next, pity, false).role
      expect(role === 'stamina' || role === 'mobility').toBe(false)
    }
  })

  test('every entry turns up and the same seed repeats', () => {
    const seen = new Set<string>()
    const next = random(3)
    const pity = freshPity()
    for (let drop = 0; drop < 2000; drop++) seen.add(roll(next, pity, true).id)
    expect(seen.size).toBe(catalog.length)
    const again = (seed: number) => {
      const generator = random(seed)
      const state = freshPity()
      return Array.from({ length: 30 }, () => roll(generator, state, true).id)
    }
    expect(again(11)).toEqual(again(11))
  })
})

describe('reach', () => {
  test('every drop aimed at a player reaches from any pillar to any other', () => {
    const tops = Array.from({ length: arena.pillars }, (_, index) =>
      pillarTop(index),
    )
    const farthest =
      Math.max(
        ...tops.flatMap((from) =>
          tops.map((to) => Math.hypot(to.x - from.x, to.y - from.y)),
        ),
      ) +
      arena.topSize * Math.SQRT2
    const aimed = catalog.filter(
      (loot) => loot.role === 'force' || ['lasso', 'shrink'].includes(loot.id),
    )
    for (const loot of aimed) {
      const range = manifest.definitions.find(
        (definition) => definition.entry === loot.native,
      )?.properties?.AbilityCastRange
      expect({ id: loot.id, reaches: (range ?? 0) >= farthest }).toEqual({
        id: loot.id,
        reaches: true,
      })
    }
  })
})
