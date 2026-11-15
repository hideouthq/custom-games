import { describe, expect, test } from 'bun:test'
import { arena, rules, unitsPerMetre, voids } from '../gameplay/config'
import {
  type Effect,
  personKey,
  PlayerIds,
  Round,
  type View,
} from '../gameplay/round'

function view(
  id: number,
  alive = true,
  healthFraction = 1,
  damageDealt = 0,
): View {
  return { id, alive, healthFraction, damageDealt }
}
function people(count: number): View[] {
  return Array.from({ length: count }, (_unused, id) => view(id))
}
function kinds(effects: Effect[]): string[] {
  return effects.map((effect) => effect.kind)
}
function live(count: number): Round {
  const round = new Round(() => 0)
  round.tick(0, people(count))
  round.tick(rules.countdownSeconds, people(count))
  return round
}

describe('start', () => {
  test('waits for two players', () => {
    const round = new Round(() => 0)
    expect(round.tick(0, people(1))).toEqual([])
    expect(round.phase).toBe('waiting')
  })

  test('seats every entrant on a different pillar and counts down', () => {
    const round = new Round(() => 0.5)
    const effects = round.tick(0, people(8))
    const pillars = effects.flatMap((effect) =>
      effect.kind === 'seat' ? [effect.pillar] : [],
    )
    expect(round.phase).toBe('countdown')
    expect(pillars.length).toBe(8)
    expect(new Set(pillars).size).toBe(8)
    expect(
      pillars.every((pillar) => pillar >= 0 && pillar < arena.pillars),
    ).toBe(true)
  })

  test('takes at most the pool size and leaves the rest watching', () => {
    const round = new Round(() => 0)
    round.tick(0, people(10))
    expect(round.inRound(7)).toBe(true)
    expect(round.inRound(8)).toBe(false)
  })

  test('goes live with a release and an immediate drop that is not repeated', () => {
    const round = new Round(() => 0)
    round.tick(0, people(3))
    expect(round.tick(rules.countdownSeconds - 0.1, people(3))).toEqual([])
    const first = round.tick(rules.countdownSeconds, people(3))
    expect(kinds(first)).toEqual(['phase', 'release', 'drop'])
    expect(round.tick(rules.countdownSeconds + 1, people(3))).toEqual([])
    const next = round.tick(
      rules.countdownSeconds + rules.dropSeconds,
      people(3),
    )
    expect(kinds(next)).toEqual(['drop'])
  })

  test('returns to waiting when the countdown loses its second player', () => {
    const round = new Round(() => 0)
    round.tick(0, people(2))
    round.tick(1, people(1))
    expect(round.phase).toBe('waiting')
    expect(round.number).toBe(0)
  })
})

describe('elimination', () => {
  test('credits the last hitter and gives places from the bottom', () => {
    const round = live(4)
    const effects = round.tick(
      6,
      [view(0), view(1), view(2), view(3, false)],
      (id) => (id === 3 ? 1 : undefined),
    )
    expect(effects).toContainEqual({
      kind: 'eliminated',
      id: 3,
      by: 1,
      place: 4,
    })
    expect(
      round.standings().find((standing) => standing.id === 1)?.eliminations,
    ).toBe(1)
    expect(round.isLiving(3)).toBe(false)
  })

  test('gives no credit for a player who left, a self hit or an outsider', () => {
    const round = live(4)
    const left = round.tick(6, [view(0), view(1), view(2)], () => 1)
    expect(left).toContainEqual({
      kind: 'eliminated',
      id: 3,
      by: undefined,
      place: 4,
    })
    const self = round.tick(7, [view(0), view(1), view(2, false)], () => 2)
    expect(self).toContainEqual({
      kind: 'eliminated',
      id: 2,
      by: undefined,
      place: 3,
    })
    const outsider = round.tick(8, [view(0), view(1, false)], () => 99)
    expect(outsider).toContainEqual({
      kind: 'eliminated',
      id: 1,
      by: undefined,
      place: 2,
    })
  })

  test('the last survivor wins and scores', () => {
    const round = live(2)
    const effects = round.tick(6, [view(0), view(1, false)], () => 0)
    expect(effects).toContainEqual({ kind: 'roundEnd', round: 1, winner: 0 })
    expect(round.phase).toBe('intermission')
    const [first] = round.standings()
    expect(first).toEqual({
      id: 0,
      points: rules.points.win + rules.points.elimination,
      wins: 1,
      eliminations: 1,
    })
  })

  test('when the last two fall together the later one in order wins', () => {
    const round = live(2)
    const effects = round.tick(6, [view(0, false), view(1, false)])
    expect(effects).toContainEqual({ kind: 'roundEnd', round: 1, winner: 1 })
  })

  test('a lobby of four pays the top-three point, a lobby of three does not', () => {
    const four = live(4)
    four.tick(6, [view(0), view(1), view(2), view(3, false)])
    four.tick(7, [view(0), view(1), view(2, false)])
    four.tick(8, [view(0), view(1, false)])
    const points = new Map(
      four.standings().map((standing) => [standing.id, standing.points]),
    )
    expect(points.get(0)).toBe(rules.points.win + rules.points.topThree)
    expect(points.get(1)).toBe(rules.points.topThree)
    expect(points.get(2)).toBe(rules.points.topThree)
    expect(points.get(3)).toBe(0)
    const three = live(3)
    three.tick(6, [view(0), view(1), view(2, false)])
    three.tick(7, [view(0), view(1, false)])
    expect(three.standings().map((standing) => standing.points)).toEqual([
      rules.points.win,
      0,
      0,
    ])
  })
})

describe('pacing', () => {
  const start = rules.countdownSeconds

  test('overtime speeds the drops and strengthens knockback', () => {
    const round = live(3)
    const effects = round.tick(start + rules.overtimeAt, people(3))
    expect(effects).toContainEqual({
      kind: 'phase',
      phase: 'overtime',
      round: 1,
    })
    expect(round.knockScale()).toBe(1.5)
    round.tick(start + rules.overtimeAt + 1, people(3))
    const soon = round.tick(
      start + rules.overtimeAt + rules.overtimeDropSeconds,
      people(3),
    )
    expect(kinds(soon)).toContain('drop')
  })

  test('the kill plane rises through overtime and sits under the deck in the final', () => {
    const round = live(3)
    expect(round.killZ(start + 1)).toBeCloseTo(-voids.liveDepth * unitsPerMetre)
    round.tick(start + rules.overtimeAt, people(3))
    const middle = start + (rules.overtimeAt + rules.finalStandAt) / 2
    expect(round.killZ(middle)).toBeCloseTo(
      (-(voids.liveDepth + voids.overtimeDepth) / 2) * unitsPerMetre,
    )
    round.tick(start + rules.finalStandAt, people(3))
    expect(round.killZ(start + rules.finalStandAt)).toBeCloseTo(
      arena.centreZ - voids.finalDepth * unitsPerMetre,
    )
  })

  test('the final stand names the survivors and stops mobility drops', () => {
    const round = live(3)
    round.tick(start + rules.overtimeAt, people(3))
    const effects = round.tick(start + rules.finalStandAt, people(3))
    expect(effects).toContainEqual({ kind: 'finalStand', ids: [0, 1, 2] })
    expect(round.knockScale()).toBe(2)
    const drop = effects.find((effect) => effect.kind === 'drop')
    expect(drop).toEqual({ kind: 'drop', ids: [0, 1, 2], mobility: false })
  })

  test('the hard end picks the healthiest, then the most damage', () => {
    const round = live(3)
    const effects = round.tick(start + rules.hardEndAt, [
      view(0, true, 0.4, 900),
      view(1, true, 0.7, 10),
      view(2, true, 0.7, 50),
    ])
    expect(effects).toContainEqual({ kind: 'roundEnd', round: 1, winner: 2 })
  })
})

describe('one life', () => {
  test('a fall takes the player out at once, with credit to who hit them', () => {
    const round = live(3)
    const effects = round.tick(6, [view(0), view(1), view(2, false)], () => 0)
    expect(effects).toContainEqual({
      kind: 'eliminated',
      id: 2,
      by: 0,
      place: 3,
    })
    expect(round.isLiving(2)).toBe(false)
    expect(round.playing).toBe(true)
    expect(
      round.standings().find((standing) => standing.id === 0)?.eliminations,
    ).toBe(1)
  })

  test('the round names its winner until the next one starts', () => {
    const round = live(3)
    round.tick(6, [view(0), view(1), view(2, false)])
    expect(round.winner).toBeUndefined()
    round.tick(7, [view(0), view(1, false), view(2, false)])
    expect(round.phase).toBe('intermission')
    expect(round.winner).toBe(0)
    round.tick(7 + rules.intermissionSeconds, people(3))
    expect(round.phase).toBe('countdown')
    expect(round.winner).toBeUndefined()
  })
})

describe('abandon', () => {
  test('drops a round in play unscored and gives its number back', () => {
    const round = live(3)
    round.tick(6, [view(0), view(1), view(2, false)], () => 0)
    round.abandon()
    expect(round.phase).toBe('waiting')
    expect(round.number).toBe(0)
    expect(round.isLiving(0)).toBe(false)
    expect(round.inRound(0)).toBe(false)
    const effects = round.tick(7, people(3))
    expect(round.phase).toBe('countdown')
    expect(round.number).toBe(1)
    expect(effects.filter((effect) => effect.kind === 'seat').length).toBe(3)
  })

  test('does nothing between rounds', () => {
    const round = live(2)
    round.tick(6, [view(0), view(1, false)])
    round.abandon()
    expect(round.phase).toBe('intermission')
    expect(round.number).toBe(1)
  })
})

describe('match', () => {
  test('plays the set number of rounds, reports standings and starts over', () => {
    const round = new Round(() => 0)
    let now = 0
    let ended: Effect | undefined
    for (let played = 0; played < rules.rounds; played++) {
      round.tick(now, people(2))
      now += rules.countdownSeconds
      round.tick(now, people(2))
      now += 1
      round.tick(now, [view(0), view(1, false)])
      now += rules.intermissionSeconds
      ended = round
        .tick(now, people(2))
        .find((effect) => effect.kind === 'matchEnd')
    }
    expect(ended).toEqual({
      kind: 'matchEnd',
      standings: [
        {
          id: 0,
          points: rules.rounds * rules.points.win,
          wins: rules.rounds,
          eliminations: 0,
        },
        { id: 1, points: 0, wins: 0, eliminations: 0 },
      ],
    })
    expect(round.phase).toBe('matchEnd')
    round.tick(now + rules.matchEndSeconds, people(2))
    expect(round.phase).toBe('waiting')
    expect(round.standings()).toEqual([])
    round.tick(now + rules.matchEndSeconds + 1, people(2))
    expect(round.number).toBe(1)
  })
})

describe('player ids', () => {
  test('a person keeps their id across connections and slots', () => {
    const ids = new PlayerIds()
    const first = ids.of(personKey(7n, 1, 1))
    expect(ids.of(personKey(7n, 4, 3))).toBe(first)
  })

  test('a newcomer to a slot gets a new id', () => {
    const ids = new PlayerIds()
    const left = ids.of(personKey(7n, 1, 1))
    expect(ids.of(personKey(8n, 1, 2))).not.toBe(left)
  })

  test('a bot is told apart by its slot and generation', () => {
    const ids = new PlayerIds()
    const bot = ids.of(personKey(0n, 2, 1))
    expect(ids.of(personKey(0n, 2, 1))).toBe(bot)
    expect(ids.of(personKey(0n, 2, 2))).not.toBe(bot)
    expect(ids.of(personKey(0n, 3, 1))).not.toBe(bot)
  })

  test('ids count up in the order people first join', () => {
    const ids = new PlayerIds()
    expect(ids.of('a')).toBe(0)
    expect(ids.of('b')).toBe(1)
    expect(ids.of('a')).toBe(0)
  })
})
