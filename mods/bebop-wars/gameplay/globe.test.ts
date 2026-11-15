import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceGlobe, burstContains, chilledMomentum, globeAim, globeRules } from './globe.ts'

const start = { x: 0, y: 0, z: 80 }
const flight = { position: start, direction: { x: 0, y: 0, z: 1 }, travelled: 0, updatedAt: 1 }

test('sky aim travels upward without needing a floor', () => {
  const aim = globeAim(start, start, { pitch: -90, yaw: 0 }, () => undefined)
  assert.ok(aim)
  assert.ok(aim.direction.z > 0.999)
})

test('swept flight stops at walls even across a long server step', () => {
  const moved = advanceGlobe(flight, 2, (from, to) => {
    assert.equal(from.z, 80)
    assert.ok(to.z > 400)
    return { position: { ...start, z: 400 }, startSolid: false }
  })
  assert.equal(moved.position.z, 398)
  assert.equal(moved.ended, true)
})

test('flight caps at 30m and cannot move on a repeated timestamp', () => {
  const end = advanceGlobe(flight, 10, () => undefined)
  assert.equal(end.travelled, globeRules.range)
  assert.equal(end.ended, true)
  assert.deepEqual(advanceGlobe(flight, 1, () => undefined).position, start)
})

test('burst includes aerial bodies in a sphere and excludes high targets outside it', () => {
  assert.equal(burstContains(start, { x: 0, y: 0, z: 40 + globeRules.radius }), true)
  assert.equal(burstContains(start, { x: 0, y: 0, z: 41 + globeRules.radius }), false)
  assert.equal(burstContains(start, { x: 80, y: 80, z: 40 }), true)
  assert.equal(burstContains(start, { x: 120, y: 120, z: 40 }), false)
  assert.equal(globeRules.radiusMeters, 4)
})

test('chill reduces existing aerial momentum once without reversing it', () => {
  assert.deepEqual(chilledMomentum({ x: 100, y: -200, z: 300 }), { x: 60, y: -120, z: 180 })
})
