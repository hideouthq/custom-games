import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { freeSeat } from './model.ts'

const source = stripTypeScriptTypes(readFileSync(new URL('./practice.ts', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export class Practice', 'class Practice'))

function fixture(side = 3) {
  const moves: { facing: { yaw: number }; forward: number }[] = []
  const bot = { slot: 7, drive: (move: { facing: { yaw: number }; forward: number }) => moves.push(move),
    teleport: () => assert.fail('Practice must preserve the normal shop deployment'), removeBot: () => {} }
  const fighter = { id: 'bot', membership: { kind: 'seated', side }, serial: 1, ready: true,
    life: { kind: 'alive', bank: side, position: { x: 0, y: side === 3 ? 984 : -984, z: 104 }, protectionUntil: 2, transit: { kind: 'none' } },
    menu: 'closed', chillUntil: 0 }
  const connections = [{ bot: true, name: 'Practice Bebop', generation: 1, player: bot }]
  const game = { failure: '', frame: { now: 1, players: [{ bot: true, slot: 7, generation: 1, id: 'bot' }] },
    state: { config: { teamSize: 1 }, round: 0, phase: { kind: 'warmup' }, fighters: new Map([['bot', fighter]]) }, request: () => {} }
  const practice = runInNewContext(source + '\nnew Practice()', { addBot: () => bot, players: () => connections, freeSeat, log: () => {}, direction: (team: number) => team === 3 ? 1 : -1 })
  practice.tick(game)
  return { tick: () => practice.tick(game), reset: () => practice.reset(), game, fighter, moves, connections, bot }
}

test('practice waits at the shop through protection, then walks out without teleporting', () => {
  for (const side of [2, 3]) {
    const { tick, game, fighter, moves } = fixture(side)
    tick()
    assert.equal(moves.at(-1)?.forward, 0)
    assert.equal(Math.abs(fighter.life.position.y), 984)
    game.frame.now = 2
    tick()
    assert.equal(moves.at(-1)?.forward, 1)
    assert.equal(moves.at(-1)?.facing.yaw, side === 3 ? -90 : 90)
  }
})

test('practice follows the lower walk to its firing bay and restarts at the shop after death', () => {
  const { tick, game, fighter, moves } = fixture()
  game.frame.now = 3
  fighter.life.position = { x: 0, y: 360, z: 0 }
  tick()
  assert.equal(moves.at(-1)?.facing.yaw, 0)
  fighter.life.position = { x: 704, y: 360, z: 0 }
  tick()
  assert.equal(moves.at(-1)?.facing.yaw, -90)
  fighter.life.position = { x: 704, y: 256, z: 0 }
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
  fighter.life.kind = 'dead'
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
  fighter.serial++
  fighter.life.kind = 'alive'
  fighter.life.position = { x: 0, y: 984, z: 104 }
  fighter.life.protectionUntil = 5
  game.frame.now = 4
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
  game.frame.now = 5
  tick()
  assert.equal(moves.at(-1)?.forward, 1)
  assert.equal(moves.at(-1)?.facing.yaw, -90)
})

test('practice stops steering while a pull or match phase controls the bot', () => {
  const { tick, game, fighter, moves } = fixture()
  game.frame.now = 3
  for (const phase of ['countdown', 'results']) {
    game.state.phase.kind = phase
    tick()
    assert.equal(moves.at(-1)?.forward, 0)
  }
  game.state.phase.kind = 'live'
  fighter.life.transit.kind = 'pull'
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
  fighter.life.transit.kind = 'none'
  fighter.menu = 'loadout'
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
})


test('a stranded practice bot stays on the bank it was pulled onto', () => {
  const { tick, game, fighter, moves } = fixture()
  game.frame.now = 3
  fighter.life.bank = 2
  fighter.life.position = { x: 704, y: -256, z: 0 }
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
})


test('a replacement bot in the same slot gets fresh route state and current controls', () => {
  const { tick, game, fighter, moves, connections, bot } = fixture()
  game.frame.now = 3
  fighter.life.position = { x: 0, y: 360, z: 0 }
  tick()
  fighter.life.position = { x: 704, y: 360, z: 0 }
  tick()
  fighter.life.position = { x: 704, y: 256, z: 0 }
  tick()
  assert.equal(moves.at(-1)?.forward, 0)
  const replacementMoves: { facing: { yaw: number }; forward: number }[] = []
  connections[0] = { bot: true, name: 'Practice Bebop', generation: 2, player: { ...bot, drive: move => replacementMoves.push(move) } }
  game.frame.players[0] = { bot: true, slot: 7, generation: 2, id: 'replacement' }
  fighter.id = 'replacement'
  fighter.life.position = { x: 0, y: 984, z: 104 }
  game.state.fighters.clear()
  game.state.fighters.set('replacement', fighter)
  const oldCommands = moves.length
  tick()
  assert.equal(moves.length, oldCommands)
  assert.equal(replacementMoves.at(-1)?.forward, 1)
  assert.equal(replacementMoves.at(-1)?.facing.yaw, -90)
})

test('reset never removes a different generation that reused the practice slot', () => {
  const { reset, connections, bot } = fixture()
  let removed = false
  connections[0] = { bot: true, name: 'Other bot', generation: 2, player: { ...bot, removeBot: () => { removed = true } } }
  reset()
  assert.equal(removed, false)
})
