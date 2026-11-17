import { expect, test } from 'bun:test'
import { notice, type NoticeContext, type NoticeSeat } from '../gameplay/hud'
import type { Flight } from '../gameplay/round'

const player: NoticeSeat = {
  chosen: true,
  spectating: false,
  targeted: false,
  penaltyUntil: undefined,
  blockCooldown: 0,
}
const context: NoticeContext = {
  now: 10,
  round: 3,
  remaining: 4,
  seats: 4,
  winnerName: 'Ada',
  resumeCueUntil: 0,
}
const flight: Flight = {
  kind: 'flight',
  target: '1:1',
  selectedAt: 9,
  safeUntil: 9,
  position: { x: 0, y: 0, z: 100 },
  power: 0,
  velocity: { x: 12 / 0.0254, y: 0, z: 0 },
  orbitSeconds: 0,
  enteredBlockSphere: false,
}

test('the lobby asks for a second player, then for choices once two are in', () => {
  const waiting = { kind: 'waiting' } as const
  expect(notice(waiting, player, { ...context, seats: 1 })).toMatchObject({
    title: 'WAITING FOR PLAYERS',
    detail: 'Two players needed · Left click or parry to block',
  })
  expect(notice(waiting, player, { ...context, seats: 2 })).toMatchObject({
    title: 'WAITING FOR CHOICES',
    detail: 'The round starts when everyone has chosen',
  })
})

test('a player who has not chosen sees the picker prompt in any phase but Time Freeze', () => {
  const unchosen = { ...player, chosen: false }
  for (const phase of [
    { kind: 'waiting' },
    { kind: 'countdown', until: 12 },
    flight,
  ] as const)
    expect(notice(phase, unchosen, context)).toMatchObject({
      title: 'CHOOSE YOUR ABILITY',
      detail: 'One choice for this match · Abilities reset each round',
    })
  expect(
    notice(
      { kind: 'frozen', flight, started: 9.9, until: 10.5 },
      unchosen,
      context,
    ).title,
  ).toBe('TIME FROZEN · 0.5s')
})

test('the countdown shows whole seconds and never reaches zero', () => {
  const countdown = { kind: 'countdown', until: 12.5 } as const
  expect(notice(countdown, player, context)).toMatchObject({
    title: 'ROUND STARTING',
    detail: '3',
  })
  expect(notice(countdown, player, { ...context, now: 12.5 }).detail).toBe('1')
})

test('the round title counts survivors and, in flight, the ball speed in metres per second', () => {
  expect(notice(flight, player, context)).toEqual({
    title: 'ROUND 3 · 4 REMAINING · 12.0 m/s',
    ballCue: 'none',
    detail: 'Aim your return · Left click or parry when targeted',
    targeted: false,
    spectating: false,
  })
  expect(notice({ kind: 'reset', until: 11 }, player, context)).toMatchObject({
    title: 'ROUND 3 · 4 REMAINING',
    detail: 'Ball returning to center',
  })
})

test('the targeted player is told to block, when the block is ready, and when the ball orbits', () => {
  const targeted = { ...player, targeted: true }
  const serve = {
    kind: 'serve',
    until: 11,
    target: '1:1',
    position: { x: 0, y: 0, z: 100 },
  } as const
  expect(notice(serve, targeted, context)).toMatchObject({
    detail: 'YOU ARE TARGETED · Ball launches in 1 second',
    targeted: true,
  })
  expect(notice(flight, targeted, context).detail).toBe(
    'YOU ARE TARGETED · LEFT CLICK / PARRY',
  )
  expect(
    notice(flight, { ...targeted, blockCooldown: 0.25 }, context).detail,
  ).toBe('YOU ARE TARGETED · Block ready in 0.3s')
  expect(notice({ ...flight, orbitSeconds: 3 }, targeted, context).detail).toBe(
    'ORBIT WARNING · Parry or separate from the ball · 4.5s',
  )
})

test('spectating outranks an orbit penalty, which outranks being targeted', () => {
  const everything = {
    ...player,
    spectating: true,
    targeted: true,
    penaltyUntil: 12,
  }
  expect(notice(flight, everything, context)).toMatchObject({
    detail: 'SPECTATING · You return next round',
    spectating: true,
  })
  expect(
    notice(flight, { ...everything, spectating: false }, context).detail,
  ).toBe('ORBIT PENALTY · Stunned for 2.0s')
})

test('spawning and intermission show the same notice to everyone', () => {
  const spectator = { ...player, spectating: true }
  expect(
    notice({ kind: 'spawning', until: 18 }, spectator, context),
  ).toMatchObject({
    title: 'GET READY',
    detail: 'One life · Last player standing wins',
  })
  expect(
    notice(
      { kind: 'intermission', until: 15, winner: '1:1' },
      spectator,
      context,
    ),
  ).toMatchObject({ title: 'ADA WINS', detail: 'Next round shortly' })
})

test('Time Freeze counts down, then cues the restart in its last fifth of a second', () => {
  const frozen = { kind: 'frozen', flight, started: 9.9, until: 10.5 } as const
  expect(notice(frozen, player, context)).toMatchObject({
    title: 'TIME FROZEN · 0.5s',
    ballCue: 'frozen',
    detail: 'Ball resumes with the same target and momentum',
  })
  expect(notice(frozen, player, { ...context, now: 10.25 }).ballCue).toBe(
    'frozen',
  )
  expect(notice(frozen, player, { ...context, now: 10.35 })).toMatchObject({
    ballCue: 'restarting',
    detail: 'BALL RESTARTING',
  })
})

test('a resumed ball is announced only while its cue lasts', () => {
  const resumed = { ...context, resumeCueUntil: 10.4 }
  expect(notice(flight, player, resumed)).toMatchObject({
    title: 'BALL RESUMED',
    ballCue: 'resumed',
  })
  expect(notice(flight, player, { ...resumed, now: 10.4 }).ballCue).toBe('none')
})
