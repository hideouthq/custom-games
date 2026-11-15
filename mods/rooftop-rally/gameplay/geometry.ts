export interface Vec3 {
  x: number
  y: number
  z: number
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

export function normalized(v: Vec3): Vec3 {
  const size = length(v)
  return size
    ? { x: v.x / size, y: v.y / size, z: v.z / size }
    : { x: 1, y: 0, z: 0 }
}

export function approach(current: Vec3, target: Vec3, amount: number): Vec3 {
  const distance = length(subtract(target, current))
  return mix(current, target, distance ? Math.min(1, amount / distance) : 1)
}

export function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  }
}

export function contact(
  ballStart: Vec3,
  ballEnd: Vec3,
  targetStart: Vec3,
  targetEnd: Vec3,
  radius: number,
): number | undefined {
  const start = subtract(ballStart, targetStart)
  const delta = subtract(
    subtract(ballEnd, ballStart),
    subtract(targetEnd, targetStart),
  )
  const c = dot(start, start) - radius * radius
  if (c <= 0) return 0
  const a = dot(delta, delta),
    b = 2 * dot(start, delta)
  if (a === 0) return undefined
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return undefined
  const t = (-b - Math.sqrt(discriminant)) / (2 * a)
  return t >= 0 && t <= 1 ? t : undefined
}
