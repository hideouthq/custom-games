import { createParticle, emitSound, log, type WorldObject } from 'modlock'
import type { Vec3 } from './arena.ts'
import { globeRules } from './globe.ts'
import type { Side } from './hud-model.ts'
import type { Piano, SnowGlobe } from './model.ts'
import { pianoRules } from './piano.ts'

const globeResource = 'particles/abilities/kelvin/kelvin_ice_grenade_projectile.vpcf'
const chillResource = 'particles/abilities/kelvin/kelvin_ice_grenade_slow.vpcf'
const impactResource = 'particles/abilities/kelvin/kelvin_ice_grenade_explode_v2.vpcf'
const pianoResource = 'particles/upgrades/mystical_piano.vpcf'
const pianoWarningResource = 'particles/upgrades/mystical_piano_aoe_indicator.vpcf'
const pianoHitResource = 'particles/upgrades/mystical_piano_hit.vpcf'
const rescueResource = 'particles/{addon}/bebop_rescue_pulse.vpcf'
export const effectResources = [globeResource, impactResource, chillResource, rescueResource, pianoResource, pianoWarningResource, pianoHitResource]

interface Effect { readonly object: WorldObject; readonly until: number; readonly globe?: number }

export class NativeEffects {
  private readonly shown = new Map<string, Effect>()

  clear(): void { this.shown.clear() }

  globeLaunched(globe: SnowGlobe, now: number): boolean {
    const object = createParticle({ resource: globeResource, position: globe.position })
    if (!object) {
      log(`[BebopWars] ERROR Snow Globe particle unavailable: ${globeResource}`)
      return false
    }
    this.shown.set(`globe:${globe.id}`, { object, until: now + globeRules.range / globeRules.speed + 1, globe: globe.id })
    return true
  }

  globeBurst(id: number, position: Vec3, now: number): void {
    this.remove(`globe:${id}`)
    const object = createParticle({ resource: impactResource, position, point: { index: 1, position: { x: globeRules.radius, y: 1, z: 1 } } })
    if (!object) {
      log(`[BebopWars] ERROR Snow Globe explosion unavailable: ${impactResource}`)
      return
    }
    this.shown.set(`impact:${id}`, { object, until: now + 3 })
    const entity = object.entity()
    if (entity !== undefined) emitSound(entity, 'Kelvin.IceGrenade.Explode')
  }

  chill(id: number, pawn: { readonly entity: number; readonly position: Vec3 }, until: number): void {
    const object = createParticle({ resource: chillResource, position: pawn.position, parent: pawn.entity })
    if (object) this.shown.set(`chill:${id}`, { object, until })
  }

  pianoCast(piano: Piano): void {
    // The warning and the fall take the landing's radius on their second control point; the smash needs none.
    const radius = { index: 1, position: { x: pianoRules.radius, y: 1, z: 1 } }
    const warning = createParticle({ resource: pianoWarningResource, position: piano.mark, point: radius })
    const falling = createParticle({ resource: pianoResource, position: piano.mark, point: radius })
    if (warning) this.shown.set(`piano-warning:${piano.id}`, { object: warning, until: piano.landsAt })
    if (falling) this.shown.set(`piano-fall:${piano.id}`, { object: falling, until: piano.landsAt + 0.3 })
    if (!warning && !falling) log('[BebopWars] ERROR Mystical Piano effects unavailable')
    const entity = (warning ?? falling)?.entity()
    if (entity !== undefined) emitSound(entity, 'Mystical.Piano.AOE.Warning')
  }

  pianoLanded(id: number, mark: Vec3, now: number): void {
    this.remove(`piano-warning:${id}`)
    const object = createParticle({ resource: pianoHitResource, position: mark })
    if (!object) return
    this.shown.set(`piano-hit:${id}`, { object, until: now + 3 })
    const entity = object.entity()
    if (entity !== undefined) emitSound(entity, 'Mystical.Piano.AOE.Explode')
  }

  rescue(id: number, position: Vec3, side: Side, now: number): void {
    const object = createParticle({
      resource: rescueResource, position: { ...position, z: position.z + 3 },
      point: { index: 1, position: { x: globeRules.radius, y: globeRules.radius, z: globeRules.radius } },
      color: side === 3 ? 0x8ddcffff : 0xffbb73ff, tintPoint: 2,
    })
    if (object) this.shown.set(`rescue:${id}`, { object, until: now + 0.8 })
  }

  update(globes: readonly SnowGlobe[], now: number): void {
    for (const globe of globes) this.shown.get(`globe:${globe.id}`)?.object.move(globe.position)
    const flying = new Set(globes.map(globe => globe.id))
    for (const [key, effect] of this.shown) {
      if (effect.until <= now || (effect.globe !== undefined && !flying.has(effect.globe))) this.remove(key)
    }
  }

  private remove(key: string): void {
    this.shown.get(key)?.object.remove()
    this.shown.delete(key)
  }
}
