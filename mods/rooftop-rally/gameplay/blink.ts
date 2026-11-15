import type { MovementCommand } from 'modlock'
import { blinkDistance } from './special'
import { length, normalized, subtract, type Vec3 } from './geometry'

export function movementHeading(
  yaw: number,
  movement: Pick<MovementCommand, 'forward' | 'left'> | undefined,
): Vec3 {
  const angle = (yaw * Math.PI) / 180
  const forward = movement?.forward ?? 0
  const left = movement?.left ?? 0
  if (Math.hypot(forward, left) < 0.01)
    return { x: Math.cos(angle), y: Math.sin(angle), z: 0 }
  return normalized({
    x: Math.cos(angle) * forward - Math.sin(angle) * left,
    y: Math.sin(angle) * forward + Math.cos(angle) * left,
    z: 0,
  })
}

type Obstacle = { position: Vec3; startSolid: boolean }
type Trace = (start: Vec3, end: Vec3) => Obstacle | undefined

// The SDK exposes only line traces, so parallel ones cover the player's width and height.
export function blinkDestination({
  origin,
  heading,
  trace,
}: {
  origin: Vec3
  heading: Vec3
  trace: Trace
}): Vec3 | undefined {
  let distance = blinkDistance
  for (const side of [-24, 0, 24])
    for (const height of [8, 36, 68]) {
      const start = {
        x: origin.x - heading.y * side,
        y: origin.y + heading.x * side,
        z: origin.z + height,
      }
      const end = {
        x: start.x + heading.x * (blinkDistance + 28),
        y: start.y + heading.y * (blinkDistance + 28),
        z: start.z,
      }
      const hit = trace(start, end)
      if (hit?.startSolid) return undefined
      if (hit)
        distance = Math.min(
          distance,
          Math.max(0, length(subtract(hit.position, start)) - 28),
        )
    }
  if (distance < 1) return undefined
  return {
    x: origin.x + heading.x * distance,
    y: origin.y + heading.y * distance,
    z: origin.z,
  }
}
