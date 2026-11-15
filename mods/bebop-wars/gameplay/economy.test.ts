import assert from 'node:assert/strict'
import test from 'node:test'
import { catalog, earnedAbilityPoints, hookProfile, isProductId, productIds, spentAbilityPoints, warmupBudget, type ProductId } from './catalog.ts'
import { accountId, actor, acknowledge, configuration, initial, settle, step, type Actor, type Frame, type Observation, type Receipt, type Request, type State } from './model.ts'

const id = accountId('buyer')
function sample(souls: number, alive = true): Observation {
  return { id, slot: 0, generation: 1, name: 'Buyer', bot: false, body: { entity: 100, alive, side: 3, health: alive ? 1000 : 0, maxHealth: 1000, souls, abilityPoints: 0, hookRank: 0, nativeItems: [], position: { x: 0, y: 984, z: 104 }, velocity: { x: 0, y: 0, z: 0 }, hook: { entity: 200, casting: false, victim: undefined, startedAt: 0, cooldownEnd: 20, executed: false } } }
}
function frame(now: number, souls = 300, alive = true): Frame { return { now, players: [sample(souls, alive)], deaths: [], globes: new Map(), pulls: new Map() } }
function buyer(state: State) { const value = state.fighters.get(id); assert.ok(value); return value }
function ref(state: State): Actor { const result = actor(buyer(state)); assert.ok(result); return result }
function boot(live = true): State { const state = step(initial(configuration(['teams=1v1'])), frame(1)).state; if (live) state.phase = { kind: 'live', until: 480 }; return state }
function buy(state: State, product: ProductId): Request { return { kind: 'hud', actor: ref(state), action: { kind: 'buy', product } } }
function receipt(state: State, result: Receipt['result']): Receipt { const pending = buyer(state).progression.purchase; assert.ok(pending); return { kind: 'purchase', actor: pending.actor, id: pending.id, round: pending.round, result } }

test('the catalog lists each section\'s items with native Hook tiers outside the shop', () => {
  assert.deepEqual(Object.keys(catalog).sort(), [...productIds].sort())
  assert.deepEqual(productIds.map(id => catalog[id].group), ['setup', 'setup', 'setup', 'utility', 'utility', 'utility', 'defense', 'defense'])
  assert.equal(new Set(productIds.map(id => catalog[id].nativeItem)).size, productIds.length)
  assert.equal(isProductId('longChain'), false)
  assert.equal(isProductId('quickSpool'), false)
  assert.deepEqual(hookProfile(0), { rangeMeters: 30, cooldown: 5, rebound: 0 })
  assert.deepEqual(hookProfile(3), { rangeMeters: 36, cooldown: 4, rebound: 1 })
})
test('native 1/2/5 costs yield kill thresholds 3, 5 and 10 with a capped budget', () => {
  for (const [kills, points] of [[0, 0], [2, 0], [3, 1], [4, 2], [5, 3], [9, 7], [10, 8], [40, 8]]) assert.equal(earnedAbilityPoints(kills!), points)
  assert.equal(earnedAbilityPoints(3), spentAbilityPoints(1))
  assert.equal(earnedAbilityPoints(5), spentAbilityPoints(2))
  assert.equal(earnedAbilityPoints(10), spentAbilityPoints(3))
})
test('purchase ownership waits for native spending receipt and duplicate clicks issue one command', () => {
  const state = boot()
  const result = step(state, frame(3, 600), [buy(state, 'sprint'), buy(state, 'sprint'), buy(state, 'snowGlobe')])
  assert.equal(result.commands.filter(c => c.kind === 'buy').length, 1)
  assert.deepEqual(buyer(result.state).progression.owned, [])
  const paid = receipt(result.state, 'bought')
  const settled = settle(result.state, [paid, paid])
  assert.deepEqual(buyer(settled).progression.owned, ['sprint'])
  assert.equal(buyer(settled).progression.utility, 'sprint')
  assert.equal(buyer(settled).progression.purchase, null)
  assert.deepEqual(buyer(state).progression.owned, [])
})
test('a failed native purchase consumes no mode ownership and permits retry', () => {
  const state = boot()
  const pending = step(state, frame(3), [buy(state, 'snowGlobe')]).state
  for (const reason of ['unaffordable', 'unavailable'] satisfies Receipt['result'][]) {
    const failed = settle(pending, [receipt(pending, reason)])
    assert.deepEqual(buyer(failed).progression.owned, [])
    assert.equal(buyer(failed).progression.purchase, null)
    assert.ok(step(failed, frame(4), [buy(failed, 'snowGlobe')]).commands.some(c => c.kind === 'buy'))
  }
})
test('late receipts cannot grant ownership to another life, generation or round', () => {
  const state = boot()
  const pending = step(state, frame(3), [buy(state, 'snowGlobe')]).state
  const paid = receipt(pending, 'bought')
  for (const invalid of [{ ...paid, round: paid.round + 1 }, { ...paid, actor: { ...paid.actor, life: paid.actor.life + 1 } }, { ...paid, actor: { ...paid.actor, generation: paid.actor.generation + 1 } }]) {
    assert.deepEqual(buyer(settle(pending, [invalid])).progression.owned, [])
  }
})
test('observed native balance governs affordability without spending pending income', () => {
  const state = boot()
  const poor = step(state, frame(100, 299), [buy(state, 'snowGlobe')])
  assert.equal(poor.commands.some(c => c.kind === 'buy'), false)
  assert.match(buyer(poor.state).notice.text, /Need 1 more/)
  const rich = step(poor.state, frame(101, 600), [buy(poor.state, 'echo')])
  assert.ok(rich.commands.some(c => c.kind === 'buy' && c.product === 'echo'))
  assert.equal('souls' in buyer(rich.state).progression, false)
})
test('warmup native kill income cannot buy more than the starting budget', () => {
  const state = boot(false)
  assert.equal(warmupBudget([]), 300)
  const pending = step(state, frame(3, 5000), [buy(state, 'sprint')]).state
  const paid = settle(pending, [receipt(pending, 'bought')])
  assert.equal(warmupBudget(buyer(paid).progression.owned), 0)
  const again = step(paid, frame(4, 5000), [buy(paid, 'snowGlobe')])
  assert.equal(again.commands.some(c => c.kind === 'buy'), false)
  const echo = step(state, frame(3, 5000), [buy(state, 'echo')])
  assert.equal(echo.commands.some(c => c.kind === 'buy'), false)
})
test('dead buyers purchase for next life while respawn deadline keeps running', () => {
  const state = boot()
  const dead = step(state, frame(3, 600, false)).state
  const pending = step(dead, frame(4, 600, false), [buy(dead, 'echo')]).state
  const paid = settle(pending, [receipt(pending, 'bought')])
  assert.deepEqual(buyer(paid).progression.owned, ['echo'])
  assert.deepEqual(buyer(paid).life, { kind: 'dead', confirmed: true, respawnAt: 7 })
  assert.ok(step(paid, frame(7, 0, false)).commands.some(c => c.kind === 'respawn'))
})
test('buying or equipping another utility never refreshes the slot cooldown', () => {
  const state = boot()
  buyer(state).progression.owned = ['sprint']
  buyer(state).progression.utility = 'sprint'
  buyer(state).utilityUntil = 19
  const pending = step(state, frame(4, 600), [buy(state, 'echo')]).state
  const paid = settle(pending, [receipt(pending, 'bought')])
  assert.equal(buyer(paid).utilityUntil, 19)
  const swapped = step(paid, frame(5), [{ kind: 'hud', actor: ref(paid), action: { kind: 'equip', utility: 'sprint' } }])
  assert.equal(buyer(swapped.state).utilityUntil, 19)
  assert.equal(buyer(swapped.state).progression.utility, 'sprint')
})
test('Echo uses the native Hook deadline and failed activation restores utility cooldown only', () => {
  const state = boot()
  buyer(state).progression.owned = ['echo']
  buyer(state).progression.utility = 'echo'
  const result = step(state, frame(3), [{ kind: 'tool', actor: ref(state), tool: 'utility', menuAtPress: 'closed', launch: undefined }])
  const command = result.commands.find(c => c.kind === 'echo')
  assert.ok(command && command.kind === 'echo')
  assert.equal(buyer(result.state).utilityUntil, 23)
  const failed = acknowledge(result.state, [{ ...command, kind: 'failed', tool: 'echo' }])
  assert.equal(buyer(failed).utilityUntil, 0)
  assert.equal('hookUntil' in buyer(failed), false)
  const ready = step(state, frame(21), [{ kind: 'tool', actor: ref(state), tool: 'utility', menuAtPress: 'closed', launch: undefined }])
  assert.equal(ready.commands.some(c => c.kind === 'echo'), false)
})
test('live shop spending requires own shop and returned Hook; overtime closes purchases', () => {
  const state = boot()
  const away = sample(600)
  assert.ok(away.body?.hook)
  const awayFrame: Frame = { ...frame(3), players: [{ ...away, body: { ...away.body, position: { x: 704, y: 240, z: 104 } } }] }
  assert.equal(step(state, awayFrame, [buy(state, 'sprint')]).commands.some(c => c.kind === 'buy'), false)
  const busy: Frame = { ...frame(3), players: [{ ...away, body: { ...away.body, hook: { ...away.body.hook, casting: true } } }] }
  assert.equal(step(state, busy, [buy(state, 'sprint')]).commands.some(c => c.kind === 'buy'), false)
  state.phase = { kind: 'overtime' }
  assert.equal(step(state, frame(3, 600), [buy(state, 'sprint')]).commands.some(c => c.kind === 'buy'), false)
})

test('each section equips its newest purchase and keeps the others owned for a later equip', () => {
  let state = boot()
  for (const product of ['knockdown', 'etherealShift', 'piano'] as const) {
    state = step(state, frame(3, 900), [buy(state, product)]).state
    state = settle(state, [receipt(state, 'bought')])
  }
  const progression = buyer(state).progression
  assert.deepEqual([progression.setup, progression.utility, progression.defense], ['piano', null, 'etherealShift'])
  assert.deepEqual(progression.owned, ['knockdown', 'etherealShift', 'piano'])
  const back = step(state, frame(4, 0), [{ kind: 'hud', actor: ref(state), action: { kind: 'equip', utility: 'knockdown' } }]).state
  assert.equal(buyer(back).progression.setup, 'knockdown')
  assert.equal(buyer(back).progression.defense, 'etherealShift')
})
test('an item that needs a teammate is not sold in 1v1', () => {
  const state = boot()
  const result = step(state, frame(3, 900), [buy(state, 'rescueBeam')])
  assert.equal(result.commands.some(c => c.kind === 'buy'), false)
  assert.equal(buyer(result.state).progression.purchase, null)
})
test('a native item starts its own slot cooldown on the press and gets it back when the game never casts it', () => {
  const state = boot()
  buyer(state).progression.owned = ['sprint', 'etherealShift']
  buyer(state).progression.utility = 'sprint'; buyer(state).progression.defense = 'etherealShift'
  const press: Request = { kind: 'tool', actor: ref(state), tool: 'defense', menuAtPress: 'closed', launch: undefined }
  const result = step(state, frame(3), [press])
  const casts = result.commands.filter(c => c.kind === 'cast')
  assert.deepEqual(casts.map(c => c.kind === 'cast' && c.product), ['etherealShift'])
  const after = buyer(result.state)
  assert.deepEqual([after.utilityUntil, after.defenseUntil], [0, 3 + catalog.etherealShift.cooldown])
  assert.equal(step(result.state, frame(4), [press]).commands.some(c => c.kind === 'cast'), false)
  const cast = casts[0]
  assert.ok(cast && cast.kind === 'cast')
  const missed = acknowledge(result.state, [{ kind: 'failed', tool: 'etherealShift', actor: cast.actor, previousDeadline: cast.previousDeadline, attemptedAt: cast.attemptedAt }])
  assert.equal(buyer(missed).defenseUntil, 0)
})
test('Shrink Ray is the mode\'s own effect: it starts the utility cooldown, and gives it back if the game refuses the shrink', () => {
  const state = boot()
  buyer(state).progression.owned = ['shrinkRay']; buyer(state).progression.utility = 'shrinkRay'
  const result = step(state, frame(3), [{ kind: 'tool', actor: ref(state), tool: 'utility', menuAtPress: 'closed', launch: undefined }])
  const shrink = result.commands.find(c => c.kind === 'shrink')
  assert.ok(shrink && shrink.kind === 'shrink')
  assert.equal(result.commands.some(c => c.kind === 'cast'), false)
  assert.equal(buyer(result.state).utilityUntil, 3 + catalog.shrinkRay.cooldown)
  const refused = acknowledge(result.state, [{ kind: 'failed', tool: 'shrinkRay', actor: shrink.actor, previousDeadline: shrink.previousDeadline, attemptedAt: shrink.attemptedAt }])
  assert.equal(buyer(refused).utilityUntil, 0)
})
