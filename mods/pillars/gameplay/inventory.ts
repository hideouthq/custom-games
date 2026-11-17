import { lingerSeconds, type Loot } from './loot'

export type SlotKind = 'ability' | 'item'

export interface Held {
  readonly loot: Loot
  charges: number
  order: number
}

export interface Gain {
  readonly kind: SlotKind
  readonly slot: number
  readonly replaced?: Loot
  readonly stacked: boolean
}

export interface Emptied {
  readonly native: string
  readonly kind: SlotKind
  readonly slot: number
  readonly playedOut: boolean
  readonly after: number
}

const slotCount = 4

const goneLooks = 2

const ageSlack = 0.2

interface Emptying {
  readonly native: string
  readonly kind: SlotKind
  readonly ability: number
  readonly at: number
  readonly until: number
  readonly watched: boolean
  seen: boolean
  gone: number
}

/**
 * A spent drop keeps its slot until a new drop needs it: taking it away cuts
 * short effects still playing out, and rebuilding the items replays their
 * passive effects.
 */
export class Inventory {
  private readonly abilities: (Held | undefined)[] = new Array<
    Held | undefined
  >(slotCount).fill(undefined)
  private readonly items: (Held | undefined)[] = new Array<Held | undefined>(
    slotCount,
  ).fill(undefined)
  private picked = 0
  private emptying: Emptying[] = []
  /**
   * Giving items again cuts short, and leaves behind the particles of, any
   * item effect still playing.
   */
  private due = false
  private lockedUntil = 0

  private slots(kind: SlotKind): (Held | undefined)[] {
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
      held.charges++
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
    slots[slot] = { loot, charges: 1, order: this.picked }
    if (kind === 'item' && replaced !== undefined) {
      this.due = true
    }
    return { kind, slot, replaced, stacked: false }
  }

  find(native: string): { kind: SlotKind; slot: number } | undefined {
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

  /**
   * spend takes a charge of the drop cast as native. It reports the drop,
   * and how long its slot lingers when that was the last charge.
   */
  spend(
    native: string,
    ability: number,
    now: number,
  ): { loot: Loot; lingers?: number } | undefined {
    const where = this.find(native)
    const held =
      where === undefined ? undefined : this.slots(where.kind)[where.slot]
    if (where === undefined || held === undefined) {
      return undefined
    }
    if (held.charges <= 0) {
      return { loot: held.loot }
    }
    held.charges--
    if (held.charges > 0) {
      return { loot: held.loot }
    }
    const lingers = held.loot.linger ?? lingerSeconds
    this.emptying.push({
      native,
      kind: where.kind,
      ability,
      at: now,
      until: now + lingers,
      // An ability waits out its time: a shove still in flight, a pad or a
      // path holds no modifier, and replacing the ability mid-flight cancels
      // it.
      watched: where.kind === 'item',
      seen: false,
      gone: 0,
    })
    return { loot: held.loot, lingers }
  }

  /** watching reports a spent item whose effect may still be playing. */
  watching(): boolean {
    return this.emptying.some((timer) => timer.watched)
  }

  /** observe matches spent items against the modifiers every hero holds. */
  observe(
    modifiers: readonly { ability: number; age: number }[],
    now: number,
  ): void {
    for (const timer of this.emptying) {
      if (!timer.watched) {
        continue
      }
      const playing = modifiers.some(
        (modifier) =>
          modifier.ability === timer.ability &&
          modifier.age <= now - timer.at + ageSlack,
      )
      if (playing) {
        timer.seen = true
        timer.gone = 0
      } else if (timer.seen) {
        timer.gone++
      }
    }
  }

  /**
   * expire empties each spent drop whose effect has played out or whose time
   * is up. An ability's slot empties at once; items wait for settle.
   */
  expire(now: number): Emptied[] {
    const emptied: Emptied[] = []
    for (let index = this.emptying.length - 1; index >= 0; index--) {
      const timer = this.emptying[index]
      if (timer === undefined) {
        continue
      }
      const playedOut = timer.seen && timer.gone >= goneLooks
      if (!playedOut && now < timer.until) {
        continue
      }
      this.emptying.splice(index, 1)
      const where = this.find(timer.native)
      const held =
        where === undefined ? undefined : this.slots(where.kind)[where.slot]
      if (where === undefined || held === undefined || held.charges > 0) {
        continue
      }
      emptied.push({
        native: timer.native,
        kind: where.kind,
        slot: where.slot,
        playedOut,
        after: now - timer.at,
      })
      if (where.kind === 'ability') {
        this.clear(where.kind, where.slot)
      } else {
        this.due = true
      }
    }
    return emptied
  }

  get itemsDue(): boolean {
    return this.due
  }

  /**
   * settle answers when the items may be given again: 'rebuild' once no item
   * effect still plays, else the time the last one ends, reported once each
   * time it moves, until which spent items stay locked.
   */
  settle(now: number): 'rebuild' | number | undefined {
    if (!this.due) {
      return undefined
    }
    const playing = this.emptying
      .filter((timer) => timer.kind === 'item')
      .reduce((latest, timer) => Math.max(latest, timer.until), 0)
    if (playing <= now) {
      this.due = false
      this.lockedUntil = 0
      return 'rebuild'
    }
    if (playing === this.lockedUntil) {
      return undefined
    }
    this.lockedUntil = playing
    return playing
  }

  clear(kind: SlotKind, slot: number): void {
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

  held(kind: SlotKind): readonly (Held | undefined)[] {
    return this.slots(kind)
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
