import { approach, dot, normalized, subtract, type Vec3 } from './geometry'

export function astroVelocity(
  position: Vec3,
  velocity: Vec3,
  target: Vec3,
  power: number,
  dt: number,
): Vec3 {
  const offset = subtract(target, position)
  const approachSpeed = Math.max(0, dot(velocity, normalized(offset)))
  const acceleration =
    3 * Math.sqrt(Math.max(0, (power - approachSpeed) * power))
  const goal = {
    x: 0.93 * velocity.x + offset.x,
    y: 0.93 * velocity.y + offset.y,
    z: 0.93 * velocity.z + offset.z,
  }
  return approach(velocity, goal, acceleration * dt)
}
