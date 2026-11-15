import { describe, expect, test } from 'bun:test'
import { rules } from '../gameplay/config'
import { Block } from '../gameplay/block'
import {
  contact,
  dot,
  length,
  normalized,
  subtract,
} from '../gameplay/geometry'
import { Round, type Participant, type PlayerId } from '../gameplay/round'

function fighter(id: PlayerId, x: number, y = 0): Participant {
  return {
    id,
    bot: false,
    ready: true,
    body: {
      alive: true,
      position: { x, y, z: 0 },
      look: { x: -1, y: 0, z: 0 },
      parries: [],
      empowered: false,
    },
  }
}
function served(people: Participant[]): Round {
  const round = new Round(() => 0)
  round.tick(0, people)
  expect(round.tick(3, people).some((e) => e.kind === 'spawn')).toBe(true)
  round.tick(3.1, people)
  return round
}
function flight(people: Participant[], target: PlayerId = '0:1'): Round {
  const round = served(people)
  round.tick(4.1, people)
  const body = people.find((p) => p.id === target)?.body
  if (!body) throw new Error('Fixture needs a target')
  const distance = Math.hypot(body.position.x, body.position.y)
  round.phase = {
    kind: 'flight',
    target,
    position: { x: 0, y: 0, z: 65 },
    power: rules.startingPower,
    selectedAt: 4.1,
    safeUntil: 4.1,
    orbitSeconds: 0,
    enteredBlockSphere: false,
    velocity: {
      x: (body.position.x / distance) * rules.startingPower,
      y: (body.position.y / distance) * rules.startingPower,
      z: 0,
    },
  }
  return round
}
function parry(p: Participant, started: number): void {
  if (!p.body) throw new Error('Fixture needs a body')
  p.body.parries = [{ started, ends: started + rules.blockWindow }]
}

describe('round lifecycle', () => {
  test('waits for all ability choices, including a join during countdown', () => {
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    people[1]!.ready = false
    const round = new Round()
    round.tick(0, people)
    round.tick(50, people)
    expect(round.phase.kind).toBe('waiting')
    people[1]!.ready = true
    round.tick(51, people)
    expect(round.phase.kind).toBe('countdown')
    people.push({ ...fighter('2:1', 0, 600), ready: false })
    round.tick(52, people)
    expect(round.phase.kind).toBe('waiting')
  })
  test('waits for two, spawns the whole roster and holds a visible center serve for one second', () => {
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    const round = new Round(() => 0)
    round.tick(0, [people[0]!])
    expect(round.phase.kind).toBe('waiting')
    round.tick(1, people)
    expect(round.phase.kind).toBe('countdown')
    expect(round.tick(4, people)).toEqual([
      { kind: 'spawn', players: ['0:1', '1:1'] },
    ])
    round.tick(4.1, people)
    expect(round.phase).toMatchObject({
      kind: 'serve',
      position: rules.center,
      until: 5.1,
    })
    round.tick(5, people)
    expect(round.phase.kind).toBe('serve')
    round.tick(5.1, people)
    expect(round.phase).toMatchObject({
      kind: 'flight',
      power: rules.startingPower,
    })
  })
  test('removes only the victim, waits a second and resets ball speed', () => {
    const people = [
      fighter('0:1', 100),
      fighter('1:1', -600),
      fighter('2:1', 600),
    ]
    const round = flight(people)
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    round.phase.power = 120 / 0.0254
    expect(round.tick(4.3, people)).toContainEqual({
      kind: 'eliminate',
      player: '0:1',
      reason: 'ball',
    })
    expect(round.living.has('0:1')).toBe(false)
    round.tick(5.2, people)
    expect(round.phase).toMatchObject({ kind: 'reset' })
    round.tick(5.3, people)
    expect(round.phase).toMatchObject({ kind: 'serve', until: 6.3 })
    round.tick(6.3, people)
    expect(round.phase).toMatchObject({
      kind: 'flight',
      power: rules.startingPower,
    })
    expect(round.living.has('0:1')).toBe(false)
  })
  test('announces the last survivor once and starts a fresh round after intermission', () => {
    const people = [fighter('0:1', 100), fighter('1:1', -600)]
    const round = flight(people)
    expect(round.tick(4.3, people)).toContainEqual({
      kind: 'winner',
      player: '1:1',
    })
    expect(round.tick(4.4, people)).toEqual([])
    round.tick(9.3, people)
    round.tick(9.4, people)
    expect(round.tick(12.4, people)).toContainEqual({
      kind: 'spawn',
      players: ['0:1', '1:1'],
    })
  })
  test('late joins and reused slots do not acquire a current-round life', () => {
    const a = fighter('0:1', 600),
      b = fighter('1:1', -600),
      c = fighter('2:1', 1000)
    const round = flight([a, b, c])
    const newcomer = fighter('0:2', 600)
    const events = round.tick(4.2, [newcomer, b, c])
    expect(events).toContainEqual({
      kind: 'eliminate',
      player: '0:1',
      reason: 'disconnect',
    })
    expect(round.living.has('0:2')).toBe(false)
    expect(round.phase.kind).toBe('reset')
  })
  test('falls and simultaneous departures cannot create a phantom winner', () => {
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    const round = flight(people)
    people[0]!.body!.position.z = -200
    expect(round.tick(4.2, [people[0]!])).toContainEqual({
      kind: 'winner',
      player: undefined,
    })
  })
  test('does not begin a serve while pawns are still spawning', () => {
    const people: Participant[] = [
      { id: '0:1', bot: false, ready: true, body: undefined },
      fighter('1:1', 100),
    ]
    const round = served(people)
    expect(round.phase.kind).toBe('spawning')
    expect(round.tick(11.1, people)).toContainEqual({
      kind: 'eliminate',
      player: '0:1',
      reason: 'spawn',
    })
  })
})

describe('parry and ball', () => {
  test('Power Slash boosts only outgoing velocity without changing Astro growth', () => {
    for (const empowered of [false, true]) {
      const a = fighter('0:1', 100),
        b = fighter('1:1', -600)
      const round = flight([a, b])
      a.body!.empowered = empowered
      parry(a, 4.11)
      const events = round.tick(4.2, [a, b])
      expect(events.find((e) => e.kind === 'block')).toMatchObject({
        player: a.id,
        empowered,
      })
      if (round.phase.kind !== 'flight') throw new Error('Expected return')
      expect(round.phase.power * 0.0254).toBeCloseTo(31.5, 1)
      expect(length(round.phase.velocity) * 0.0254).toBeCloseTo(
        empowered ? 45 : 30,
        1,
      )
    }
  })
  test('Blink discontinuity is not swept as a walk through the ball', () => {
    const a = fighter('0:1', -100),
      b = fighter('1:1', -600)
    const round = flight([a, b])
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    round.phase.power = 0
    round.phase.velocity = { x: 0, y: 0, z: 0 }
    a.body!.position.x = 100
    round.relocate(a.id, a.body!.position)
    expect(round.tick(4.11, [a, b]).some((e) => e.kind === 'eliminate')).toBe(
      false,
    )
    expect(round.living.has(a.id)).toBe(true)
  })
  test('a non-target parry cannot save the victim', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -100)
    const round = flight([a, b])
    parry(b, 4.15)
    expect(round.tick(4.3, [a, b])).toContainEqual({
      kind: 'eliminate',
      player: a.id,
      reason: 'ball',
    })
  })
  test('redirects to the most aligned living player and increases speed', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -600),
      c = fighter('2:1', 100, 600)
    const round = flight([a, b, c])
    parry(a, 4.11)
    const events = round.tick(4.2, [a, b, c])
    expect(events).toContainEqual({
      kind: 'target',
      player: b.id,
      refresh: false,
    })
    expect(round.phase).toMatchObject({ kind: 'flight', target: b.id })
    if (round.phase.kind !== 'flight') throw new Error('Expected return')
    expect(round.phase.power * 0.0254).toBeCloseTo(31.5, 1)
    expect(length(round.phase.velocity) * 0.0254).toBeCloseTo(30, 1)
  })
  test('counts the returns of a rally until the next serve starts a new one', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -600),
      c = fighter('2:1', 100, 600)
    const round = flight([a, b, c])
    expect(round.rally).toBe(0)
    parry(a, 4.11)
    round.tick(4.2, [a, b, c])
    expect(round.rally).toBe(1)
    let now = 4.2
    while (round.phase.kind === 'flight' && now < 8)
      round.tick((now += 0.05), [a, b, c])
    expect(round.phase.kind).toBe('reset')
    expect(round.rally).toBe(1)
    round.tick(now + rules.ballReset, [a, b, c])
    expect(round.phase.kind).toBe('serve')
    expect(round.rally).toBe(0)
  })
  test('cannot reuse one parry after a close return, and enforces minimum departure', () => {
    const a = fighter('0:1', 60),
      b = fighter('1:1', -70)
    const round = flight([a, b])
    parry(a, 4.1)
    round.tick(4.12, [a, b])
    parry(b, 4.13)
    expect(round.tick(4.2, [a, b]).filter((e) => e.kind === 'block')).toEqual(
      [],
    )
    const returned = round.tick(4.38, [a, b])
    expect(returned).toContainEqual({
      kind: 'target',
      player: a.id,
      refresh: true,
    })
    expect(round.tick(11, [a, b])).toContainEqual({
      kind: 'eliminate',
      player: a.id,
      reason: 'ball',
    })
  })
  test('a parry started before selection is not a block for the new target', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -100)
    const round = flight([a, b])
    parry(a, 4)
    expect(round.tick(4.3, [a, b]).some((e) => e.kind === 'block')).toBe(false)
  })
  test('a sideways return first follows aim, then curves back to its selected opponent', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -600)
    a.body!.look = { x: 0, y: 1, z: 0 }
    const round = flight([a, b])
    parry(a, 4.11)
    round.tick(4.2, [a, b])
    if (round.phase.kind !== 'flight') throw new Error('Expected return')
    const origin = round.phase.position
    round.tick(4.25, [a, b])
    if (round.phase.kind !== 'flight') throw new Error('Expected departure')
    expect(round.phase.target).toBe(b.id)
    expect(round.phase.position.y - origin.y).toBeGreaterThan(
      Math.abs(round.phase.position.x - origin.x) * 5,
    )
    a.body!.look = { x: 0, y: -1, z: 0 }
    let farthest = 0,
      returned = false
    for (let i = 1; i <= 600; i++) {
      const events = round.tick(4.25 + i / 120, [a, b])
      if (round.phase.kind !== 'flight') {
        returned = events.some(
          (e) => e.kind === 'eliminate' && e.player === b.id,
        )
        break
      }
      expect(round.phase.target).toBe(b.id)
      farthest = Math.max(farthest, round.phase.position.y - origin.y)
    }
    expect(farthest * 0.0254).toBeGreaterThan(5)
    expect(returned).toBe(true)
  })
  test('vertical and backward returns stay finite and eventually reach their target', () => {
    for (const look of [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
    ]) {
      const a = fighter('0:1', 100),
        b = fighter('1:1', -600)
      a.body!.look = look
      const round = flight([a, b])
      parry(a, 4.11)
      round.tick(4.2, [a, b])
      round.tick(4.25, [a, b])
      if (round.phase.kind !== 'flight') throw new Error('Expected departure')
      if (look.z) expect(round.phase.position.z).toBeGreaterThan(90)
      else expect(round.phase.position.x).toBeGreaterThan(25)
      expect(round.tick(10, [a, b])).toContainEqual({
        kind: 'eliminate',
        player: b.id,
        reason: 'ball',
      })
    }
  })
  test('curved flight reaches the same place across different server frame sizes', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -1600)
    a.body!.look = { x: 0, y: 1, z: 0 }
    const fine = flight([a, b]),
      coarse = flight([a, b])
    parry(a, 4.11)
    fine.tick(4.2, [a, b])
    coarse.tick(4.2, [a, b])
    for (let i = 1; i <= 60; i++) fine.tick(4.2 + i / 120, [a, b])
    coarse.tick(4.7, [a, b])
    if (fine.phase.kind !== 'flight' || coarse.phase.kind !== 'flight')
      throw new Error('Expected flight')
    expect(fine.phase.position.x).toBeCloseTo(coarse.phase.position.x, 3)
    expect(fine.phase.position.y).toBeCloseTo(coarse.phase.position.y, 3)
  })
  test('Astro carries momentum and varies actual speed through a wide turn', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -600)
    a.body!.look = { x: 0, y: 1, z: 0 }
    const round = flight([a, b])
    parry(a, 4.1)
    round.tick(4.12, [a, b])
    if (round.phase.kind !== 'flight') throw new Error('Expected return')
    let previous = round.phase.velocity,
      slowest = Infinity,
      largestTurn = 0
    for (let tick = 1; tick <= 600; tick++) {
      round.tick(4.12 + tick / 60, [a, b])
      if (round.phase.kind !== 'flight') break
      const velocity = round.phase.velocity
      largestTurn = Math.max(
        largestTurn,
        Math.acos(
          Math.max(
            -1,
            Math.min(1, dot(normalized(previous), normalized(velocity))),
          ),
        ),
      )
      slowest = Math.min(slowest, length(velocity) * 0.0254)
      previous = velocity
    }
    expect((largestTurn * 180) / Math.PI).toBeLessThan(15)
    expect(slowest).toBeLessThan(20)
    expect(round.phase).toMatchObject({ kind: 'intermission' })
  })
  test('downward returns stay above the roof at ordinary and high speeds', () => {
    for (const speed of [15, 120])
      for (const look of [
        { x: 0, y: 0, z: -1 },
        { x: -1, y: 1, z: -1 },
      ]) {
        const a = fighter('0:1', 100),
          b = fighter('1:1', -600)
        a.body!.look = look
        const round = flight([a, b])
        parry(a, 4.1)
        if (round.phase.kind !== 'flight') throw new Error('Fixture')
        round.phase.power = speed / 0.0254
        round.tick(4.12, [a, b])
        let lowest = Infinity
        for (let tick = 1; tick <= 1200; tick++) {
          round.tick(4.12 + tick / 120, [a, b])
          if (round.phase.kind !== 'flight') break
          lowest = Math.min(lowest, round.phase.position.z)
        }
        expect(lowest).toBe(rules.ballFloorHeight)
        expect(round.phase).toMatchObject({
          kind: 'intermission',
          winner: a.id,
        })
      }
  })
  test('a late parry cannot retroactively cancel a swept hit earlier in that tick', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -100)
    const round = flight([a, b])
    parry(a, 4.29)
    expect(round.tick(4.3, [a, b])).toContainEqual({
      kind: 'eliminate',
      player: a.id,
      reason: 'ball',
    })
  })
  test('Astro gains five percent per block and stops increasing its control value at 400', () => {
    const a = fighter('0:1', 100),
      b = fighter('1:1', -600)
    const round = flight([a, b])
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    round.phase.power = 399 / 0.0254
    parry(a, 4.1)
    round.tick(4.12, [a, b])
    expect(round.phase.power).toBe(rules.powerCap)
    expect(length(round.phase.velocity) * 0.0254).toBeCloseTo(399, 1)
    parry(b, 4.3)
    round.tick(4.65, [a, b])
    if (round.phase.kind !== 'flight') throw new Error('Expected second return')
    expect(round.phase.power).toBe(rules.powerCap)
    expect(length(round.phase.velocity)).toBeCloseTo(rules.powerCap)
  })
  test('Astro control value grows passively by 0.25 per second', () => {
    const people = [fighter('0:1', 1600), fighter('1:1', -1600)]
    const round = flight(people)
    round.tick(4.3, people)
    if (round.phase.kind !== 'flight') throw new Error('Expected flight')
    expect(round.phase.power * 0.0254).toBeCloseTo(30.05)
  })
  test('follows vertical movement without changing targets', () => {
    const a = fighter('0:1', 600),
      b = fighter('1:1', -600)
    const round = flight([a, b])
    a.body!.position.z = 140
    round.tick(4.2, [a, b])
    expect(round.phase.kind).toBe('flight')
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    expect(round.phase.target).toBe(a.id)
    expect(round.phase.position.z).toBeGreaterThan(65)
  })
  test('catches a lateral crossing even when both endpoints miss the target', () => {
    const t = contact(
      { x: -100, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 0, y: -100, z: 0 },
      { x: 0, y: 100, z: 0 },
      10,
    )
    expect(t).toBeDefined()
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)
    expect(
      contact(
        { x: -100, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
        { x: 0, y: -100, z: 100 },
        { x: 0, y: 100, z: 100 },
        10,
      ),
    ).toBeUndefined()
  })
})

describe('anti-orbit penalty', () => {
  function slowFlight(bot = false) {
    const a = fighter('0:1', 500),
      b = fighter('1:1', -1000)
    a.bot = bot
    const round = flight([a, b])
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    round.phase.power = 0
    round.phase.velocity = { x: 0, y: 0, z: 0 }
    return { round, people: [a, b] }
  }
  test('waits for continuous close slow flight before issuing a timed stun and upward push', () => {
    const { round, people } = slowFlight()
    expect(round.tick(11.59, people).some((e) => e.kind === 'orbit')).toBe(
      false,
    )
    const event = round.tick(11.61, people).find((e) => e.kind === 'orbit')
    expect(event?.player).toBe('0:1')
    if (event?.kind !== 'orbit') throw new Error('Expected penalty')
    expect(event.push.z).toBeGreaterThan(0)
    expect(length(event.push) * 0.0254).toBeCloseTo(10)
    expect(round.tick(11.7, people).some((e) => e.kind === 'orbit')).toBe(false)
  })
  test('practice bots are exempt', () => {
    const { round, people } = slowFlight(true)
    expect(round.tick(11.7, people).some((e) => e.kind === 'orbit')).toBe(false)
  })
  test('leaving the close area resets accumulated time', () => {
    const { round, people } = slowFlight()
    round.tick(8.1, people)
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    expect(round.phase.orbitSeconds).toBeGreaterThan(3.9)
    people[0]!.body!.position.x = 1400
    round.tick(8.2, people)
    expect(round.phase.orbitSeconds).toBe(0)
    people[0]!.body!.position.x = 500
    expect(round.tick(11.7, people).some((e) => e.kind === 'orbit')).toBe(false)
  })
})

describe('deflect area', () => {
  test('sweeps through the full block window even when it expires before the frame ends', () => {
    for (const endTime of [9.999, 10.01]) {
      const a = fighter('0:1', 0),
        b = fighter('1:1', -600)
      const round = served([a, b])
      round.phase = { kind: 'reset', until: 100 }
      round.tick(9.99, [a, b])
      const block = new Block()
      block.press(9.6)
      a.body!.parries = block.window ? [block.window] : []
      round.phase = {
        kind: 'flight',
        target: a.id,
        selectedAt: 9,
        safeUntil: 9,
        position: { x: 151, y: 0, z: rules.chestHeight },
        velocity: { x: -10_000, y: 0, z: 0 },
        power: 0,
        orbitSeconds: 0,
        enteredBlockSphere: false,
      }
      const events = round.tick(endTime, [a, b])
      expect(events.some((e) => e.kind === 'block')).toBe(true)
      expect(events.some((e) => e.kind === 'eliminate')).toBe(false)
    }
  })

  test('an expired window cannot protect a later contact in the same frame', () => {
    const a = fighter('0:1', 0),
      b = fighter('1:1', -600)
    const round = served([a, b])
    round.phase = { kind: 'reset', until: 100 }
    round.tick(9.99, [a, b])
    const block = new Block()
    block.press(9.6)
    a.body!.parries = block.window ? [block.window] : []
    round.phase = {
      kind: 'flight',
      target: a.id,
      selectedAt: 9,
      safeUntil: 9,
      position: { x: 300, y: 0, z: rules.chestHeight },
      velocity: { x: -10_000, y: 0, z: 0 },
      power: 0,
      orbitSeconds: 0,
      enteredBlockSphere: false,
    }
    expect(round.tick(10.03, [a, b])).toContainEqual({
      kind: 'eliminate',
      player: a.id,
      reason: 'ball',
    })
  })

  const directions = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
    normalized({ x: 1, y: 1, z: 1 }),
    normalized({ x: -1, y: -1, z: -1 }),
  ]

  test('covers a 150-unit sphere around the chest, including behind the player', () => {
    for (const direction of directions)
      for (const distance of [149.9, 150.1]) {
        const a = fighter('0:1', 600),
          b = fighter('1:1', -600)
        a.body!.position.z = 200
        const round = flight([a, b])
        if (round.phase.kind !== 'flight') throw new Error('Fixture')
        round.phase.position = {
          x: 600 + direction.x * distance,
          y: direction.y * distance,
          z: 200 + rules.chestHeight + direction.z * distance,
        }
        round.phase.velocity = { x: 0, y: 0, z: 0 }
        round.phase.power = 0
        parry(a, 4.1)
        const events = round.tick(4.101, [a, b])
        expect(events.some((e) => e.kind === 'block')).toBe(distance < 150)
      }
  })

  test('includes the exact radius boundary', () => {
    const a = fighter('0:1', 600),
      b = fighter('1:1', -600)
    const round = flight([a, b])
    if (round.phase.kind !== 'flight') throw new Error('Fixture')
    round.phase.position = { x: 600, y: 150, z: rules.chestHeight }
    round.phase.velocity = { x: 0, y: 0, z: 0 }
    round.phase.power = 0
    parry(a, 4.1)
    expect(round.tick(4.101, [a, b]).some((e) => e.kind === 'block')).toBe(true)
  })

  test('uses the sphere for a fast crossing even when both sampled endpoints are outside', () => {
    for (const clearance of [149.9, 150.1]) {
      const a = fighter('0:1', 600),
        b = fighter('1:1', -600)
      const round = flight([a, b])
      if (round.phase.kind !== 'flight') throw new Error('Fixture')
      round.phase.position = { x: 400, y: clearance, z: rules.chestHeight }
      round.phase.velocity = { x: 40_000, y: 0, z: 0 }
      round.phase.power = 0
      parry(a, 4.1)
      expect(round.tick(4.11, [a, b]).some((e) => e.kind === 'block')).toBe(
        clearance < 150,
      )
    }
  })
})

describe('Time Freeze', () => {
  function flying(round: Round) {
    if (round.phase.kind !== 'flight') throw new Error('Expected flight')
    return round.phase
  }

  test('holds the complete flight state and resumes only the elapsed time after expiry', () => {
    const people = [fighter('0:1', 1000), fighter('1:1', -1000)]
    const round = flight(people)
    const control = flight(people)
    flying(round).velocity = { x: 0, y: 200, z: 40 }
    flying(control).velocity = { x: 0, y: 200, z: 40 }
    flying(round).orbitSeconds = 2
    flying(control).orbitSeconds = 2
    const saved = structuredClone(flying(round))
    expect(round.freeze(4.1, '0:1')).toBe(true)
    expect(round.freeze(4.2, '0:1')).toBe(false)
    expect(round.tick(4.4, people)).toEqual([])
    expect(round.phase).toMatchObject({ kind: 'frozen', flight: saved })
    expect(round.tick(4.69, people)).toEqual([])
    expect(round.phase).toMatchObject({ kind: 'frozen', flight: saved })
    expect(round.tick(4.8, people)).toEqual([{ kind: 'resume', player: '0:1' }])
    control.tick(4.2, people)
    const actual = flying(round),
      expected = flying(control)
    expect(actual.target).toBe(saved.target)
    expect(actual.selectedAt).toBe(saved.selectedAt)
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual.position[axis]).toBeCloseTo(expected.position[axis], 8)
      expect(actual.velocity[axis]).toBeCloseTo(expected.velocity[axis], 8)
    }
    expect(actual.power).toBeCloseTo(expected.power, 8)
    expect(actual.orbitSeconds).toBeCloseTo(expected.orbitSeconds, 8)
    expect(actual.velocity.y).toBeGreaterThan(0)
  })

  test('does not sweep a player through the ball along movement completed while frozen', () => {
    const a = fighter('0:1', -300),
      b = fighter('1:1', -1000)
    const round = flight([a, b])
    flying(round).velocity = { x: 0, y: 0, z: 0 }
    flying(round).power = 0
    expect(round.freeze(4.1, a.id)).toBe(true)
    a.body!.position.x = 700
    const events = round.tick(4.8, [a, b])
    expect(events).toEqual([{ kind: 'resume', player: a.id }])
    expect(round.living.has(a.id)).toBe(true)
    expect(flying(round).enteredBlockSphere).toBe(false)
  })

  test('retains the anti-orbit accumulation without counting frozen time or resetting it', () => {
    const people = [fighter('0:1', 500), fighter('1:1', -1000)]
    const round = flight(people)
    flying(round).power = 0
    flying(round).velocity = { x: 0, y: 0, z: 0 }
    round.tick(11.3, people)
    const accumulated = flying(round).orbitSeconds
    expect(accumulated).toBeCloseTo(7.2)
    expect(round.freeze(11.3, '0:1')).toBe(true)
    expect(round.tick(11.89, people)).toEqual([])
    expect(round.phase).toMatchObject({
      kind: 'frozen',
      flight: { orbitSeconds: accumulated },
    })
    expect(round.tick(11.9, people).some((e) => e.kind === 'orbit')).toBe(false)
    expect(flying(round).orbitSeconds).toBeCloseTo(accumulated)
    expect(round.tick(12.19, people).some((e) => e.kind === 'orbit')).toBe(
      false,
    )
    expect(round.tick(12.21, people).some((e) => e.kind === 'orbit')).toBe(true)
  })

  test('accepts any living player before the target sphere boundary or an earlier close pass', () => {
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    const round = flight(people)
    expect(round.canFreeze('1:1')).toBe(true)
    for (const x of [450, 451]) {
      flying(round).position.x = x
      expect(round.freeze(4.1, '0:1')).toBe(false)
      expect(round.freeze(4.1, '1:1')).toBe(false)
    }
    flying(round).position.x = 449
    expect(round.canFreeze('0:1')).toBe(true)
    flying(round).enteredBlockSphere = true
    expect(round.freeze(4.1, '0:1')).toBe(false)
    flying(round).enteredBlockSphere = false
    round.living.delete('0:1')
    expect(round.canFreeze('0:1')).toBe(false)
  })

  test('a swept pass through the block sphere disables freeze even after exiting during departure protection', () => {
    const people = [fighter('0:1', 0), fighter('1:1', -1000)]
    const round = flight(people)
    Object.assign(flying(round), {
      position: { x: -300, y: 100, z: 65 },
      velocity: { x: 1000, y: 0, z: 0 },
      power: 0,
      safeUntil: 100,
    })
    round.tick(4.7, people)
    expect(flying(round).position.x).toBeGreaterThan(150)
    expect(flying(round).enteredBlockSphere).toBe(true)
    expect(round.canFreeze('0:1')).toBe(false)
  })

  test('rejects stationary serve and reset and preserves the remaining departure protection', () => {
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    const round = served(people)
    expect(round.freeze(4, '0:1')).toBe(false)
    round.phase = { kind: 'reset', until: 100 }
    expect(round.freeze(4, '0:1')).toBe(false)
    const moving = flight(people)
    flying(moving).safeUntil = 4.35
    expect(moving.freeze(4.1, '0:1')).toBe(true)
    moving.tick(4.7, people)
    expect(flying(moving).safeUntil).toBeCloseTo(4.95)
    expect(flying(moving).selectedAt).toBe(4.1)
  })

  test('death, disconnect, and leaving the arena cancel a frozen target without resuming the old ball', () => {
    for (const reason of ['death', 'disconnect', 'fall'] as const) {
      const people = [
        fighter('0:1', 600),
        fighter('1:1', -600),
        fighter('2:1', 0, 600),
      ]
      const round = flight(people)
      expect(round.freeze(4.1, '0:1')).toBe(true)
      if (reason === 'death') people[0]!.body!.alive = false
      if (reason === 'fall') people[0]!.body!.position.z = -200
      const roster = reason === 'disconnect' ? people.slice(1) : people
      expect(round.tick(4.2, roster)).toContainEqual({
        kind: 'eliminate',
        player: '0:1',
        reason,
      })
      expect(round.phase.kind).toBe('reset')
      expect(round.tick(4.8, roster).some((e) => e.kind === 'resume')).toBe(
        false,
      )
      expect(round.phase.kind).toBe('reset')
    }
    const people = [fighter('0:1', 600), fighter('1:1', -600)]
    const round = flight(people)
    round.freeze(4.1, '0:1')
    people[1]!.body!.alive = false
    expect(round.tick(4.2, people)).toContainEqual({
      kind: 'winner',
      player: '0:1',
    })
    expect(round.phase.kind).toBe('intermission')
  })
})

test('a parry opened early during Time Freeze expires before the ball resumes', () => {
  const a = fighter('0:1', 600),
    b = fighter('1:1', -600)
  const round = flight([a, b])
  if (round.phase.kind !== 'flight') throw new Error('Fixture')
  round.phase.position = { x: 440, y: 0, z: 65 }
  round.phase.velocity = { x: 1000, y: 0, z: 0 }
  round.phase.power = 0
  expect(round.freeze(4.1, a.id)).toBe(true)
  parry(a, 4.11)
  const events = round.tick(4.9, [a, b])
  expect(events.some((e) => e.kind === 'block')).toBe(false)
  expect(events).toContainEqual({
    kind: 'eliminate',
    player: a.id,
    reason: 'ball',
  })
})
