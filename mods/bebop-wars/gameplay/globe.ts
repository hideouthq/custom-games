import { distance, type Vec3 } from './arena.ts'

const unitsPerMeter = 39.37007874
const radiusMeters = 4
export const globeRules = {
  cooldown: 16, radiusMeters, radius: radiusMeters * unitsPerMeter, chill: 1.1, slow: 0.4,
  range: 30 * unitsPerMeter, speed: 40 * unitsPerMeter,
}
export interface Launch { readonly position: Vec3; readonly direction: Vec3 }
export interface Flight extends Launch { readonly travelled: number; readonly updatedAt: number }
export interface Surface { readonly position: Vec3; readonly startSolid: boolean }
export type GlobeTrace = (start: Vec3, end: Vec3) => Surface | undefined

function along(start: Vec3, direction: Vec3, length: number): Vec3 {
  return { x: start.x + direction.x * length, y: start.y + direction.y * length, z: start.z + direction.z * length }
}

export function globeAim(eye: Vec3, camera: Vec3, angles: { pitch: number; yaw: number }, trace: GlobeTrace): Launch | undefined {
  const pitch = angles.pitch * Math.PI / 180, yaw = angles.yaw * Math.PI / 180
  const forward = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: -Math.sin(pitch) }
  const end = along(camera, forward, globeRules.range + distance(camera, eye))
  const hit = trace(camera, end)
  if (hit?.startSolid) return undefined
  const aim = hit?.position ?? end, length = distance(eye, aim)
  if (length < 1) return undefined
  return { position: eye, direction: { x: (aim.x - eye.x) / length, y: (aim.y - eye.y) / length, z: (aim.z - eye.z) / length } }
}

export function advanceGlobe(flight: Flight, now: number, trace: GlobeTrace): Flight & { ended: boolean } {
  const travel = Math.min(globeRules.range - flight.travelled, Math.max(0, now - flight.updatedAt) * globeRules.speed)
  const end = along(flight.position, flight.direction, travel)
  const hit = trace(flight.position, end)
  const covered = hit ? Math.max(0, Math.min(travel, distance(flight.position, hit.position)) - 2) : travel
  return {
    ...flight, position: along(flight.position, flight.direction, covered), updatedAt: now,
    travelled: flight.travelled + covered, ended: hit !== undefined || flight.travelled + travel >= globeRules.range,
  }
}

export function burstContains(burst: Vec3, feet: Vec3): boolean {
  return distance(burst, { ...feet, z: feet.z + 40 }) <= globeRules.radius
}

export function chilledMomentum(velocity: Vec3): Vec3 {
  const retained = 1 - globeRules.slow
  return { x: velocity.x * retained, y: velocity.y * retained, z: velocity.z * retained }
}
