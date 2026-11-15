import type { Group, ProductId, Stat, Utility } from './catalog.ts'
export type { Utility } from './catalog.ts'
export type Side = 2 | 3

export type HudAction =
  | { kind: 'ready' }
  | { kind: 'team'; side: Side }
  | { kind: 'shop' }
  | { kind: 'close' }
  | { kind: 'buy'; product: ProductId }
  | { kind: 'equip'; utility: ProductId }

export interface RosterView {
  readonly id: string
  readonly name: string
  readonly side: Side
  readonly status: string
  readonly kills: number
  readonly saves: number
  readonly self: boolean
  readonly respawn: number | null
}

export interface ProductView {
  readonly id: ProductId
  readonly name: string
  readonly price: number
  readonly cooldown: number
  readonly description: string
  readonly group: Group
  readonly category: 'weapon' | 'spirit'
  readonly tier: 1 | 2
  readonly stats: readonly Stat[]
  readonly shortfall: number
  readonly state: 'buy' | 'unaffordable' | 'owned' | 'equipped' | 'pending' | 'locked'
  readonly label: string
  readonly detail: string
  readonly action: HudAction | null
}

export interface HudView {
  readonly now: number
  readonly lastThirty: boolean
  readonly purchaseNotice: string
  readonly phase: 'warmup' | 'countdown' | 'live' | 'overtime' | 'results'
  readonly teamSize: 1 | 2 | 3
  readonly side: Side | undefined
  readonly score: Readonly<Record<Side, number>>
  readonly target: number
  readonly clock: string
  readonly heading: string
  readonly detail: string
  readonly roster: readonly RosterView[]
  readonly feed: readonly { id: number; text: string; side: Side | undefined }[]
  readonly notice: string
  readonly menu: 'closed' | 'loadout'
  readonly utility: Utility | null
  readonly ready: boolean
  readonly canReady: boolean
  readonly canShop: boolean
  readonly waitingForNextMatch: boolean
  readonly respawn: number | null
  readonly wallet: number
  readonly native: { readonly items: readonly { readonly product: ProductId; readonly slot: number }[]; readonly generation: number; readonly slot: number; readonly hookRank: number; readonly range: number; readonly cooldown: number }
  readonly shop: { readonly products: readonly ProductView[]; readonly allowed: boolean; readonly reason: string }
  readonly debug: readonly string[]
}
