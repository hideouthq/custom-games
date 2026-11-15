export interface ScoreRow {
  rank: number
  name: string
  wins: number
  knockouts: number
  parries: number
  streak: number
  alive: boolean
  self: boolean
  leader: boolean
}

export interface Contender {
  key: string
  name: string
  alive: boolean
}

interface Tally {
  wins: number
  knockouts: number
  parries: number
  streak: number
}

export class Scores {
  private readonly tallies = new Map<string, Tally>()
  private sender: string | undefined

  private tally(key: string): Tally {
    let tally = this.tallies.get(key)
    if (!tally) {
      tally = { wins: 0, knockouts: 0, parries: 0, streak: 0 }
      this.tallies.set(key, tally)
    }
    return tally
  }

  parry(key: string): void {
    this.tally(key).parries++
    this.sender = key
  }

  clearSender(): void {
    this.sender = undefined
  }

  hit(victim: string): void {
    if (this.sender !== undefined && this.sender !== victim)
      this.tally(this.sender).knockouts++
    this.sender = undefined
  }

  win(winner: string | undefined): void {
    for (const [key, tally] of this.tallies)
      if (key !== winner) tally.streak = 0
    if (winner !== undefined) {
      const tally = this.tally(winner)
      tally.wins++
      tally.streak++
    }
    this.sender = undefined
  }

  forget(key: string): void {
    this.tallies.delete(key)
    if (this.sender === key) this.sender = undefined
  }

  reset(): void {
    this.tallies.clear()
    this.sender = undefined
  }

  board(contenders: readonly Contender[], viewer?: string): ScoreRow[] {
    const rows = contenders.map((contender) => ({
      contender,
      tally: this.tallies.get(contender.key) ?? {
        wins: 0,
        knockouts: 0,
        parries: 0,
        streak: 0,
      },
    }))
    rows.sort(
      (a, b) =>
        b.tally.wins - a.tally.wins ||
        b.tally.knockouts - a.tally.knockouts ||
        b.tally.parries - a.tally.parries ||
        a.contender.name.localeCompare(b.contender.name) ||
        a.contender.key.localeCompare(b.contender.key),
    )
    const best = rows[0]?.tally.wins ?? 0
    let rank = 0
    let previous: number | undefined
    return rows.map(({ contender, tally }, index) => {
      if (tally.wins !== previous) rank = index + 1
      previous = tally.wins
      return {
        rank,
        name: contender.name,
        wins: tally.wins,
        knockouts: tally.knockouts,
        parries: tally.parries,
        streak: tally.streak,
        alive: contender.alive,
        self: contender.key === viewer,
        leader: best > 0 && tally.wins === best,
      }
    })
  }
}
