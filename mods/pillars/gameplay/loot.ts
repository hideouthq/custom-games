// Opponents can share a team, so every native entry here must work on a
// teammate. Mystical Piano and Vortex Web do not.

export type Role =
  | 'ammo'
  | 'stamina'
  | 'mobility'
  | 'force'
  | 'defence'
  | 'legendary'

export type Kind =
  | 'ammo'
  | 'stamina'
  | 'heal'
  | 'infinite'
  | 'buff'
  | 'ability'
  | 'item'

export interface Loot {
  readonly id: string
  readonly label: string
  readonly role: Role
  readonly kind: Kind
  readonly native?: string
  readonly charges: number
  readonly hint: string
  readonly share?: number
  readonly modifier?: string
  readonly lasts?: number
  readonly linger?: number
}

export const lingerSeconds = 8

export const catalog: readonly Loot[] = [
  {
    id: 'ammo',
    label: 'Ammo Crate',
    role: 'ammo',
    kind: 'ammo',
    charges: 1,
    hint: 'More rounds for your gun.',
  },
  {
    id: 'pip',
    label: 'Stamina Pip',
    role: 'stamina',
    kind: 'stamina',
    charges: 1,
    hint: 'One more stamina for a dash or an air jump.',
  },
  {
    id: 'warp',
    label: 'Warp Stone',
    role: 'mobility',
    kind: 'item',
    native: 'upgrade_warp_stone',
    charges: 1,
    hint: 'Blink 11 m the way you face.',
  },
  {
    id: 'leap',
    label: 'Majestic Leap',
    role: 'mobility',
    kind: 'item',
    native: 'upgrade_rocket_booster',
    charges: 1,
    hint: 'Launch high and far through the air.',
  },
  {
    id: 'fleetfoot',
    label: 'Fleetfoot',
    role: 'mobility',
    kind: 'item',
    native: 'upgrade_fleetfoot_boots',
    charges: 1,
    hint: 'Run much faster for a few seconds.',
  },
  {
    id: 'grapple',
    label: 'Grapple',
    role: 'mobility',
    kind: 'ability',
    native: 'citadel_ability_lash',
    charges: 1,
    share: 1,
    hint: 'Pull yourself to where you aim, up to 30 m.',
  },
  {
    id: 'bounce',
    label: 'Bounce Pad',
    role: 'mobility',
    kind: 'ability',
    native: 'ability_bounce_pad',
    charges: 1,
    // The pad lasts 22 s.
    linger: 23,
    hint: 'Drop a pad that springs anyone who lands on it high into the air.',
  },
  {
    id: 'icepath',
    label: 'Ice Path',
    role: 'mobility',
    kind: 'ability',
    native: 'ability_icepath',
    charges: 1,
    // The path lasts 8 s.
    linger: 9,
    hint: 'Glide along an ice bridge you build through the air.',
  },
  {
    id: 'pillow',
    label: 'Pillow Toss',
    role: 'force',
    kind: 'ability',
    native: 'ability_familiar_ability02',
    charges: 1,
    hint: 'Throw a pillow that knocks a player back.',
  },
  {
    id: 'punch',
    label: 'Puddle Punch',
    role: 'force',
    kind: 'ability',
    native: 'viscous_telepunch',
    charges: 1,
    hint: 'Punch a player up and away from range.',
  },
  {
    id: 'swap',
    label: 'Paradoxical Swap',
    role: 'force',
    kind: 'ability',
    native: 'citadel_ability_chrono_swap',
    charges: 1,
    hint: 'Trade places with the player you aim at.',
  },
  {
    id: 'hook',
    label: 'Hook',
    role: 'force',
    kind: 'ability',
    native: 'citadel_ability_hook',
    charges: 1,
    hint: 'Hook the player you aim at and drag them to you.',
  },
  {
    id: 'knockdown',
    label: 'Knockdown',
    role: 'force',
    kind: 'item',
    native: 'upgrade_target_stun',
    charges: 1,
    hint: 'Stun a player after a short delay.',
  },
  {
    id: 'hex',
    label: 'Slowing Hex',
    role: 'force',
    kind: 'item',
    native: 'upgrade_containment',
    charges: 1,
    hint: 'Lock a player out of movement abilities.',
  },
  {
    id: 'anchor',
    label: 'Anchor',
    role: 'defence',
    kind: 'item',
    native: 'upgrade_metal_skin',
    charges: 1,
    hint: 'Bullets cannot hurt you for 5 s.',
  },
  {
    id: 'shift',
    label: 'Ethereal Shift',
    role: 'defence',
    kind: 'item',
    native: 'upgrade_self_bubble',
    charges: 1,
    hint: 'Nothing can touch you for 4 s.',
  },
  {
    id: 'unstoppable',
    label: 'Unstoppable',
    role: 'defence',
    kind: 'item',
    native: 'upgrade_unstoppable',
    charges: 1,
    hint: 'Stuns and slows cannot stop you for 5 s.',
  },
  {
    id: 'cloak',
    label: 'Cloaking Device',
    role: 'defence',
    kind: 'item',
    native: 'upgrade_cloaking_device_active',
    charges: 1,
    // Invisibility lasts until a hit or 13 s.
    linger: 13,
    hint: 'Turn invisible until you take a hit.',
  },
  {
    id: 'medkit',
    label: 'Medkit',
    role: 'defence',
    kind: 'heal',
    charges: 1,
    hint: 'Restores 250 health.',
  },
  {
    id: 'flight',
    label: 'Flight',
    role: 'legendary',
    kind: 'ability',
    native: 'citadel_ability_hornet_leap',
    charges: 1,
    hint: 'Take off and fly for a few seconds.',
  },
  {
    id: 'lasso',
    label: 'Spirit Lasso',
    role: 'legendary',
    kind: 'ability',
    native: 'ability_gravity_lasso',
    charges: 1,
    hint: 'Lasso the player you aim at and drag them through the air.',
  },
  {
    id: 'carpet',
    label: 'Magic Carpet',
    role: 'legendary',
    kind: 'item',
    native: 'upgrade_magic_carpet',
    charges: 1,
    // The ride lasts 12 s.
    linger: 14,
    hint: 'Ride a flying carpet for a few seconds.',
  },
  {
    id: 'shrink',
    label: 'Shrink Ray',
    role: 'legendary',
    kind: 'item',
    native: 'upgrade_shrink_ray',
    charges: 1,
    linger: 11,
    hint: 'Shrink a player for 10 s: small, fast and hard to hit.',
  },
  {
    id: 'wings',
    label: 'Seraphim Wings',
    role: 'legendary',
    // Holding the item instead leaves its butterflies behind once the item
    // is taken away.
    kind: 'buff',
    native: 'upgrade_icarus_wings',
    modifier: 'modifier_icarus_wings',
    charges: 1,
    lasts: 20,
    hint: 'Low gravity for 20 s: jump higher, fall slower.',
  },
  {
    id: 'infinite',
    label: 'Infinite Rounds',
    role: 'legendary',
    kind: 'infinite',
    charges: 1,
    hint: 'Your gun does not run dry for 8 s.',
  },
]

const unhurt = catalog.filter((loot) => loot.kind !== 'heal')

/** A Medkit does nothing at full health. */
export function dropsFor(hurt: boolean): readonly Loot[] {
  return hurt ? catalog : unhurt
}

export const weights: Readonly<Record<Role, number>> = {
  ammo: 10,
  stamina: 14,
  mobility: 18,
  force: 32,
  defence: 18,
  legendary: 8,
}

export const abilityShare = 3

export const ammoEvery = 8
export const moveEvery = 4

export const repeatGap = 3

export function repeats(loot: Loot): boolean {
  return loot.kind === 'ammo' || loot.kind === 'stamina'
}

export interface Pity {
  sinceAmmo: number
  sinceMove: number
  recent: string[]
}

export function freshPity(): Pity {
  return { sinceAmmo: 0, sinceMove: 0, recent: [] }
}

function moves(loot: Loot): boolean {
  return (
    loot.role === 'stamina' || loot.role === 'mobility' || loot.id === 'flight'
  )
}

function countsAsMove(loot: Loot): boolean {
  return loot.role === 'stamina' || loot.role === 'mobility'
}

export function roll(
  random: () => number,
  pity: Pity,
  mobility: boolean,
  from: readonly Loot[] = catalog,
  holding: ReadonlySet<string> = new Set(),
): Loot {
  let choices = mobility ? from : from.filter((loot) => !moves(loot))
  if (pity.sinceAmmo >= ammoEvery - 1) {
    choices = choices.filter((loot) => loot.role === 'ammo')
  } else if (mobility && pity.sinceMove >= moveEvery - 1) {
    choices = choices.filter(countsAsMove)
  }
  const fresh = choices.filter(
    (loot) =>
      repeats(loot) ||
      (!pity.recent.includes(loot.id) && !holding.has(loot.id)),
  )
  if (fresh.length > 0) {
    choices = fresh
  }

  const roles = [...new Set(choices.map((loot) => loot.role))]
  const total = roles.reduce((sum, role) => sum + weights[role], 0)
  let mark = random() * total
  let role = roles[roles.length - 1] as Role
  for (const candidate of roles) {
    mark -= weights[candidate]
    if (mark < 0) {
      role = candidate
      break
    }
  }
  const entries = choices.filter((loot) => loot.role === role)
  const share = (loot: Loot) =>
    loot.share ?? (loot.kind === 'ability' ? abilityShare : 1)
  let point = random() * entries.reduce((sum, loot) => sum + share(loot), 0)
  let picked = entries[entries.length - 1] as Loot
  for (const entry of entries) {
    point -= share(entry)
    if (point < 0) {
      picked = entry
      break
    }
  }

  pity.sinceAmmo = picked.role === 'ammo' ? 0 : pity.sinceAmmo + 1
  pity.sinceMove = countsAsMove(picked) ? 0 : pity.sinceMove + 1
  pity.recent.push(picked.id)
  if (pity.recent.length > repeatGap) {
    pity.recent.shift()
  }
  return picked
}

export function legendary(
  random: () => number,
  from: readonly Loot[] = catalog,
): Loot | undefined {
  const entries = from.filter((loot) => loot.role === 'legendary')
  return entries[
    Math.min(entries.length - 1, Math.floor(random() * entries.length))
  ]
}

export interface Held {
  readonly loot: Loot
  charges: number
  order: number
}

export const slotCount = 4

export interface Gain {
  readonly kind: 'ability' | 'item'
  readonly slot: number
  readonly replaced?: Loot
  readonly stacked: boolean
}

/**
 * A spent drop keeps its slot until a new drop needs it: taking it away cuts
 * short effects still playing out, and rebuilding the items replays their
 * passive effects.
 */
export class Inventory {
  readonly abilities: (Held | undefined)[] = new Array<Held | undefined>(
    slotCount,
  ).fill(undefined)
  readonly items: (Held | undefined)[] = new Array<Held | undefined>(
    slotCount,
  ).fill(undefined)
  private picked = 0

  private slots(kind: 'ability' | 'item'): (Held | undefined)[] {
    return kind === 'ability' ? this.abilities : this.items
  }

  add(loot: Loot): Gain | undefined {
    if (loot.kind !== 'ability' && loot.kind !== 'item') {
      return undefined
    }
    const kind = loot.kind
    const slots = this.slots(kind)
    this.picked++

    const same = slots.findIndex((held) => held?.loot.id === loot.id)
    if (same >= 0) {
      const held = slots[same] as Held
      held.charges += loot.charges
      held.order = this.picked
      return { kind, slot: same, stacked: true }
    }

    let slot = slots.findIndex((held) => held === undefined)
    if (slot < 0) {
      slot = oldest(slots, (held) => held.charges <= 0)
    }
    if (slot < 0) {
      slot = oldest(slots, () => true)
    }
    const replaced = slots[slot]?.loot
    slots[slot] = { loot, charges: loot.charges, order: this.picked }
    return { kind, slot, replaced, stacked: false }
  }

  find(native: string): { kind: 'ability' | 'item'; slot: number } | undefined {
    for (const kind of ['ability', 'item'] as const) {
      const slot = this.slots(kind).findIndex(
        (held) => held?.loot.native === native,
      )
      if (slot >= 0) {
        return { kind, slot }
      }
    }
    return undefined
  }

  spend(kind: 'ability' | 'item', slot: number): number | undefined {
    const held = this.slots(kind)[slot]
    if (held === undefined || held.charges <= 0) {
      return undefined
    }
    held.charges--
    return held.charges
  }

  clear(kind: 'ability' | 'item', slot: number): void {
    this.slots(kind)[slot] = undefined
  }

  drop(matches: (loot: Loot) => boolean): Loot[] {
    const gone: Loot[] = []
    for (const slots of [this.abilities, this.items]) {
      for (const [index, held] of slots.entries()) {
        if (held !== undefined && matches(held.loot)) {
          gone.push(held.loot)
          slots[index] = undefined
        }
      }
    }
    return gone
  }

  held(kind: 'ability' | 'item'): readonly (Held | undefined)[] {
    return this.slots(kind)
  }

  ready(): Set<string> {
    return new Set(
      [...this.abilities, ...this.items].flatMap((held) =>
        held !== undefined && held.charges > 0 ? [held.loot.id] : [],
      ),
    )
  }
}

function oldest(
  slots: readonly (Held | undefined)[],
  matches: (held: Held) => boolean,
): number {
  let found = -1
  for (const [index, held] of slots.entries()) {
    if (
      held !== undefined &&
      matches(held) &&
      (found < 0 || held.order < (slots[found]?.order ?? 0))
    ) {
      found = index
    }
  }
  return found
}
