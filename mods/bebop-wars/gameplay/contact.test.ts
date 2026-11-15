import assert from 'node:assert/strict'
import test from 'node:test'
import { hookContacts, type Cast, type Landed } from './contact.ts'
import { accountId, type AccountId, type Frame, type Observation } from './model.ts'

const blue = accountId('blue'), amber = accountId('amber'), blue2 = accountId('blue2')
function player(id: AccountId, slot: number, side: 2 | 3, victim?: AccountId, health = 1000): Observation {
  return { id, slot, generation: 1, name: id, bot: false, body: { entity: slot + 100, alive: health > 0, side, health, maxHealth: 1000, souls: 0, abilityPoints: 0, hookRank: 0, nativeItems: [], position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, hook: { entity: slot + 500, casting: victim !== undefined, victim, startedAt: 0, cooldownEnd: 0, executed: false } } }
}
function held(victim: AccountId, owner: AccountId): Frame['pulls'] { return new Map([[victim, { kind: 'held', owner }]]) }
const casts = (serial: number): Map<AccountId, Cast> => new Map([[blue, { entity: 500, serial }], [amber, { entity: 501, serial: 1 }], [blue2, { entity: 502, serial: 1 }]])

test('an enemy Hook hits once when it latches, not again while it reels', () => {
  const landed = new Map<AccountId, Landed>()
  assert.deepEqual(hookContacts([player(blue, 0, 3), player(amber, 1, 2)], new Map(), casts(1), landed), [])
  const hit = hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2)], held(amber, blue), casts(1), landed)
  assert.deepEqual(hit, [{ caster: blue, victim: amber, attacker: 100, target: 101, ability: 500, amount: 550, healthBefore: 1000 }])
  assert.deepEqual(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2, undefined, 450)], held(amber, blue), casts(1), landed), [])
  assert.deepEqual(hookContacts([player(blue, 0, 3), player(amber, 1, 2, undefined, 450)], new Map(), casts(1), landed), [])
})
test('the Hook naming a new victim counts before the pull modifier appears', () => {
  const landed = new Map<AccountId, Landed>()
  hookContacts([player(blue, 0, 3), player(amber, 1, 2)], new Map(), casts(1), landed)
  assert.equal(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2)], new Map(), casts(1), landed).length, 1)
  assert.equal(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2)], held(amber, blue), casts(1), landed).length, 0)
})
test('a victim handle left over from an earlier throw or session never hits', () => {
  const landed = new Map<AccountId, Landed>()
  assert.deepEqual(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2)], new Map(), casts(1), landed), [])
  assert.deepEqual(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2)], new Map(), casts(2), landed), [])
})
test('the next throw hits again and a friendly latch deals nothing', () => {
  const landed = new Map<AccountId, Landed>()
  hookContacts([player(blue, 0, 3), player(amber, 1, 2), player(blue2, 2, 3)], new Map(), casts(1), landed)
  assert.equal(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2), player(blue2, 2, 3)], held(amber, blue), casts(1), landed).length, 1)
  hookContacts([player(blue, 0, 3), player(amber, 1, 2), player(blue2, 2, 3)], new Map(), casts(1), landed)
  assert.equal(hookContacts([player(blue, 0, 3, amber), player(amber, 1, 2), player(blue2, 2, 3)], held(amber, blue), casts(2), landed).length, 1)
  hookContacts([player(blue, 0, 3), player(amber, 1, 2), player(blue2, 2, 3)], new Map(), casts(2), landed)
  assert.deepEqual(hookContacts([player(blue, 0, 3, blue2), player(amber, 1, 2), player(blue2, 2, 3)], held(blue2, blue), casts(3), landed), [])
})
