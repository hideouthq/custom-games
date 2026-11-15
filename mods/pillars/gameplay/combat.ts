// Native melee deals nothing to a same-team hero, so the mode sets the
// damage. Ground friction swallows small pushes, so a knock always carries
// lift.
import { combat, rules, unitsPerMetre } from './config'
import type { Point } from './seating'

export type Melee = 'light' | 'heavy'

const heavyFlag = 1n << 33n
const lightFlag = 1n << 34n

export function meleeOf(flags: bigint): Melee | undefined {
  if ((flags & heavyFlag) !== 0n) {
    return 'heavy'
  }
  return (flags & lightFlag) !== 0n ? 'light' : undefined
}

export function meleeDamage(melee: Melee): number {
  return combat.melee[melee]
}

export function knock(
  attacker: Point,
  victim: Point,
  melee: Melee,
  missing: number,
  scale: number,
): Point {
  const lack = Math.min(1, Math.max(0, missing))
  const speed = combat.knock[melee] * (1 + lack) * scale
  const lift = Math.min(combat.maxLift * scale, speed * combat.liftRatio)

  const dx = victim.x - attacker.x
  const dy = victim.y - attacker.y
  const length = Math.hypot(dx, dy)
  const ux = length > 0.001 ? dx / length : 1
  const uy = length > 0.001 ? dy / length : 0
  return {
    x: ux * speed * unitsPerMetre,
    y: uy * speed * unitsPerMetre,
    z: lift * unitsPerMetre,
  }
}

export class Credit {
  private readonly hits = new Map<number, { by: number; at: number }>()

  hit(victim: number, attacker: number, time: number): void {
    if (attacker !== victim) {
      this.hits.set(victim, { by: attacker, at: time })
    }
  }

  of(victim: number, time: number): number | undefined {
    const hit = this.hits.get(victim)
    return hit !== undefined && time - hit.at <= rules.creditSeconds
      ? hit.by
      : undefined
  }

  clear(): void {
    this.hits.clear()
  }
}
