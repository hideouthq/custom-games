import { arena, combat, rules, unitsPerMetre, voids } from './config'
import { seats } from './seating'

export type PlayerId = number

export function personKey(
  steamId: bigint,
  slot: number,
  generation: number,
): string {
  return steamId !== 0n ? `steam ${steamId}` : `slot ${slot}:${generation}`
}

export class PlayerIds {
  private readonly ids = new Map<string, PlayerId>()

  of(key: string): PlayerId {
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.ids.size
      this.ids.set(key, id)
    }
    return id
  }
}

export type Phase =
  | 'waiting'
  | 'countdown'
  | 'live'
  | 'overtime'
  | 'final'
  | 'intermission'
  | 'matchEnd'

export interface View {
  readonly id: PlayerId
  readonly alive: boolean
  readonly healthFraction: number
  readonly damageDealt: number
}

export interface Standing {
  readonly id: PlayerId
  readonly points: number
  readonly wins: number
  readonly eliminations: number
}

export type Effect =
  | { kind: 'phase'; phase: Phase; round: number }
  | { kind: 'seat'; id: PlayerId; pillar: number }
  | { kind: 'release' }
  | { kind: 'drop'; ids: PlayerId[]; mobility: boolean }
  | { kind: 'eliminated'; id: PlayerId; by?: PlayerId; place: number }
  | { kind: 'finalStand'; ids: PlayerId[] }
  | { kind: 'roundEnd'; round: number; winner?: PlayerId }
  | { kind: 'matchEnd'; standings: Standing[] }

interface Score {
  points: number
  wins: number
  eliminations: number
}

export class Round {
  phase: Phase = 'waiting'
  number = 0
  deadline = 0
  startedAt = 0
  private nextDrop = 0
  private entrants: PlayerId[] = []
  private readonly living = new Set<PlayerId>()
  private fallen: PlayerId[] = []
  private readonly scores = new Map<PlayerId, Score>()
  private last: PlayerId | undefined

  constructor(private readonly random: () => number) {}

  get winner(): PlayerId | undefined {
    return this.phase === 'intermission' || this.phase === 'matchEnd'
      ? this.last
      : undefined
  }

  get dropAt(): number {
    return this.nextDrop
  }

  get playing(): boolean {
    return (
      this.phase === 'live' ||
      this.phase === 'overtime' ||
      this.phase === 'final'
    )
  }

  inRound(id: PlayerId): boolean {
    return this.entrants.includes(id)
  }

  isLiving(id: PlayerId): boolean {
    return this.living.has(id)
  }

  survivors(): PlayerId[] {
    return [...this.living]
  }

  elapsed(now: number): number {
    return this.playing ? now - this.startedAt : 0
  }

  knockScale(): number {
    if (this.phase === 'final') {
      return combat.finalKnock
    }
    return this.phase === 'overtime' ? combat.overtimeKnock : 1
  }

  killZ(now: number): number {
    if (this.phase === 'final') {
      return arena.centreZ - voids.finalDepth * unitsPerMetre
    }
    let depth: number = voids.liveDepth
    if (this.phase === 'overtime') {
      const span = rules.finalStandAt - rules.overtimeAt
      const part = Math.min(
        1,
        Math.max(0, (this.elapsed(now) - rules.overtimeAt) / span),
      )
      depth = voids.liveDepth + (voids.overtimeDepth - voids.liveDepth) * part
    }
    return arena.topZ - depth * unitsPerMetre
  }

  abandon(): void {
    if (this.phase !== 'countdown' && !this.playing) {
      return
    }
    this.number = Math.max(0, this.number - 1)
    this.entrants = []
    this.living.clear()
    this.fallen = []
    this.phase = 'waiting'
  }

  standings(): Standing[] {
    return [...this.scores.entries()]
      .map(([id, score]) => ({ id, ...score }))
      .sort((a, b) => b.points - a.points || b.wins - a.wins || a.id - b.id)
  }

  tick(
    now: number,
    views: readonly View[],
    creditOf: (id: PlayerId) => PlayerId | undefined = () => undefined,
  ): Effect[] {
    const effects: Effect[] = []
    switch (this.phase) {
      case 'waiting':
        if (views.length >= rules.minPlayers) {
          this.countdown(now, views, effects)
        }
        break
      case 'countdown':
        this.tickCountdown(now, views, effects)
        break
      case 'live':
      case 'overtime':
      case 'final':
        this.tickPlay(now, views, creditOf, effects)
        break
      case 'intermission':
        if (now >= this.deadline) {
          this.afterRound(now, views, effects)
        }
        break
      case 'matchEnd':
        if (now >= this.deadline) {
          this.scores.clear()
          this.number = 0
          this.enter('waiting', effects)
        }
        break
    }
    return effects
  }

  private enter(phase: Phase, effects: Effect[]): void {
    this.phase = phase
    effects.push({ kind: 'phase', phase, round: this.number })
  }

  private countdown(
    now: number,
    views: readonly View[],
    effects: Effect[],
  ): void {
    this.number++
    this.entrants = views
      .map((view) => view.id)
      .sort((a, b) => a - b)
      .slice(0, rules.maxPlayers)
    this.living.clear()
    this.fallen = []
    this.last = undefined
    for (const id of this.entrants) {
      this.living.add(id)
      if (!this.scores.has(id)) {
        this.scores.set(id, { points: 0, wins: 0, eliminations: 0 })
      }
    }

    const offset = Math.floor(this.random() * arena.pillars)
    const pillars = seats(this.entrants.length, offset)
    this.deadline = now + rules.countdownSeconds
    this.enter('countdown', effects)
    for (const [index, id] of this.entrants.entries()) {
      effects.push({ kind: 'seat', id, pillar: pillars[index] ?? 0 })
    }
  }

  private tickCountdown(
    now: number,
    views: readonly View[],
    effects: Effect[],
  ): void {
    const present = this.entrants.filter((id) =>
      views.some((view) => view.id === id),
    )
    if (present.length < rules.minPlayers) {
      this.number--
      this.entrants = []
      this.living.clear()
      this.enter('waiting', effects)
      return
    }
    if (now < this.deadline) {
      return
    }

    this.entrants = present
    this.living.clear()
    for (const id of present) {
      this.living.add(id)
    }
    this.startedAt = now
    this.nextDrop = now + rules.dropSeconds
    this.enter('live', effects)
    effects.push({ kind: 'release' })
    effects.push({ kind: 'drop', ids: [...present], mobility: true })
  }

  private tickPlay(
    now: number,
    views: readonly View[],
    creditOf: (id: PlayerId) => PlayerId | undefined,
    effects: Effect[],
  ): void {
    for (const id of [...this.living]) {
      const view = views.find((candidate) => candidate.id === id)
      if (view?.alive) {
        continue
      }
      const credited = view === undefined ? undefined : creditOf(id)
      const by =
        credited !== undefined && credited !== id && this.inRound(credited)
          ? credited
          : undefined
      if (by !== undefined) {
        const score = this.scores.get(by)
        if (score !== undefined) {
          score.eliminations++
          score.points += rules.points.elimination
        }
      }
      this.living.delete(id)
      this.fallen.push(id)
      effects.push({ kind: 'eliminated', id, by, place: this.living.size + 1 })
    }

    const elapsed = now - this.startedAt
    if (this.living.size <= 1) {
      const [last] = [...this.living]
      this.finish(now, last ?? this.fallen[this.fallen.length - 1], effects)
      return
    }
    if (elapsed >= rules.hardEndAt) {
      this.finish(now, this.healthiest(views), effects)
      return
    }

    if (this.phase === 'live' && elapsed >= rules.overtimeAt) {
      this.enter('overtime', effects)
    }
    if (this.phase !== 'final' && elapsed >= rules.finalStandAt) {
      this.enter('final', effects)
      effects.push({ kind: 'finalStand', ids: [...this.living] })
    }

    if (now >= this.nextDrop) {
      const fast = this.phase !== 'live'
      this.nextDrop =
        now + (fast ? rules.overtimeDropSeconds : rules.dropSeconds)
      effects.push({
        kind: 'drop',
        ids: [...this.living],
        mobility: this.phase !== 'final',
      })
    }
  }

  private healthiest(views: readonly View[]): PlayerId | undefined {
    let best: View | undefined
    for (const view of views) {
      if (!this.living.has(view.id)) {
        continue
      }
      if (best === undefined || this.better(view, best)) {
        best = view
      }
    }
    return best?.id
  }

  private better(a: View, b: View): boolean {
    return (
      a.healthFraction > b.healthFraction ||
      (a.healthFraction === b.healthFraction &&
        (a.damageDealt > b.damageDealt ||
          (a.damageDealt === b.damageDealt && a.id < b.id)))
    )
  }

  private finish(
    now: number,
    winner: PlayerId | undefined,
    effects: Effect[],
  ): void {
    const order = [...this.fallen]
    for (const id of this.living) {
      if (id !== winner) {
        order.push(id)
      }
    }
    if (winner !== undefined) {
      order.push(winner)
      const score = this.scores.get(winner)
      if (score !== undefined) {
        score.wins++
        score.points += rules.points.win
      }
    }
    if (this.entrants.length >= rules.topThreeMinPlayers) {
      for (const id of [...new Set(order)].slice(-3)) {
        const score = this.scores.get(id)
        if (score !== undefined) {
          score.points += rules.points.topThree
        }
      }
    }
    this.living.clear()
    this.last = winner
    this.deadline = now + rules.intermissionSeconds
    effects.push({ kind: 'roundEnd', round: this.number, winner })
    this.enter('intermission', effects)
  }

  private afterRound(
    now: number,
    views: readonly View[],
    effects: Effect[],
  ): void {
    if (this.number >= rules.rounds) {
      this.deadline = now + rules.matchEndSeconds
      effects.push({ kind: 'matchEnd', standings: this.standings() })
      this.enter('matchEnd', effects)
      return
    }
    if (views.length >= rules.minPlayers) {
      this.countdown(now, views, effects)
    } else {
      this.enter('waiting', effects)
    }
  }
}
