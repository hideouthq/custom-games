// clip and roundDamage, all pellets landing at close range, come from the
// game's scripts/heroes.vdata and abilities.vdata (build 26472578). They only
// size the Ammo Crate; the game still owns each gun's real damage.
import { heroNamed } from 'modlock'

import { combat } from './config'

export interface PoolHero {
  readonly id: number
  readonly name: string
  readonly label: string
  readonly clip: number
  readonly roundDamage: number
}

function poolHero(name: string, clip: number, roundDamage: number): PoolHero {
  const hero = heroNamed(name)
  if (hero === undefined) {
    throw new Error(`no released hero is named ${name}`)
  }
  return { id: hero.id, name: hero.name, label: hero.title, clip, roundDamage }
}

export const pool: readonly PoolHero[] = [
  poolHero('hero_atlas', 9, 34.02),
  poolHero('hero_punkgoat', 30, 6.3),
  poolHero('hero_werewolf', 7, 35.7),
  poolHero('hero_viscous', 20, 10.34),
  poolHero('hero_tengu', 33, 4.45),
  poolHero('hero_hornet', 19, 12.33),
  poolHero('hero_lash', 29, 8.46),
  poolHero('hero_yamato', 12, 26.55),
]

export const donors: readonly string[] = [
  'hero_familiar',
  'hero_chrono',
  'hero_astro',
  'hero_bebop',
  'hero_inferno',
  'hero_wraith',
  'hero_kelvin',
]

export function crateRounds(hero: PoolHero): number {
  return Math.max(1, Math.ceil(combat.ammoBudget / hero.roundDamage))
}

export function reserveLimit(hero: PoolHero): number {
  return Math.ceil(hero.clip * combat.reserveCap)
}

export function reserveAfter(hero: PoolHero, reserve: number): number {
  return Math.min(reserveLimit(hero), Math.max(0, reserve) + crateRounds(hero))
}

export function assignHero(
  taken: ReadonlySet<string>,
  random: () => number,
): PoolHero {
  const free = pool.filter((hero) => !taken.has(hero.name))
  const from = free.length > 0 ? free : pool
  const index = Math.min(from.length - 1, Math.floor(random() * from.length))
  return from[index] as PoolHero
}
