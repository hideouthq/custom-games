import assert from 'node:assert/strict'
import test from 'node:test'
import { accountId, configuration, initial, step, type Frame } from './model.ts'
import { present } from './presentation.ts'

function match() {
  const id = accountId('hud-human')
  const frame: Frame = {
    now: 10,
    players: [{ id, slot: 4, generation: 1, name: 'Human', bot: false, body: {
      entity: 100, side: 3, alive: true, nativeItems: [], health: 650, maxHealth: 650, souls: 300, abilityPoints: 0, hookRank: 0,
      position: { x: 0, y: 984, z: 104 }, velocity: { x: 0, y: 0, z: 0 },
      hook: { entity: 200, casting: false, victim: undefined, startedAt: 0, cooldownEnd: 0, executed: false },
    } }],
    globes: new Map(), pulls: new Map(), deaths: [],
  }
  const state = step(initial(configuration(['teams=1v1'])), frame).state
  const fighter = state.fighters.get(id)
  if (!fighter) throw new Error('Expected HUD player')
  state.phase = { kind: 'live', until: 490 }
  return { id, frame, state, fighter }
}

test('shop uses the observed native wallet and lists every item in section order', () => {
  const { state, frame, fighter } = match()
  const view = present(state, fighter, frame)
  assert.equal(view.wallet, 300)
  assert.deepEqual(view.shop.products.map(product => product.id), ['snowGlobe', 'knockdown', 'piano', 'sprint', 'echo', 'shrinkRay', 'etherealShift', 'rescueBeam'])
  assert.deepEqual(view.shop.products.map(product => product.group), ['setup', 'setup', 'setup', 'utility', 'utility', 'utility', 'defense', 'defense'])
  assert.equal(view.shop.products.find(product => product.id === 'echo')?.label, 'Need 300 more')
})

test('dead players retain the respawn deadline and see next-spawn purchases', () => {
  const { state, frame, fighter } = match()
  fighter.life = { kind: 'dead', respawnAt: 14, confirmed: true }
  fighter.progression.owned = ['snowGlobe', 'echo']
  fighter.progression.utility = 'echo'
  const view = present(state, fighter, frame)
  assert.equal(view.notice, 'Respawning in 4')
  assert.equal(view.respawn, 4)
  assert.equal(view.shop.products.find(item => item.id === 'echo')?.label, 'Equipped next spawn')
})

test('field browsing explains shop eligibility without offering a purchase', () => {
  const { state, frame, fighter } = match()
  if (fighter.life.kind !== 'alive') throw new Error('Expected alive player')
  fighter.life.position = { x: 0, y: 200, z: 104 }
  const view = present(state, fighter, frame)
  assert.equal(view.canShop, true)
  assert.equal(view.shop.allowed, false)
  assert.ok(view.shop.products.every(product => product.action === null))
})

test('native Hook metadata follows observed rank and actual local slot', () => {
  const { state, frame, fighter } = match()
  const player = frame.players[0]
  if (!player?.body) throw new Error('Expected body')
  const upgraded: Frame = { ...frame, players: [{ ...player, body: { ...player.body, hookRank: 2 } }] }
  assert.deepEqual(present(state, fighter, upgraded).native, { items: [], generation: 1, slot: 4, hookRank: 2, range: 36, cooldown: 4 })
})

test('native inventory metadata preserves the real item slot', () => {
  const { state, frame, fighter } = match()
  const player = frame.players[0]
  if (!player?.body) throw new Error('Expected body')
  const equipped: Frame = { ...frame, players: [{ ...player, body: { ...player.body, nativeItems: [{ product: 'snowGlobe', slot: 6 }] } }] }
  assert.deepEqual(present(state, fighter, equipped).native.items, [{ product: 'snowGlobe', slot: 6 }])
})
