import assert from 'node:assert/strict'
import test from 'node:test'
import { activationStatus, type ActivationSample, type NativeActivation } from './activation.ts'
import { accountId } from './model.ts'

const actor = { id: accountId('steam:1'), generation: 2, life: 3 }
const attempt: NativeActivation = { actor, entity: 10, ability: 20, requestedAt: 5 }
const sample: ActivationSample = { actor, entity: 10, alive: true, executed: new Set() }

test('native Sprint waits for the game to cast its own ability, then acknowledges once', () => {
  assert.equal(activationStatus(attempt, sample, 5.1), 'pending')
  assert.equal(activationStatus(attempt, { ...sample, executed: new Set([21]) }, 5.2), 'pending')
  assert.equal(activationStatus(attempt, { ...sample, executed: new Set([21, 20]) }, 5.2), 'active')
  assert.equal(activationStatus(attempt, sample, 6), 'timedOut')
})

test('pending native activation cannot carry into death, another body, life or connection', () => {
  const invalid: ActivationSample[] = [
    { ...sample, alive: false },
    { ...sample, entity: 11 },
    { ...sample, actor: undefined },
    { ...sample, actor: { ...actor, life: 4 } },
    { ...sample, actor: { ...actor, generation: 3 } },
  ]
  for (const current of invalid) assert.equal(activationStatus(attempt, { ...current, executed: new Set([20]) }, 5.1), 'cancelled')
})
