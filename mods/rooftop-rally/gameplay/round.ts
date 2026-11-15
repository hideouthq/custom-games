import { rules } from './config'
import type { BlockWindow } from './block'
import {
  contact,
  dot,
  length,
  mix,
  normalized,
  subtract,
  type Vec3,
} from './geometry'
import { astroVelocity } from './motion'
import { powerSlashMultiplier, timeFreezeDuration } from './special'

export type PlayerId = `${number}:${number}`
export interface Body {
  position: Vec3
  look: Vec3
  alive: boolean
  parries: readonly BlockWindow[]
  empowered: boolean
}
export interface Participant {
  id: PlayerId
  bot: boolean
  ready: boolean
  body: Body | undefined
}
export interface Flight {
  kind: 'flight'
  target: PlayerId
  selectedAt: number
  safeUntil: number
  position: Vec3
  power: number
  velocity: Vec3
  orbitSeconds: number
  enteredBlockSphere: boolean
}

export type Phase =
  | { kind: 'waiting' }
  | { kind: 'countdown'; until: number }
  | { kind: 'spawning'; until: number }
  | { kind: 'serve'; until: number; target: PlayerId; position: Vec3 }
  | Flight
  | { kind: 'frozen'; flight: Flight; started: number; until: number }
  | { kind: 'reset'; until: number }
  | { kind: 'intermission'; until: number; winner: PlayerId | undefined }

export type RoundEvent =
  | { kind: 'spawn'; players: PlayerId[] }
  | { kind: 'target'; player: PlayerId; refresh: boolean }
  | { kind: 'block'; player: PlayerId; power: number; empowered: boolean }
  | { kind: 'orbit'; player: PlayerId; push: Vec3 }
  | { kind: 'resume'; player: PlayerId }
  | {
      kind: 'eliminate'
      player: PlayerId
      reason: 'ball' | 'fall' | 'death' | 'disconnect' | 'spawn'
    }
  | { kind: 'winner'; player: PlayerId | undefined }

export class Round {
  phase: Phase = { kind: 'waiting' }
  number = 0
  rally = 0
  readonly living = new Set<PlayerId>()
  private readonly consumed = new Map<PlayerId, number>()
  private readonly refreshable = new Set<PlayerId>()
  private readonly previous = new Map<PlayerId, Vec3>()
  private lastTime = 0

  constructor(private readonly random: () => number = Math.random) {}

  relocate(player: PlayerId, position: Vec3): void {
    this.previous.set(player, this.chest(position))
  }

  canFreeze(player: PlayerId): boolean {
    const phase = this.phase
    if (phase.kind !== 'flight') return false
    const chest = this.previous.get(phase.target)
    return (
      this.living.has(player) &&
      !phase.enteredBlockSphere &&
      chest !== undefined &&
      length(subtract(phase.position, chest)) > rules.blockRadius
    )
  }

  freeze(now: number, player: PlayerId): boolean {
    if (this.phase.kind !== 'flight' || !this.canFreeze(player)) return false
    this.phase = {
      kind: 'frozen',
      flight: this.phase,
      started: now,
      until: now + timeFreezeDuration,
    }
    return true
  }

  tick(now: number, participants: readonly Participant[]): RoundEvent[] {
    const events: RoundEvent[] = []
    const dt = Math.max(0, now - this.lastTime)
    const fromTime = this.lastTime
    this.lastTime = now
    const people = new Map(participants.map((p) => [p.id, p]))
    const phase = this.phase

    if (phase.kind === 'waiting' || phase.kind === 'countdown') {
      if (participants.length < 2 || participants.some((p) => !p.ready))
        this.phase = { kind: 'waiting' }
      else if (phase.kind === 'waiting')
        this.phase = { kind: 'countdown', until: now + rules.countdown }
      else if (now >= phase.until) {
        this.living.clear()
        this.consumed.clear()
        this.refreshable.clear()
        this.previous.clear()
        for (const p of participants) this.living.add(p.id)
        this.phase = { kind: 'spawning', until: now + rules.spawnTimeout }
        events.push({ kind: 'spawn', players: [...this.living] })
      }
    } else if (phase.kind === 'intermission') {
      if (now >= phase.until) this.phase = { kind: 'waiting' }
    } else if (phase.kind === 'spawning') {
      for (const id of this.living) {
        if (
          !people.has(id) ||
          (now >= phase.until && !people.get(id)?.body?.alive)
        ) {
          this.living.delete(id)
          events.push({ kind: 'eliminate', player: id, reason: 'spawn' })
        }
      }
      if (this.living.size < 2) {
        this.finish(now, events)
      } else if ([...this.living].every((id) => people.get(id)?.body?.alive)) {
        this.number++
        this.serve(now, events)
      }
    } else {
      for (const id of this.living) {
        const participant = people.get(id),
          body = participant?.body
        const reason = !participant
          ? 'disconnect'
          : !body?.alive
            ? 'death'
            : this.outside(body.position)
              ? 'fall'
              : undefined
        if (reason) {
          this.living.delete(id)
          events.push({ kind: 'eliminate', player: id, reason })
        }
      }
      if (this.living.size <= 1) this.finish(now, events)
      else if (
        ((phase.kind === 'serve' || phase.kind === 'flight') &&
          !this.living.has(phase.target)) ||
        (phase.kind === 'frozen' && !this.living.has(phase.flight.target))
      ) {
        this.phase = { kind: 'reset', until: now + rules.ballReset }
      } else if (phase.kind === 'reset' && now >= phase.until)
        this.serve(now, events)
      else if (phase.kind === 'serve' && now >= phase.until) {
        const body = people.get(phase.target)?.body
        if (body)
          this.phase = {
            kind: 'flight',
            target: phase.target,
            position: phase.position,
            power: rules.startingPower,
            orbitSeconds: 0,
            enteredBlockSphere: false,
            selectedAt: phase.until - rules.serveWarning,
            safeUntil: now,
            velocity: this.launchVelocity(
              subtract(this.chest(body.position), phase.position),
              rules.serveSpeed,
            ),
          }
      } else if (phase.kind === 'frozen' && now >= phase.until) {
        const flight: Flight = {
          ...phase.flight,
          safeUntil:
            phase.until + Math.max(0, phase.flight.safeUntil - phase.started),
        }
        this.phase = flight
        events.push({ kind: 'resume', player: flight.target })
        this.fly(now, fromTime, dt, flight, people, events, phase.until)
      } else if (phase.kind === 'flight')
        this.fly(now, fromTime, dt, phase, people, events)
    }

    for (const p of participants)
      if (p.body) this.previous.set(p.id, this.chest(p.body.position))
    for (const id of this.previous.keys())
      if (!people.has(id)) this.previous.delete(id)
    return events
  }

  private chest(position: Vec3): Vec3 {
    return { ...position, z: position.z + rules.chestHeight }
  }

  private launchVelocity(aim: Vec3, speed: number): Vec3 {
    const heading = normalized(aim)
    return { x: heading.x * speed, y: heading.y * speed, z: heading.z * speed }
  }

  private outside(p: Vec3): boolean {
    return (
      Math.abs(p.x) > rules.roofHalfExtent ||
      Math.abs(p.y) > rules.roofHalfExtent ||
      p.z < rules.minimumHeight
    )
  }

  private serve(now: number, events: RoundEvent[]): void {
    const ids = [...this.living]
    const target =
      ids[Math.min(ids.length - 1, Math.floor(this.random() * ids.length))]
    if (!target) return
    this.rally = 0
    this.phase = {
      kind: 'serve',
      target,
      position: rules.center,
      until: now + rules.serveWarning,
    }
    this.select(target, events)
  }

  private select(player: PlayerId, events: RoundEvent[]): void {
    events.push({
      kind: 'target',
      player,
      refresh: this.refreshable.delete(player),
    })
  }

  private finish(now: number, events: RoundEvent[]): void {
    const winner = [...this.living][0]
    this.phase = {
      kind: 'intermission',
      until: now + rules.intermission,
      winner,
    }
    events.push({ kind: 'winner', player: winner })
  }

  private aimTarget(
    from: PlayerId,
    body: Body,
    people: ReadonlyMap<PlayerId, Participant>,
  ): PlayerId | undefined {
    let best: PlayerId | undefined,
      bestDot = -Infinity
    for (const id of this.living) {
      const other = people.get(id)?.body
      if (id === from || !other) continue
      const offset = subtract(other.position, body.position)
      const distance = length(offset)
      const score = distance === 0 ? 1 : dot(body.look, offset) / distance
      if (score > bestDot) {
        best = id
        bestDot = score
      }
    }
    return best
  }

  private fly(
    now: number,
    fromTime: number,
    dt: number,
    flight: Flight,
    people: ReadonlyMap<PlayerId, Participant>,
    events: RoundEvent[],
    activeFrom = fromTime,
  ): void {
    const body = people.get(flight.target)?.body
    if (!body || dt === 0) return
    const target = this.chest(body.position)
    const startTarget = this.previous.get(flight.target) ?? target
    const parries = body.parries.filter(
      (parry) =>
        parry.ends > fromTime &&
        parry.started >= flight.selectedAt &&
        parry.started !== this.consumed.get(flight.target),
    )
    let position = flight.position,
      velocity = flight.velocity,
      power = flight.power,
      orbitSeconds = flight.orbitSeconds,
      enteredBlockSphere = flight.enteredBlockSphere
    for (let time = Math.max(fromTime, activeFrom); time < now;) {
      const until = Math.min(now, time + 1 / 120)
      const step = until - time
      const targetFrom = mix(startTarget, target, (time - fromTime) / dt)
      const targetTo = mix(startTarget, target, (until - fromTime) / dt)
      const offset = subtract(targetTo, position),
        distance = length(offset)
      power = Math.min(rules.powerCap, power + rules.passivePowerGain * step)
      const previousSpeed = length(velocity)
      velocity = astroVelocity(position, velocity, targetTo, power, step)
      const heading = normalized(velocity),
        movingSpeed = length(velocity)
      const travel =
        distance < 1e-6
          ? 0
          : dot(heading, normalized(offset)) > 1 - 1e-6
            ? Math.min(movingSpeed * step, distance)
            : movingSpeed * step
      const end = {
        x: position.x + heading.x * travel,
        y: position.y + heading.y * travel,
        z: Math.max(rules.ballFloorHeight, position.z + heading.z * travel),
      }
      if (end.z === rules.ballFloorHeight && velocity.z < 0) {
        velocity = { ...velocity, z: 0 }
      }
      enteredBlockSphere ||=
        contact(position, end, targetFrom, targetTo, rules.blockRadius) !==
        undefined

      if (until >= flight.safeUntil) {
        const usableFrom = Math.max(
          0,
          Math.min(1, (flight.safeUntil - time) / step),
        )
        const intersection = (
          from: number,
          to: number,
          radius: number,
        ): number | undefined => {
          const t = contact(
            mix(position, end, from),
            mix(position, end, to),
            mix(targetFrom, targetTo, from),
            mix(targetFrom, targetTo, to),
            radius,
          )
          return t === undefined ? undefined : from + (to - from) * t
        }
        const hit = intersection(usableFrom, 1, rules.hitRadius)
        let block: number | undefined
        let activation: number | undefined
        for (const parry of parries) {
          const from = Math.max(usableFrom, (parry.started - time) / step)
          const to = Math.min(1, (parry.ends - time) / step)
          if (from <= to) {
            const candidate = intersection(from, to, rules.blockRadius)
            if (
              candidate !== undefined &&
              time + candidate * step < parry.ends &&
              (block === undefined || candidate < block)
            ) {
              block = candidate
              activation = parry.started
            }
          }
        }
        if (
          block !== undefined &&
          (hit === undefined || block <= hit) &&
          activation !== undefined
        ) {
          const next = this.aimTarget(flight.target, body, people)
          if (!next) return
          this.consumed.set(flight.target, activation)
          this.rally++
          this.refreshable.add(flight.target)
          const nextPower = Math.min(
            rules.powerCap,
            power * rules.powerMultiplier,
          )
          this.phase = {
            kind: 'flight',
            target: next,
            selectedAt: now,
            safeUntil: now + rules.minimumFlight,
            position: mix(position, end, block),
            power: nextPower,
            velocity: this.launchVelocity(
              body.look,
              power * (body.empowered ? powerSlashMultiplier : 1),
            ),
            orbitSeconds: 0,
            enteredBlockSphere: false,
          }
          events.push({
            kind: 'block',
            player: flight.target,
            power: nextPower,
            empowered: body.empowered,
          })
          this.select(next, events)
          return
        } else if (hit !== undefined) {
          this.living.delete(flight.target)
          events.push({
            kind: 'eliminate',
            player: flight.target,
            reason: 'ball',
          })
          if (this.living.size <= 1) this.finish(now, events)
          else this.phase = { kind: 'reset', until: now + rules.ballReset }
          return
        }
      }
      const closeAndSlow =
        !people.get(flight.target)?.bot &&
        Math.max(previousSpeed, length(velocity)) < rules.orbitSlowSpeed &&
        length(subtract(position, targetFrom)) < rules.orbitRadius &&
        length(subtract(end, targetTo)) < rules.orbitRadius
      orbitSeconds = closeAndSlow ? orbitSeconds + step : 0
      if (orbitSeconds >= rules.orbitTime) {
        const horizontal = normalized({ x: velocity.x, y: velocity.y, z: 0 })
        events.push({
          kind: 'orbit',
          player: flight.target,
          push: this.launchVelocity({ ...horizontal, z: 1 }, rules.orbitPush),
        })
        orbitSeconds = 0
      }
      position = end
      time = until
    }
    this.phase = {
      ...flight,
      position,
      velocity,
      power,
      orbitSeconds,
      enteredBlockSphere,
    }
  }
}
