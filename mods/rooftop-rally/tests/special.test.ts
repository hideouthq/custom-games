import { expect, test } from 'bun:test'
import { Special, isSpecialId, specialIds, specials } from '../gameplay/special'
import { blinkDestination, movementHeading } from '../gameplay/blink'

test('selection accepts only known abilities and is fixed until the next match', () => {
  expect(isSpecialId('blink; quit')).toBe(false)
  for (const choice of specialIds) {
    const special = new Special()
    expect(special.canActivate(100)).toBe(false)
    expect(special.choose(choice)).toBe(true)
    expect(special.choose('powerSlash')).toBe(false)
    special.activate(10)
    special.resetRound()
    expect(special.choice).toBe(choice)
    expect(special.canActivate(11)).toBe(true)
    expect(special.armed).toBe(false)
  }
})

test('Power Slash holds one charge through misses and consumes it independently of cooldown', () => {
  const special = new Special()
  special.choose('powerSlash')
  expect(special.activate(10)).toBe(true)
  expect(special.readyAt).toBe(30)
  expect(special.armed).toBe(true)
  expect(special.activate(40)).toBe(false)
  special.consumePower()
  expect(special.canActivate(29.99)).toBe(false)
  expect(special.canActivate(30)).toBe(true)
  special.activate(30)
  special.cancelLife()
  expect(special.armed).toBe(false)
  expect(special.readyAt).toBe(50)
})

test('Blink cooldown begins at activation and cannot be bypassed by repeated inputs', () => {
  const special = new Special()
  special.choose('blink')
  expect(special.activate(10)).toBe(true)
  expect(special.activate(11)).toBe(false)
  expect(special.readyAt).toBe(28)
  expect(special.activate(28)).toBe(true)
})

test('Time Freeze cooldown begins on successful activation and resets each round', () => {
  const special = new Special()
  special.choose('timeFreeze')
  expect(special.activate(10)).toBe(true)
  expect(special.readyAt).toBe(10 + specials.timeFreeze.cooldown)
  expect(special.activate(31.99)).toBe(false)
  expect(special.activate(32)).toBe(true)
  special.resetRound()
  expect(special.readyAt).toBe(0)
})

test('Blink follows movement axes relative to view, with a horizontal forward fallback', () => {
  expect(movementHeading(0, { forward: 0, left: 1 })).toEqual({
    x: 0,
    y: 1,
    z: 0,
  })
  expect(movementHeading(0, { forward: -1, left: 0 })).toEqual({
    x: -1,
    y: 0,
    z: 0,
  })
  const diagonal = movementHeading(90, { forward: 1, left: 1 })
  expect(diagonal.x).toBeCloseTo(-Math.SQRT1_2)
  expect(diagonal.y).toBeCloseTo(Math.SQRT1_2)
  expect(movementHeading(90, undefined).y).toBeCloseTo(1)
  expect(movementHeading(90, { forward: 0, left: 0 }).z).toBe(0)
})

test('Blink travels twelve metres, preserves elevation, and stops before sampled obstacles', () => {
  const origin = { x: 100, y: -30, z: 150 }
  const heading = { x: 1, y: 0, z: 0 }
  const destination = blinkDestination({
    origin,
    heading,
    trace: () => undefined,
  })
  expect(destination?.x).toBeCloseTo(100 + 12 / 0.0254)
  expect(destination?.z).toBe(150)
  const blocked = blinkDestination({
    origin,
    heading,
    trace: (start) =>
      start.y === -6 && start.z === 186
        ? { startSolid: false, position: { ...start, x: 180 } }
        : undefined,
  })
  expect(blocked).toEqual({ x: 152, y: -30, z: 150 })
  expect(
    blinkDestination({
      origin,
      heading,
      trace: (start) => ({ startSolid: true, position: start }),
    }),
  ).toBeUndefined()
  expect(
    blinkDestination({
      origin,
      heading,
      trace: (start) => ({
        startSolid: false,
        position: { ...start, x: start.x + 20 },
      }),
    }),
  ).toBeUndefined()
})

test('Blink checks clearance beyond the destination center', () => {
  const wall = 12 / 0.0254 + 10
  const destination = blinkDestination({
    origin: { x: 0, y: 0, z: 0 },
    heading: { x: 1, y: 0, z: 0 },
    trace: (start, end) =>
      end.x >= wall
        ? { startSolid: false, position: { ...start, x: wall } }
        : undefined,
  })
  expect(destination?.x).toBeCloseTo(wall - 28)
})
