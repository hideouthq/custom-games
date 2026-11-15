import { type Vec3 } from './arena.ts'

const unitsPerMeter = 39.37007874
export const pianoRules = { range: 25 * unitsPerMeter, delay: 1.7, radius: 9 * unitsPerMeter, reach: 160, stun: 1 }
export interface PianoSurface { readonly position: Vec3; readonly startSolid: boolean }
export type PianoTrace = (start: Vec3, end: Vec3) => PianoSurface | undefined

export function pianoMark(camera: Vec3, angles: { pitch: number; yaw: number }, trace: PianoTrace): Vec3 | undefined {
  const pitch = angles.pitch * Math.PI / 180, yaw = angles.yaw * Math.PI / 180
  const forward = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: -Math.sin(pitch) }
  const along = (length: number): Vec3 => ({ x: camera.x + forward.x * length, y: camera.y + forward.y * length, z: camera.z + forward.z * length })
  const hit = trace(camera, along(pianoRules.range))
  if (hit?.startSolid) return undefined
  const reach = hit ? Math.max(0, Math.hypot(hit.position.x - camera.x, hit.position.y - camera.y, hit.position.z - camera.z) - 8) : pianoRules.range
  const below = (point: Vec3): Vec3 | undefined => {
    const ground = trace({ ...point, z: point.z + lift }, { ...point, z: point.z - 8 })
    return ground && !ground.startSolid ? ground.position : undefined
  }
  for (let length = stride; length < reach; length += stride) {
    const ground = below(along(length))
    if (ground) return ground
  }
  const end = along(reach)
  const ground = trace({ ...end, z: end.z + lift }, { ...end, z: end.z - 4000 })
  return ground && !ground.startSolid ? ground.position : undefined
}
const stride = 24, lift = 120

export function flattened(mark: Vec3, feet: Vec3): boolean {
  return Math.hypot(mark.x - feet.x, mark.y - feet.y) <= pianoRules.radius && Math.abs(mark.z - feet.z) <= pianoRules.reach
}
