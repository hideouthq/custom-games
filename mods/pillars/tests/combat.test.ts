import { describe, expect, test } from 'bun:test'
import { Credit, knock, meleeDamage, meleeOf } from '../gameplay/combat'
import { arena, combat, rules, unitsPerMetre } from '../gameplay/config'
import {
  assignHero,
  crateRounds,
  pool,
  reserveAfter,
  reserveLimit,
} from '../gameplay/heroes'
import {
  deckSpot,
  facingCentre,
  pillarStand,
  pillarTop,
  random,
  seats,
} from '../gameplay/seating'
import layout from '../scripts/arena.json'

describe('melee', () => {
  test('reads the live flag words', () => {
    expect(meleeOf(0x1410000002n)).toBe('light')
    expect(meleeOf(0x1210000002n)).toBe('heavy')
    expect(meleeOf(0x2n)).toBeUndefined()
    expect(meleeDamage('light')).toBe(50)
    expect(meleeDamage('heavy')).toBe(116)
  })
})

describe('knock', () => {
  const from = { x: 0, y: 0, z: 0 }
  const to = { x: 100, y: 0, z: 0 }

  test('throws away from the attacker with lift', () => {
    const push = knock(from, to, 'heavy', 0, 1)
    expect(push.x).toBeCloseTo(combat.knock.heavy * unitsPerMetre)
    expect(push.y).toBeCloseTo(0)
    expect(push.z).toBeCloseTo(
      combat.knock.heavy * combat.liftRatio * unitsPerMetre,
    )
  })

  test('doubles at no health, clamps the fraction and caps the lift', () => {
    const full = knock(from, to, 'light', 0, 1)
    const empty = knock(from, to, 'light', 1, 1)
    expect(empty.x).toBeCloseTo(full.x * 2)
    expect(knock(from, to, 'light', 5, 1).x).toBeCloseTo(empty.x)
    expect(knock(from, to, 'heavy', 1, 1).z).toBeCloseTo(
      combat.maxLift * unitsPerMetre,
    )
    expect(knock(from, to, 'heavy', 0, 2).x).toBeCloseTo(
      full.x * 2 * (combat.knock.heavy / combat.knock.light),
    )
  })

  test('picks a direction when both stand on one spot', () => {
    const push = knock(from, from, 'light', 0, 1)
    expect(Math.hypot(push.x, push.y)).toBeCloseTo(
      combat.knock.light * unitsPerMetre,
    )
  })
})

describe('credit', () => {
  test('lasts the credit window and ignores self hits', () => {
    const credit = new Credit()
    credit.hit(1, 2, 10)
    credit.hit(3, 3, 10)
    expect(credit.of(1, 10 + rules.creditSeconds)).toBe(2)
    expect(credit.of(1, 10 + rules.creditSeconds + 0.1)).toBeUndefined()
    expect(credit.of(3, 10)).toBeUndefined()
    credit.clear()
    expect(credit.of(1, 10)).toBeUndefined()
  })
})

describe('heroes', () => {
  test('the pool has one hero per seat', () => {
    expect(pool.length).toBe(rules.maxPlayers)
    expect(new Set(pool.map((hero) => hero.name)).size).toBe(pool.length)
  })

  test('the pool takes each id and title from the hero table', () => {
    expect(pool.map((hero) => [hero.name, hero.id, hero.label])).toEqual([
      ['hero_atlas', 6, 'Abrams'],
      ['hero_punkgoat', 72, 'Billy'],
      ['hero_werewolf', 80, 'Silver'],
      ['hero_viscous', 35, 'Viscous'],
      ['hero_tengu', 20, 'Ivy'],
      ['hero_hornet', 3, 'Vindicta'],
      ['hero_lash', 31, 'Lash'],
      ['hero_yamato', 27, 'Yamato'],
    ])
  })

  test('a crate is worth about the same damage for every hero', () => {
    for (const hero of pool) {
      const damage = crateRounds(hero) * hero.roundDamage
      expect(damage).toBeGreaterThanOrEqual(combat.ammoBudget)
      expect(damage).toBeLessThan(combat.ammoBudget + hero.roundDamage)
    }
  })

  test('an Ammo Crate fills the reserve up to its limit', () => {
    for (const hero of pool) {
      expect(reserveAfter(hero, 0)).toBe(
        Math.min(reserveLimit(hero), crateRounds(hero)),
      )
      expect(reserveAfter(hero, reserveLimit(hero))).toBe(reserveLimit(hero))
      expect(reserveAfter(hero, -4)).toBe(
        Math.min(reserveLimit(hero), crateRounds(hero)),
      )
      expect(reserveLimit(hero)).toBeGreaterThanOrEqual(hero.clip)
    }
  })

  test('assigns a free hero, and any hero once all are taken', () => {
    const taken = new Set(pool.slice(1).map((hero) => hero.name))
    expect(assignHero(taken, random(1)).name).toBe(pool[0]?.name ?? '')
    const all = new Set(pool.map((hero) => hero.name))
    expect(all.has(assignHero(all, () => 0.999).name)).toBe(true)
  })
})

describe('seating', () => {
  test('the config matches the map generator', () => {
    expect(layout.unitsPerMetre).toBe(unitsPerMetre)
    expect({
      pillars: layout.pillars,
      ringRadius: layout.ringRadius,
      topSize: layout.topSize,
      topZ: layout.topZ,
      centreRadius: layout.centreRadius,
      centreZ: layout.centreZ,
      standOffset: layout.standOffset,
    }).toEqual({ ...arena })
  })

  test('neighbouring tops are 16 m apart edge to edge', () => {
    const a = pillarTop(0)
    const b = pillarTop(1)
    const gap =
      (Math.hypot(a.x - b.x, a.y - b.y) - arena.topSize) / unitsPerMetre
    expect(gap).toBeGreaterThan(15.5)
    expect(gap).toBeLessThan(16.5)
    expect(facingCentre(0)).toBe(180)
    expect(facingCentre(arena.pillars / 2)).toBe(0)
  })

  test('a hero starts on the top, clear of its wall', () => {
    for (let index = 0; index < arena.pillars; index++) {
      const top = pillarTop(index)
      const stand = pillarStand(index)
      const aside = Math.hypot(stand.x - top.x, stand.y - top.y)
      expect(aside).toBeGreaterThan(layout.wallThickness / 2 + 30)
      expect(aside).toBeLessThan(arena.topSize / 2 - 30)
      const along = (stand.x * top.x + stand.y * top.y) / arena.ringRadius
      expect(Math.abs(along - arena.ringRadius)).toBeLessThan(1)
    }
  })

  test('small lobbies sit together and nobody shares a pillar', () => {
    expect(seats(2, 0)).toEqual([0, 1])
    expect(seats(4, 8)).toEqual([8, 9, 0, 1])
    expect(seats(5, 1)).toEqual([1, 3, 5, 7, 9])
    expect(seats(6, 1)).toEqual([1, 2, 4, 6, 7, 9])
    for (let count = 0; count <= arena.pillars; count++) {
      for (let offset = 0; offset < arena.pillars; offset++) {
        const taken = seats(count, offset)
        expect(new Set(taken).size).toBe(count)
        expect(
          taken.every((pillar) => pillar >= 0 && pillar < arena.pillars),
        ).toBe(true)
      }
    }
    expect(seats(20, 0).length).toBe(arena.pillars)
  })

  test('final stand spots stay on the deck and apart', () => {
    const spots = Array.from({ length: 8 }, (_unused, index) =>
      deckSpot(index, 8),
    )
    for (const spot of spots) {
      expect(Math.hypot(spot.x, spot.y)).toBeLessThan(arena.centreRadius - 40)
      expect(spot.z).toBe(arena.centreZ)
    }
    const [first, second] = spots
    if (first === undefined || second === undefined) throw new Error('no spots')
    expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(
      60,
    )
    expect(deckSpot(0, 1)).toEqual({ x: 0, y: 0, z: arena.centreZ })
  })
})
