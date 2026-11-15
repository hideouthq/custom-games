import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint.ts'
import { accountId, actor, configuration, initial, settle, step, type Frame, type Observation } from './model.ts'

function seeded() {
  const config = configuration(['teams=1v1'])
  const blue = accountId('blue'), amber = accountId('amber')
  const players: Observation[] = [blue, amber].map((id, slot) => ({ id, slot, generation: 1, name: id, bot: false, body: { entity: slot + 10, alive: true, side: slot === 0 ? 3 : 2, health: 1000, maxHealth: 1000, souls: 600, abilityPoints: 2, hookRank: 1, nativeItems: [], position: { x: 0, y: slot === 0 ? 984 : -984, z: 104 }, velocity: { x: 0, y: 0, z: 0 }, hook: { entity: slot + 30, casting: false, victim: undefined, startedAt: 0, cooldownEnd: 0, executed: false } } }))
  const frame: Frame = { now: 1, players, deaths: [], globes: new Map(), pulls: new Map() }
  const state = step(initial(config), frame).state
  const fighter = state.fighters.get(blue)
  assert.ok(fighter)
  const ref = actor(fighter)
  assert.ok(ref)
  fighter.progression.owned = ['sprint']
  fighter.progression.utility = 'sprint'
  fighter.progression.purchase = { id: 25, round: 1, actor: ref, product: 'echo' }
  fighter.setupUntil = 20
  fighter.utilityUntil = 35
  fighter.roundSide = 3
  fighter.kills = 5
  assert.ok(fighter.life.kind === 'alive')
  fighter.life.bank = 2
  fighter.life.safe = { x: 704, y: -240, z: 104 }
  fighter.life.position = fighter.life.safe
  state.round = 1
  state.phase = { kind: 'live', until: 480 }
  state.now = 10
  state.nextEvent = 26
  return { state, config, blue, amber, frame }
}

test('same-match checkpoint preserves occupied bank, ownership and cooldowns', () => {
  const { state, config, blue } = seeded()
  const resumed = decodeCheckpoint(encodeCheckpoint(state), config)
  assert.ok(resumed)
  assert.deepEqual(resumed, state)
  const pending = resumed.fighters.get(blue)?.progression.purchase
  assert.ok(pending)
  const paid = settle(resumed, [{ kind: 'purchase', actor: pending.actor, round: pending.round, id: pending.id, result: 'bought' }])
  assert.deepEqual(paid.fighters.get(blue)?.progression.owned, ['sprint', 'echo'])
  assert.equal(paid.fighters.get(blue)?.utilityUntil, 35)
})
test('reload retains unpaid native income and consumed rescue episodes without duplicating baseline income', () => {
  const { state, config, blue, amber, frame } = seeded()
  const fighter = state.fighters.get(blue), enemy = state.fighters.get(amber)
  assert.ok(fighter && enemy)
  const caster = actor(enemy)
  assert.ok(caster)
  state.liveSeconds = 30
  state.score[3] = 4
  fighter.income = { passiveTicks: 3, teamKills: 4, pending: 125, paidSaves: [10, 20, 25] }
  fighter.threat = { caster, cast: 8, resolved: true }
  const restored = decodeCheckpoint(encodeCheckpoint(state), config)
  assert.ok(restored)
  const next = step(restored, { ...frame, now: state.now }).state.fighters.get(blue)
  assert.equal(next?.income.pending, 125)
  assert.deepEqual(next?.income.paidSaves, [10, 20, 25])
  assert.deepEqual(next?.threat, fighter.threat)
})
test('checkpoint restoration does not recreate a native wallet or Hook timer writer', () => {
  const { state, config, blue, frame } = seeded()
  const resumed = decodeCheckpoint(encodeCheckpoint(state), config)
  assert.ok(resumed)
  const next = step(resumed, { ...frame, now: 11 })
  const fighter = next.state.fighters.get(blue)
  assert.ok(fighter)
  assert.equal('souls' in fighter.progression, false)
  assert.equal('hookUntil' in fighter, false)
  assert.equal(fighter.utilityUntil, 35)
  assert.equal(fighter.kills, 5)
  assert.equal(next.commands.some(command => command.kind === 'reset'), false)
})
test('a saved dead life cannot score again when a lethal event repeats', () => {
  const { state, config, blue, amber, frame } = seeded()
  const victim = state.fighters.get(amber), owner = state.fighters.get(blue)
  assert.ok(victim && owner)
  const victimRef = actor(victim), ownerRef = actor(owner)
  assert.ok(victimRef && ownerRef)
  victim.life = { kind: 'dead', confirmed: false, respawnAt: 14 }
  state.score[3] = 1
  const resumed = decodeCheckpoint(encodeCheckpoint(state), config)
  assert.ok(resumed)
  const next = step(resumed, { ...frame, now: 10.5, deaths: [{ victim: victimRef, attacker: ownerRef }] }).state
  assert.equal(next.score[3], 1)
  assert.equal(next.fighters.get(blue)?.kills, 5)
})
test('invalid or incompatible checkpoint cannot introduce ownership or malformed banking', () => {
  const { state, config } = seeded()
  const encoded = encodeCheckpoint(state)
  assert.equal(decodeCheckpoint('', config), undefined)
  assert.equal(decodeCheckpoint('{broken', config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"version":5', '"version":4'), config), undefined)
  assert.equal(decodeCheckpoint(encoded, configuration(['teams=2v2'])), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"kills":5', '"kills":-1'), config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"utility":"sprint"', '"utility":"echo"'), config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"owned":["sprint"]', '"owned":["sprint","sprint"]'), config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"bank":2', '"bank":9'), config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"owned":["sprint"]', '"owned":["longChain"]'), config), undefined)
})
test('new host starts an empty warmup without a checkpoint', () => {
  const config = configuration([])
  assert.equal(decodeCheckpoint('', config), undefined)
  const state = initial(config)
  assert.equal(state.phase.kind, 'warmup')
  assert.equal(state.fighters.size, 0)
  assert.equal(state.round, 0)
})

test('a checkpoint carries the item equipped in each section and refuses one the player does not own', () => {
  const { state, config } = seeded()
  const fighter = Array.from(state.fighters.values())[0]!
  fighter.progression.owned = ['sprint', 'piano', 'etherealShift']
  fighter.progression.setup = 'piano'; fighter.progression.defense = 'etherealShift'; fighter.defenseUntil = 12
  const encoded = encodeCheckpoint(state)
  const restored = Array.from(decodeCheckpoint(encoded, config)!.fighters.values())[0]!
  assert.deepEqual([restored.progression.setup, restored.progression.utility, restored.progression.defense, restored.defenseUntil], ['piano', 'sprint', 'etherealShift', 12])
  assert.equal(decodeCheckpoint(encoded.replace('"setup":"piano"', '"setup":"knockdown"'), config), undefined)
  assert.equal(decodeCheckpoint(encoded.replace('"defense":"etherealShift"', '"defense":"sprint"'), config), undefined)
})
