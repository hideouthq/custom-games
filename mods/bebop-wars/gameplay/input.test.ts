import assert from 'node:assert/strict'
import test from 'node:test'
import { inputGate } from './input.ts'

const hook = 1n << 35n

test('holding a key through menu close cannot cast until a real release', () => {
  let gate = inputGate(undefined, 'menu', hook, hook)
  gate = inputGate(gate, 'playing', hook, hook)
  for (let tick = 0; tick < 10; tick++) gate = inputGate(gate, 'playing', hook, hook)
  assert.equal(gate.armed, false)
  gate = inputGate(gate, 'playing', 0n, hook)
  assert.equal(gate.armed, true)
})

test('a new life cannot inherit an armed input gate', () => {
  let gate = inputGate(undefined, 'life1', 0n, hook)
  gate = inputGate(gate, 'life1', 0n, hook)
  assert.equal(gate.armed, true)
  gate = inputGate(gate, 'life2', hook, hook)
  assert.equal(gate.armed, false)
})
