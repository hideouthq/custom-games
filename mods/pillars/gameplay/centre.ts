import { rules } from './config'
import type { PlayerId } from './round'

/** A broken crate scatters souls and an idol; they are swept this long. */
const spoilSeconds = 3

/**
 * The centre Legendary appears centreSeconds into play and again that long
 * after each is taken. It waits in a crate to break or, when the game refuses
 * the crate, for whoever stands on the deck for centreHoldSeconds.
 */
export class Centre {
  private dueAt = -1
  private shown = false
  private sweepUntil = -1
  private readonly arrivals = new Map<PlayerId, number>()

  /** open is true while a Legendary waits to be taken. */
  get open(): boolean {
    return this.shown
  }

  /** tick reports 'appears' on the frame a Legendary is due, then 'open'. */
  tick(now: number): 'waiting' | 'appears' | 'open' {
    if (this.dueAt < 0) {
      this.dueAt = now + rules.centreSeconds
      this.shown = false
      return 'waiting'
    }
    if (now < this.dueAt) {
      return 'waiting'
    }
    if (!this.shown) {
      this.shown = true
      return 'appears'
    }
    return 'open'
  }

  /** close stops the schedule; the next round starts it again. */
  close(): void {
    this.dueAt = -1
    this.shown = false
  }

  /**
   * hold returns the first player, in the order given, who has stood on the
   * deck long enough to take the Legendary.
   */
  hold(
    now: number,
    players: readonly { id: PlayerId; onDeck: boolean }[],
  ): PlayerId | undefined {
    for (const { id, onDeck } of players) {
      if (!onDeck) {
        this.arrivals.delete(id)
        continue
      }
      const since = this.arrivals.get(id) ?? now
      this.arrivals.set(id, since)
      if (now - since < rules.centreHoldSeconds) {
        continue
      }
      this.arrivals.delete(id)
      this.taken(now)
      return id
    }
    return undefined
  }

  /** broken takes the Legendary and sweeps the crate's spoils for a while. */
  broken(now: number): void {
    this.sweepUntil = now + spoilSeconds
    this.taken(now)
  }

  sweeping(now: number): boolean {
    return now < this.sweepUntil
  }

  leave(id: PlayerId): void {
    this.arrivals.delete(id)
  }

  private taken(now: number): void {
    this.dueAt = now + rules.centreSeconds
    this.shown = false
  }
}
