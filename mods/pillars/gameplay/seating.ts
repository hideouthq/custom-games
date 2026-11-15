import { arena } from './config'

export interface Point {
  x: number
  y: number
  z: number
}

export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function pillarAngle(index: number): number {
  return (360 * index) / arena.pillars
}

export function pillarTop(index: number): Point {
  const angle = (pillarAngle(index) * Math.PI) / 180
  return {
    x: arena.ringRadius * Math.cos(angle),
    y: arena.ringRadius * Math.sin(angle),
    z: arena.topZ,
  }
}

export function pillarStand(index: number): Point {
  const angle = (pillarAngle(index) * Math.PI) / 180
  const top = pillarTop(index)
  return {
    x: top.x - arena.standOffset * Math.sin(angle),
    y: top.y + arena.standOffset * Math.cos(angle),
    z: top.z,
  }
}

export function facingCentre(index: number): number {
  return (pillarAngle(index) + 180) % 360
}

export function deckSpot(index: number, count: number): Point {
  const angle = (2 * Math.PI * index) / Math.max(1, count)
  const radius = count <= 1 ? 0 : arena.centreRadius * 0.55
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    z: arena.centreZ,
  }
}

export function seats(count: number, offset: number): number[] {
  const players = Math.max(0, Math.min(count, arena.pillars))
  const spread = players * 2 > arena.pillars
  const step = players <= 4 ? 1 : 2
  const taken: number[] = []
  for (let seat = 0; seat < players; seat++) {
    const base = spread
      ? Math.floor((seat * arena.pillars) / players)
      : seat * step
    taken.push(
      (((base + offset) % arena.pillars) + arena.pillars) % arena.pillars,
    )
  }
  return taken
}
