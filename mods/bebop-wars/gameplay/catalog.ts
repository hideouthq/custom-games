import { globeRules } from './globe.ts'

export type Setup = 'snowGlobe' | 'knockdown' | 'piano'
export type Utility = 'sprint' | 'echo' | 'shrinkRay'
export type Defense = 'etherealShift' | 'rescueBeam'
export type ProductId = Setup | Utility | Defense
export type Group = 'setup' | 'utility' | 'defense'
export type HookRank = 0 | 1 | 2 | 3
export const hookAbility = 'citadel_ability_hook'

export interface Stat { readonly value: string; readonly label: string }

interface Product {
  readonly name: string
  readonly nativeItem: string
  readonly price: number
  readonly group: Group
  readonly cooldown: number
  readonly teamOnly?: boolean
  /** The game holds an aimed native item selected until its cast is confirmed on a hero in the sights. */
  readonly aimed?: boolean
  readonly category: 'weapon' | 'spirit'
  readonly tier: 1 | 2
  readonly description: string
  readonly stats: readonly Stat[]
}

export const catalog: Readonly<Record<ProductId, Product>> = {
  snowGlobe: {
    name: 'Snow Globe', nativeItem: 'upgrade_cold_front', price: 300, group: 'setup', cooldown: globeRules.cooldown, category: 'spirit', tier: 1,
    description: 'Throw a snowball, then press the item key again to burst it. Enemies caught in the burst are slowed and lose their momentum. It also bursts on walls and at max range. Deals no damage.',
    stats: [
      { value: `${globeRules.slow * 100}%`, label: 'Movement Slow' }, { value: `${globeRules.chill}s`, label: 'Slow Duration' },
      { value: `${globeRules.radiusMeters}m`, label: 'Burst Radius' }, { value: '30m', label: 'Range' },
    ],
  },
  sprint: {
    name: 'Sprint', nativeItem: 'upgrade_fleetfoot_boots', price: 300, group: 'utility', cooldown: 15, category: 'weapon', tier: 1,
    description: 'A burst of speed to dodge a Hook or reposition.',
    stats: [{ value: '+5m/s', label: 'Move Speed' }, { value: '3s', label: 'Duration' }],
  },
  echo: {
    name: 'Echo Shard', nativeItem: 'upgrade_ability_power_shard', price: 600, group: 'utility', cooldown: 20, category: 'spirit', tier: 2,
    description: 'Readies Hook again once it has returned, so you can throw twice in a row.',
    stats: [{ value: 'Reset', label: 'Hook Cooldown' }],
  },
  knockdown: {
    name: 'Knockdown', nativeItem: 'upgrade_grit', price: 300, group: 'setup', cooldown: 24, category: 'spirit', tier: 1,
    description: 'Mark an enemy in your sights. After a delay they are stunned in place. Time your Hook for the stun.',
    stats: [{ value: '2s', label: 'Stun Delay' }, { value: '0.9s', label: 'Stun Duration' }, { value: '30m', label: 'Range' }],
  },
  piano: {
    name: 'Mystical Piano', nativeItem: 'upgrade_return_fire', price: 600, group: 'setup', cooldown: 35, category: 'spirit', tier: 2,
    description: 'Drop a piano on the ground you aim at. When it lands, enemies still under it are stunned. Hook them before they get up.',
    stats: [{ value: '1.7s', label: 'Fall Time' }, { value: '1s', label: 'Stun Duration' }, { value: '9m', label: 'Radius' }, { value: '25m', label: 'Range' }],
  },
  shrinkRay: {
    name: 'Shrink Ray', nativeItem: 'upgrade_shrink_ray', price: 600, group: 'utility', cooldown: 25, category: 'spirit', tier: 2,
    description: 'Shrink yourself. A smaller Bebop is harder to hook, and a little faster.',
    stats: [{ value: '-50%', label: 'Size' }, { value: '+2m/s', label: 'Move Speed' }, { value: '6s', label: 'Duration' }],
  },
  etherealShift: {
    name: 'Ethereal Shift', nativeItem: 'upgrade_self_bubble', price: 300, group: 'defense', cooldown: 22, category: 'spirit', tier: 1,
    description: 'Step out of the world for a moment. Nothing can hit you, a Hook included, and you cannot act.',
    stats: [{ value: '1.5s', label: 'Duration' }],
  },
  rescueBeam: {
    name: 'Rescue Beam', nativeItem: 'upgrade_rescue_beam', price: 600, group: 'defense', cooldown: 30, category: 'weapon', tier: 2, teamOnly: true, aimed: true,
    description: 'Channel a beam onto a teammate, healing them. Press again while it holds to pull them to you.',
    stats: [{ value: '10%', label: 'Max Health Healed' }, { value: '2.5s', label: 'Channel' }, { value: '35m', label: 'Range' }],
  },
}

export const productIds: readonly ProductId[] = ['snowGlobe', 'knockdown', 'piano', 'sprint', 'echo', 'shrinkRay', 'etherealShift', 'rescueBeam']
export const groups: readonly Group[] = ['setup', 'utility', 'defense']
export function isProductId(value: unknown): value is ProductId { return typeof value === 'string' && (productIds as readonly string[]).includes(value) }
export function isSetup(value: unknown): value is Setup { return isProductId(value) && catalog[value].group === 'setup' }
export function isUtility(value: unknown): value is Utility { return isProductId(value) && catalog[value].group === 'utility' }
export function isDefense(value: unknown): value is Defense { return isProductId(value) && catalog[value].group === 'defense' }
// The game only lets Mystical Piano and Shrink Ray be cast in Street Brawl, and its own Knockdown stays selected when pressed with nobody in the sights.
export function scripted(product: ProductId): product is 'snowGlobe' | 'sprint' | 'echo' | 'knockdown' | 'piano' | 'shrinkRay' { return product !== 'etherealShift' && product !== 'rescueBeam' }
export const shrinkSeconds = 6
export function isHookRank(value: unknown): value is HookRank { return value === 0 || value === 1 || value === 2 || value === 3 }

export const economy = {
  starting: 300, passive: 25, passiveSeconds: 10, kill: 100, teamKill: 50,
  rescue: 25, rescueLimit: 75, rescueWindow: 60, comebackDeficit: 4,
  comebackKill: 150, comebackTeamKill: 75,
} as const
export const startingSouls = economy.starting
export function warmupBudget(owned: readonly ProductId[]): number { return Math.max(0, startingSouls - owned.reduce((sum, product) => sum + catalog[product].price, 0)) }
export function earnedAbilityPoints(kills: number): number { return Math.min(8, Math.max(0, Math.floor(kills) - 2)) }
export function spentAbilityPoints(rank: HookRank): number { return [0, 1, 3, 8][rank] ?? 0 }
export function hookProfile(rank: HookRank): { rangeMeters: number; cooldown: number; rebound: number } {
  return { rangeMeters: rank >= 1 ? 36 : 30, cooldown: rank >= 2 ? 4 : 5, rebound: rank === 3 ? 1 : 0 }
}
