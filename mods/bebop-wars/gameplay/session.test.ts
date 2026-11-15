import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { isProductId, isUtility } from './catalog.ts'

const source = stripTypeScriptTypes(readFileSync(new URL('./session.ts', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export function startGame', 'function startGame'))

function fixture() {
  const messages: string[] = [], forwarded: string[] = [], requests: unknown[] = []
  const player = { slot: 3, chat: (message: string) => { messages.push(message); return true } }
  type Handler = (sender: typeof player, args: string) => void
  const handlers = new Map<string, Handler>()
  class Game {
    state = { config: { practice: false }, fighters: new Map([
      ['human', { id: 'human', presence: { kind: 'connected', slot: 3 } }],
    ]) }
    start() {}
    request(id: string, action: unknown) { requests.push({ id, action }) }
  }
  runInNewContext(source + '\nstartGame([])', {
    Game, isProductId, isUtility,
    command: (name: string, handler: Handler) => handlers.set(name, handler),
    onWorld() {}, onInput() {}, onDamage() {}, onDamaged() {}, onAbilityCast() {}, onFrame() {},
  })
  return { messages, forwarded, requests,
    dispatch(name: string, args: string) {
      const handler = handlers.get(name)
      if (handler) handler(player, args)
      else forwarded.push(name + ' ' + args)
    },
  }
}

test('native inventory transactions are claimed without changing progression or forwarding to the engine', () => {
  const f = fixture()
  for (const name of ['sellitem', 'buyitem', 'buyactiveitem', 'buydependentitem', 'purchase']) {
    f.dispatch(name, 'upgrade_cold_front 1 1')
  }
  assert.deepEqual(f.forwarded, [])
  assert.deepEqual(f.requests, [])
  assert.equal(f.messages.length, 5)
  assert.match(f.messages[0] ?? '', /cannot be sold/)
  assert.ok(f.messages.slice(1).every(message => message.includes('Bebop Wars shop')))
})

test('mode shop commands still route valid products to the connected player', () => {
  const f = fixture()
  f.dispatch('bebop_buy', 'snowGlobe')
  f.dispatch('bebop_equip', 'echo')
  f.dispatch('bebop_buy', 'upgrade_cold_front')
  f.dispatch('bebop_equip', 'snowGlobe')
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    { id: 'human', action: { kind: 'buy', product: 'snowGlobe' } },
    { id: 'human', action: { kind: 'equip', utility: 'echo' } },
    { id: 'human', action: { kind: 'equip', utility: 'snowGlobe' } },
  ])
  assert.deepEqual(f.forwarded, [])
})

test('native Hook upgrades remain handled by the engine', () => {
  const f = fixture()
  f.dispatch('buyabilityupgrade', 'citadel_ability_hook')
  assert.deepEqual(f.forwarded, ['buyabilityupgrade citadel_ability_hook'])
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.messages, [])
})
