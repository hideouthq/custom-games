import type { Side } from './hud-model.ts'

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

export const arena = {
  halfWidth: 1184,
  containReach: 96,
  back: 1097.6,
  canalFloor: -128,
  hookRange: 30 * 39.37007874,
  bayCenters: [-704, 704],
} as const

export function opposite(side: Side): Side { return side === 2 ? 3 : 2 }
export function direction(side: Side): number { return side === 3 ? 1 : -1 }

export function bankEdge(x: number): number {
  for (const centre of arena.bayCenters) {
    const distance = Math.abs(x - centre)
    if (distance <= 344) return 208
    if (distance <= 384) return 208 + distance - 344
  }
  return 320
}

export function onBank(point: Vec3, side: Side): boolean {
  return Math.abs(point.x) <= arena.halfWidth && direction(side) * point.y >= bankEdge(point.x)
}

export function inBank(point: Vec3, side: Side): boolean {
  const y = direction(side) * point.y
  return onBank(point, side) && y <= arena.back + (Math.abs(point.x) <= 176 ? 160 : 0) && point.z > arena.canalFloor
}

export function contain(point: Vec3, side: Side): Vec3 | undefined {
  if (point.z <= arena.canalFloor) return undefined
  const x = Math.max(-arena.halfWidth, Math.min(arena.halfWidth, point.x))
  const back = arena.back + (Math.abs(x) <= 176 ? 160 : 0)
  const y = Math.max(bankEdge(x), Math.min(back, direction(side) * point.y))
  return { x, y: direction(side) * y, z: point.z }
}

export function spawn(side: Side, seat: number, teamSize: 1 | 2 | 3 = 3): Vec3 {
  return { x: (seat - (teamSize - 1) / 2) * 96, y: direction(side) * 984, z: 104 }
}

export function inShop(point: Vec3, side: Side): boolean {
  const y = direction(side) * point.y
  return Math.abs(point.x) <= 176 && y >= 896 && y <= 1110 && point.z >= 80 && point.z <= 264
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function horizontalDistance(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y) }
