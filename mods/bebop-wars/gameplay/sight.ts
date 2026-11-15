import { type Vec3 } from './arena.ts'

const unitsPerMeter = 39.37007874
export const knockdownRules = { range: 30 * unitsPerMeter, cone: 9, delay: 2, stun: 0.9 }
export interface Sighted<T> { readonly id: T; readonly position: Vec3 }

export function inSights<T>(camera: Vec3, angles: { pitch: number; yaw: number }, heroes: readonly Sighted<T>[], range: number, cone: number, clear: (start: Vec3, end: Vec3) => boolean): T | undefined {
  const pitch = angles.pitch * Math.PI / 180, yaw = angles.yaw * Math.PI / 180
  const forward = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: -Math.sin(pitch) }
  let best: T | undefined, bestAngle = cone
  for (const hero of heroes) {
    const chest = { x: hero.position.x, y: hero.position.y, z: hero.position.z + 48 }
    const offset = { x: chest.x - camera.x, y: chest.y - camera.y, z: chest.z - camera.z }
    const length = Math.hypot(offset.x, offset.y, offset.z)
    if (length < 1 || length > range) continue
    const angle = Math.acos(Math.min(1, Math.max(-1, (offset.x * forward.x + offset.y * forward.y + offset.z * forward.z) / length))) * 180 / Math.PI
    if (angle > bestAngle || !clear(camera, chest)) continue
    best = hero.id; bestAngle = angle
  }
  return best
}
