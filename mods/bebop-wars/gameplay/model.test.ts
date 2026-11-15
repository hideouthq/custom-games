import assert from 'node:assert/strict'
import test from 'node:test'
import { bankEdge, contain, direction, onBank, spawn } from './arena.ts'
import { catalog } from './catalog.ts'
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint.ts'
import { flattened, pianoMark, pianoRules } from './piano.ts'
import { inSights, knockdownRules } from './sight.ts'
import { accountId, actor, canAct, configuration, freeSeat, initial, step, type AccountId, type Actor, type BodySample, type Frame, type Observation, type Request, type State } from './model.ts'

const blue = accountId('blue'), amber = accountId('amber'), blue2 = accountId('blue2'), amber2 = accountId('amber2')
function player(id: AccountId, slot: number, side: 2 | 3): Observation {
  return { id, slot, generation: 1, name: id, bot: false, body: { entity: slot + 100, alive: true, side, health: 1000, maxHealth: 1000, souls: 300, abilityPoints: 0, hookRank: 0, nativeItems: [], position: { x: 704, y: direction(side) * 984, z: 104 }, velocity: { x: 0, y: 0, z: 0 }, hook: { entity: slot + 500, casting: false, victim: undefined, startedAt: 0, cooldownEnd: 0, executed: false } } }
}
function body(sample: Observation, patch: Partial<BodySample>): Observation { assert.ok(sample.body); return { ...sample, body: { ...sample.body, ...patch } } }
function position(sample: Observation, y: number): Observation { return body(sample, { position: { x: 704, y, z: 104 } }) }
function holding(sample: Observation, victim: AccountId | undefined): Observation { assert.ok(sample.body?.hook); return body(sample, { hook: { ...sample.body.hook, victim, casting: victim !== undefined } }) }
function frame(now: number, players: readonly Observation[], deaths: Frame['deaths'] = []): Frame {
  const pulls: Map<AccountId, { kind: 'held'; owner: AccountId } | { kind: 'ambiguous' }> = new Map()
  for (const sample of players) {
    const victim = sample.body?.hook?.victim
    if (victim) pulls.set(victim, pulls.has(victim) ? { kind: 'ambiguous' } : { kind: 'held', owner: sample.id })
  }
  return { now, players, deaths, pulls, globes: new Map() }
}
function fighter(state: State, id: AccountId) { const result = state.fighters.get(id); assert.ok(result); return result }
function ref(state: State, id: AccountId): Actor { const result = actor(fighter(state, id)); assert.ok(result); return result }
function boot(teamSize: 1 | 2 | 3 = 1) {
  const players = [player(blue, 0, 3), player(amber, 1, 2)]
  if (teamSize >= 2) players.push(player(blue2, 2, 3), player(amber2, 3, 2))
  if (teamSize === 3) players.push(player(accountId('blue3'), 4, 3), player(accountId('amber3'), 5, 2))
  let state = step(initial(configuration([`teams=${teamSize}v${teamSize}`])), frame(1, players)).state
  const ready: Request[] = players.map(p => ({ actor: ref(state, p.id), kind: 'hud', action: { kind: 'ready' } }))
  state = step(state, frame(2, players), ready).state
  assert.equal(state.phase.kind, 'countdown')
  state = step(state, frame(7, players)).state
  assert.equal(state.phase.kind, 'live')
  return { state, players, b: players[0]!, a: players[1]! }
}
function arriveEnemy() {
  let { state, b, a } = boot()
  state = step(state, frame(9, [holding(position(b, 240), amber), position(a, -240)])).state
  state = step(state, frame(10, [holding(position(b, 240), amber), position(a, 220)])).state
  return { ...step(state, frame(11, [position(b, 240), position(a, 220)])), b, a }
}

test('all three team sizes reach live with equal seating', () => {
  for (const size of [1, 2, 3] satisfies (1 | 2 | 3)[]) {
    const { state } = boot(size)
    for (const side of [2, 3]) assert.equal([...state.fighters.values()].filter(p => p.membership.kind === 'seated' && p.membership.side === side).length, size)
  }
})
test('authored banks include bays and exclude the central canal', () => {
  assert.equal(bankEdge(704), 208)
  assert.equal(bankEdge(1058), 218)
  assert.equal(onBank({ x: 0, y: 250, z: 100 }, 3), false)
  assert.equal(onBank({ x: 704, y: 250, z: 100 }, 3), true)
  assert.ok(spawn(3, 0).y > 0)
  assert.ok(spawn(2, 0).y < 0)
})
test('a completed enemy pull changes occupied bank without killing or scoring', () => {
  const { state, commands } = arriveEnemy()
  const stranded = fighter(state, amber)
  assert.equal(stranded.life.kind, 'alive')
  assert.ok(stranded.life.kind === 'alive')
  assert.equal(stranded.life.bank, 3)
  assert.equal(stranded.life.transit.kind, 'none')
  assert.equal(canAct(state, stranded), true)
  assert.deepEqual(state.score, { 2: 0, 3: 0 })
  assert.equal(commands.length, 0)
})
test('jumping home from the enemy bank recovers to the enemy bank', () => {
  const { state, b, a } = arriveEnemy()
  const result = step(state, frame(12, [b, position(a, -240)]))
  const move = result.commands.find(c => c.kind === 'move' && c.actor.id === amber)
  assert.ok(move && move.kind === 'move')
  assert.equal(move.position.y, 220)
  assert.equal(result.state.score[3], 0)
})
test('a normal canal jump recovers without a death or score', () => {
  const { state, b, a } = boot()
  const result = step(state, frame(9, [position(b, 0), a]))
  assert.ok(result.commands.some(c => c.kind === 'move' && c.actor.id === blue))
  assert.equal(fighter(result.state, blue).life.kind, 'alive')
  assert.deepEqual(result.state.score, { 2: 0, 3: 0 })
})
test('stepping past the bank edge in the air slides along it and keeps falling', () => {
  const { state, b, a } = boot()
  const airborne = body(b, { position: { x: 704, y: 196, z: 150 }, velocity: { x: 50, y: -300, z: -120 } })
  const result = step(state, frame(9, [airborne, a]))
  const move = result.commands.find(c => c.kind === 'move' && c.actor.id === blue)
  assert.ok(move && move.kind === 'move')
  assert.deepEqual(move.position, { x: 704, y: 208, z: 150 })
  assert.deepEqual(move.velocity, { x: 50, y: 0, z: -120 })
  const held = step(result.state, frame(10, [body(b, { position: { x: 710, y: 203, z: 138 }, velocity: { x: 50, y: -40, z: -200 } }), a]))
  const next = held.commands.find(c => c.kind === 'move' && c.actor.id === blue)
  assert.ok(next && next.kind === 'move')
  assert.equal(next.position.z, 138)
  assert.equal(next.velocity.z, -200)
})
test('containment never fights the side clips and gives up below the canal floor', () => {
  assert.equal(onBank({ x: 1170, y: 600, z: 100 }, 3), true)
  assert.deepEqual(contain({ x: 0, y: -300, z: 40 }, 2), { x: 0, y: -320, z: 40 })
  assert.deepEqual(contain({ x: 0, y: 1300, z: 40 }, 3), { x: 0, y: 1257.6, z: 40 })
  assert.equal(contain({ x: 0, y: 0, z: -128 }, 3), undefined)
})
test('an allied pull returns a stranded player home and counts one save', () => {
  let { state, players, b, a } = boot(2)
  const ally = players[3]!
  state = step(state, frame(9, [holding(b, amber), a, players[2]!, ally])).state
  state = step(state, frame(10, [b, position(a, 230), players[2]!, ally])).state
  state = step(state, frame(11, [b, position(a, 0), players[2]!, holding(ally, amber)])).state
  const result = step(state, frame(12, [b, position(a, -230), players[2]!, ally]))
  const victim = fighter(result.state, amber)
  assert.ok(victim.life.kind === 'alive')
  assert.equal(victim.life.bank, 2)
  assert.equal(fighter(result.state, amber2).saves, 1)
  assert.ok(result.commands.some(c => c.kind === 'saved'))
  const repeat = step(result.state, frame(13, [b, position(a, -230), players[2]!, ally])).state
  assert.equal(fighter(repeat, amber2).saves, 1)
})
test('ordinary allied pulls do not earn save statistics', () => {
  let { state, players } = boot(2)
  const ally = players[2]!, victim = players[0]!
  state = step(state, frame(9, [victim, players[1]!, holding(ally, blue), players[3]!])).state
  state = step(state, frame(10, players)).state
  assert.equal(fighter(state, blue2).saves, 0)
})
test('ambiguous ownership cannot authorize crossing', () => {
  const { state, b, a } = boot()
  const ambiguous = frame(9, [b, position(a, 0)])
  const held = step(state, { ...ambiguous, pulls: new Map([[amber, { kind: 'ambiguous' }]]) }).state
  const result = step(held, frame(10, [b, position(a, 220)]))
  const victim = fighter(result.state, amber)
  assert.ok(victim.life.kind === 'alive')
  assert.equal(victim.life.bank, 2)
  assert.ok(result.commands.some(c => c.kind === 'move'))
})
test('caster death interrupts crossing and restores the occupied bank', () => {
  let { state, b, a } = boot()
  state = step(state, frame(9, [holding(b, amber), position(a, 0)])).state
  const result = step(state, frame(10, [body(b, { alive: false }), position(a, 220)]))
  assert.ok(result.commands.some(c => c.kind === 'move' && c.actor.id === amber))
  const victim = fighter(result.state, amber)
  assert.ok(victim.life.kind === 'alive')
  assert.equal(victim.life.bank, 2)
})
test('native lethal events award exactly one kill per victim life', () => {
  const { state, b, a } = boot()
  const death = { victim: ref(state, amber), attacker: ref(state, blue) }
  const result = step(state, frame(9, [b, body(a, { alive: false, health: 0 })], [death, death]))
  assert.equal(result.state.score[3], 1)
  assert.equal(fighter(result.state, blue).kills, 1)
  const repeat = step(result.state, frame(10, [b, body(a, { alive: false, health: 0 })], [death]))
  assert.equal(repeat.state.score[3], 1)
  assert.deepEqual(state.score, { 2: 0, 3: 0 })
})
test('simultaneous kills commit together before deciding the winner', () => {
  const { state, b, a } = boot()
  state.score = { 2: 24, 3: 24 }
  const deaths = [{ victim: ref(state, amber), attacker: ref(state, blue) }, { victim: ref(state, blue), attacker: ref(state, amber) }]
  for (const events of [deaths, deaths.toReversed()]) {
    const result = step(state, frame(9, [body(b, { alive: false }), body(a, { alive: false })], events))
    assert.deepEqual(result.state.score, { 2: 25, 3: 25 })
    assert.equal(result.state.phase.kind, 'overtime')
  }
})
test('unattributed and friendly deaths respawn without awarding points', () => {
  const { state, players } = boot(2)
  const result = step(state, frame(9, players.map(p => p.id === blue ? body(p, { alive: false }) : p), [{ victim: ref(state, blue), attacker: ref(state, blue2) }]))
  assert.deepEqual(result.state.score, { 2: 0, 3: 0 })
  const natural = step(state, frame(9, players.map(p => p.id === blue ? body(p, { alive: false }) : p)))
  assert.equal(fighter(natural.state, blue).life.kind, 'dead')
  assert.deepEqual(natural.state.score, { 2: 0, 3: 0 })
})
test('respawn waits four seconds, closes shop and returns to team spawn', () => {
  let { state, b, a } = boot()
  const oldLife = ref(state, amber)
  fighter(state, amber).progression.owned = ['sprint']
  fighter(state, amber).utilityUntil = 40
  const dead = body(a, { alive: false })
  state = step(state, frame(9, [b, dead], [{ victim: oldLife, attacker: ref(state, blue) }])).state
  const early = step(state, frame(12.99, [b, dead]))
  assert.equal(early.commands.some(c => c.kind === 'respawn'), false)
  const due = step(early.state, frame(13, [b, dead]))
  assert.ok(due.commands.some(c => c.kind === 'respawn' && c.actor.id === amber))
  fighter(due.state, amber).menu = 'loadout'
  const result = step(due.state, frame(13.1, [b, position(a, 230)]))
  const next = fighter(result.state, amber)
  assert.ok(next.life.kind === 'alive')
  assert.equal(next.life.bank, 2)
  assert.equal(next.menu, 'closed')
  assert.equal(next.utilityUntil, 40)
  assert.deepEqual(next.progression.owned, ['sprint'])
  assert.ok(next.serial > oldLife.life)
  assert.ok(result.commands.some(c => c.kind === 'deploy' && c.actor.id === amber && c.position.y < 0))
  const stale = step(result.state, frame(14, [b, a], [{ victim: oldLife, attacker: ref(result.state, blue) }]))
  assert.equal(stale.state.score[3], 1)
})
test('reconnect preserves kills and ownership without starting grant', () => {
  let { state, b, a } = boot()
  fighter(state, blue).kills = 5
  fighter(state, blue).progression.owned = ['snowGlobe']
  state = step(state, frame(9, [a])).state
  const result = step(state, frame(10, [{ ...b, generation: 2 }, a]))
  assert.equal(fighter(result.state, blue).kills, 5)
  assert.deepEqual(fighter(result.state, blue).progression.owned, ['snowGlobe'])
  assert.equal(result.commands.some(c => c.kind === 'reset'), false)
})
test('new match clears progression and emits one native reset per player', () => {
  const { state, players } = boot()
  fighter(state, blue).kills = 5
  fighter(state, blue).progression.owned = ['snowGlobe']
  state.phase = { kind: 'results', until: 10, winner: 3, reason: 'Kill victory' }
  const result = step(state, frame(10, players))
  assert.equal(result.state.phase.kind, 'warmup')
  assert.equal(result.state.round, state.round + 1)
  assert.deepEqual(fighter(result.state, blue).progression.owned, [])
  assert.equal(fighter(result.state, blue).kills, 0)
  assert.equal(result.commands.filter(c => c.kind === 'reset').length, 2)
  assert.equal(step(result.state, frame(11, players)).commands.some(c => c.kind === 'reset'), false)
})
test('time limit uses completed enemy deaths in the current frame', () => {
  const { state, b, a } = boot()
  state.phase = { kind: 'live', until: 10 }
  const result = step(state, frame(10, [b, body(a, { alive: false })], [{ victim: ref(state, amber), attacker: ref(state, blue) }]))
  assert.equal(result.state.phase.kind, 'results')
  assert.ok(result.state.phase.kind === 'results')
  assert.equal(result.state.phase.winner, 3)
})
test('Snow Globe can detonate manually while its launch cooldown runs', () => {
  const { state, b, a } = boot()
  fighter(state, blue).progression.owned = ['snowGlobe']
  fighter(state, blue).progression.setup = 'snowGlobe'
  const press: Request = { kind: 'tool', actor: ref(state, blue), tool: 'setup', menuAtPress: 'closed', launch: { position: { x: 704, y: 200, z: 144 }, direction: { x: 0, y: -1, z: 0 } } }
  const launched = step(state, frame(9, [b, a]), [press])
  const globe = launched.state.globes[0]
  assert.ok(globe)
  const sample = { ...globe, position: { x: 704, y: -240, z: 144 }, ended: false, clear: [amber], updatedAt: 9.1 }
  const result = step(launched.state, { ...frame(9.1, [b, position(a, -240)]), globes: new Map([[globe.id, sample]]) }, [{ ...press, launch: undefined }])
  assert.equal(result.state.globes.length, 0)
  assert.ok(result.commands.some(c => c.kind === 'impact'))
  assert.ok(result.commands.some(c => c.kind === 'chill' && c.actor.id === amber))
  assert.equal(fighter(result.state, blue).setupUntil, 25)
})


test('a practice bot joins the open native team when the human arrives first', () => {
  const human = player(blue, 0, 3)
  const state = step(initial(configuration(['teams=1v1', 'practice'])), frame(1, [human])).state
  const seat = freeSeat(state)
  assert.deepEqual(seat, { kind: 'seated', side: 2, seat: 0 })
  assert.ok(seat.kind === 'seated')
  const bot = { ...player(amber, 1, seat.side), bot: true }
  const joined = step(state, frame(2, [human, bot]))
  assert.deepEqual(fighter(joined.state, amber).membership, seat)
  assert.equal(joined.commands.some(command => command.kind === 'seat' && command.actor.id === amber), false)
})

test('human reconnect uses the new slot generation without reseating the retained practice bot', () => {
  const human = player(blue, 0, 3), bot = { ...player(amber, 1, 2), bot: true }
  let state = step(initial(configuration(['teams=1v1', 'practice'])), frame(1, [human, bot])).state
  state = step(state, frame(2, [bot])).state
  const reconnect = { ...human, generation: 2, body: undefined }
  const waiting = step(state, frame(3, [reconnect, bot]))
  const seats = waiting.commands.filter(command => command.kind === 'seat')
  assert.equal(seats.length, 1)
  assert.ok(seats[0]?.kind === 'seat')
  assert.deepEqual(seats[0].actor, { id: blue, generation: 2, life: 1 })
  assert.equal(seats[0].side, 3)
  const alive = step(waiting.state, frame(4, [{ ...human, generation: 2 }, bot])).state
  assert.equal(fighter(alive, blue).life.kind, 'alive')
  assert.equal(fighter(alive, amber).life.kind, 'alive')
})

test('a bot missing after reload releases its seat while an absent human keeps their reconnect reservation', () => {
  const botId = accountId('bot:1:1'), replacementId = accountId('bot:1:2')
  const human = player(blue, 0, 3), bot = { ...player(botId, 1, 2), bot: true }
  const config = configuration(['teams=1v1', 'practice'])
  let state = step(initial(config), frame(1, [human, bot])).state
  const restored = decodeCheckpoint(encodeCheckpoint(state), config)
  assert.ok(restored)
  state = restored
  state = step(state, frame(2, [])).state
  assert.equal(state.fighters.has(botId), false)
  assert.equal(fighter(state, blue).presence.kind, 'away')
  assert.deepEqual(freeSeat(state), { kind: 'seated', side: 2, seat: 0 })
  const replacement = { ...player(replacementId, 1, 2), generation: 2, bot: true }
  state = step(state, frame(3, [replacement])).state
  assert.deepEqual(fighter(state, replacementId).membership, { kind: 'seated', side: 2, seat: 0 })
  assert.deepEqual(fighter(state, blue).membership, { kind: 'seated', side: 3, seat: 0 })
})

test('native death rewards pay one hundred to the killer and fifty to teammates exactly once', () => {
  const { state, players } = boot(2)
  const death = { victim: ref(state, amber), attacker: ref(state, blue) }
  const observations = players.map(p => p.id === amber ? body(p, { alive: false, health: 0 }) : p)
  const first = step(state, frame(9, observations, [death, death]))
  assert.equal(fighter(first.state, blue).income.pending, 100)
  assert.equal(fighter(first.state, blue2).income.pending, 50)
  assert.equal(fighter(first.state, amber).income.pending, 0)
  const repeated = step(first.state, frame(9.1, observations, [death]))
  assert.equal(fighter(repeated.state, blue).income.pending, 100)
  assert.equal(fighter(repeated.state, blue2).income.pending, 50)
})

test('simultaneous comeback kills use the same pre-batch deficit regardless of callback order', () => {
  const { state, players } = boot(2)
  state.score[2] = 4
  for (const p of state.fighters.values()) p.income.teamKills = p.membership.kind === 'seated' ? state.score[p.membership.side] : 0
  const deaths = [{ victim: ref(state, amber), attacker: ref(state, blue) }, { victim: ref(state, amber2), attacker: ref(state, blue2) }]
  const observations = players.map(p => p.id === amber || p.id === amber2 ? body(p, { alive: false }) : p)
  for (const events of [deaths, deaths.toReversed()]) {
    const result = step(state, frame(9, observations, events)).state
    assert.equal(fighter(result, blue).income.pending, 225)
    assert.equal(fighter(result, blue2).income.pending, 225)
    assert.equal(result.score[3], 2)
  }
})

test('passive Souls count only elapsed live time, including deaths, and stop at overtime', () => {
  let { state, players } = boot()
  const dead = players.map(p => p.id === blue ? body(p, { alive: false }) : p)
  state = step(state, frame(16, dead)).state
  assert.equal(fighter(state, blue).income.pending, 0)
  state = step(state, frame(17, dead)).state
  assert.equal(fighter(state, blue).income.pending, 25)
  state = step(state, frame(17, dead)).state
  assert.equal(fighter(state, blue).income.pending, 25)
  state = step(state, frame(42, dead)).state
  assert.equal(fighter(state, blue).income.pending, 75)
  state.phase = { kind: 'live', until: 47 }
  state = step(state, frame(47, dead)).state
  assert.equal(state.phase.kind, 'overtime')
  assert.equal(fighter(state, blue).income.pending, 100)
  state = step(state, frame(60, dead)).state
  assert.equal(fighter(state, blue).income.pending, 100)
  const warmup = step(initial(configuration(['teams=1v1'])), frame(1, players)).state
  assert.equal(fighter(step(warmup, frame(100, players)).state, blue).income.pending, 0)
})

test('late joining catches up ordinary team and passive income without paying twice on reconnect', () => {
  const human = player(blue, 0, 3), enemy = player(amber, 1, 2)
  let state = step(initial(configuration(['teams=2v2'])), frame(1, [human, enemy])).state
  state.phase = { kind: 'live', until: 481 }; state.liveSeconds = 120; state.now = 121
  state.score[2] = 6; state.score[3] = 6
  const joiner = player(blue2, 2, 3)
  state = step(state, frame(121, [human, enemy, joiner])).state
  assert.equal(fighter(state, blue2).income.pending, 600)
  fighter(state, blue2).income.pending = 0
  state = step(state, frame(125, [human, enemy])).state
  state = step(state, frame(131, [human, enemy, { ...joiner, generation: 2 }])).state
  assert.equal(fighter(state, blue2).income.pending, 25)
  assert.equal(fighter(state, blue2).progression.owned.length, 0)
})

test('rescue income consumes enemy Hook episodes once and caps three payments per rolling minute', () => {
  let { state, players } = boot(2)
  function rescue(at: number, cast: number): void {
    const enemy = players[0]!, victim = players[1]!, ally = players[3]!
    assert.ok(enemy.body?.hook)
    const caught = body(holding(enemy, amber), { hook: { ...enemy.body.hook, victim: amber, casting: true, startedAt: cast } })
    state = step(state, frame(at, [caught, position(victim, -240), players[2]!, ally])).state
    state = step(state, frame(at + 0.1, [enemy, position(victim, 240), players[2]!, ally])).state
    state = step(state, frame(at + 0.2, [enemy, position(victim, 240), players[2]!, holding(ally, amber)])).state
    state = step(state, frame(at + 0.3, [enemy, position(victim, -240), players[2]!, ally])).state
  }
  rescue(9, 9)
  rescue(10, 9)
  assert.equal(fighter(state, amber2).saves, 1)
  assert.equal(fighter(state, amber2).income.pending, 25)
  rescue(11, 11); rescue(12, 12); rescue(13, 13)
  assert.equal(fighter(state, amber2).saves, 4)
  assert.equal(fighter(state, amber2).income.pending, 75)
  assert.equal(fighter(state, amber2).income.paidSaves.length, 3)
  rescue(70, 70)
  assert.equal(fighter(state, amber2).saves, 5)
  assert.equal(fighter(state, amber2).income.paidSaves.length, 3)
  assert.equal(fighter(state, amber2).income.pending, 250)
})

test('an interrupted enemy pull that returned home cannot turn a later friendly hook into a paid save', () => {
  let { state, players } = boot(2)
  const enemy = players[0]!, victim = players[1]!, ally = players[3]!
  state = step(state, frame(9, [holding(enemy, amber), victim, players[2]!, ally])).state
  const deadEnemy = body(enemy, { alive: false, health: 0 })
  state = step(state, frame(10, [deadEnemy, victim, players[2]!, ally])).state
  state = step(state, frame(11, [deadEnemy, victim, players[2]!, holding(ally, amber)])).state
  state = step(state, frame(12, [deadEnemy, victim, players[2]!, ally])).state
  assert.equal(fighter(state, amber2).saves, 0)
  assert.equal(fighter(state, amber2).income.pending, 0)
})

test('a Mystical Piano lands after its fall and stuns only the enemies standing under it', () => {
  let { state, b, a } = boot()
  const caster = fighter(state, blue)
  caster.progression.owned = ['piano']; caster.progression.setup = 'piano'
  const mark = { x: 704, y: -300, z: 104 }
  const press: Request = { kind: 'tool', actor: ref(state, blue), tool: 'setup', menuAtPress: 'closed', launch: undefined, mark }
  const cast = step(state, frame(9, [position(b, 300), position(a, -300)]), [press])
  const dropped = cast.commands.find(command => command.kind === 'piano')
  assert.ok(dropped && dropped.kind === 'piano')
  assert.deepEqual([dropped.piano.mark, dropped.piano.landsAt], [mark, 9 + pianoRules.delay])
  assert.equal(fighter(cast.state, blue).setupUntil, 9 + catalog.piano.cooldown)
  const falling = step(cast.state, frame(10, [position(b, 300), position(a, -300)]))
  assert.equal(falling.commands.some(command => command.kind === 'stun' || command.kind === 'pianoLand'), false)
  const under = step(falling.state, frame(9 + pianoRules.delay, [position(b, 300), position(a, -300)]))
  assert.deepEqual(under.commands.filter(command => command.kind === 'stun').map(command => command.kind === 'stun' && command.actor.id), [amber])
  assert.equal(under.commands.filter(command => command.kind === 'pianoLand').length, 1)
  assert.equal(under.state.pianos.length, 0)
  const clear = step(falling.state, frame(9 + pianoRules.delay, [position(b, 300), position(a, -300 - pianoRules.radius - 10)]))
  assert.equal(clear.commands.some(command => command.kind === 'stun'), false)
  assert.equal(clear.commands.filter(command => command.kind === 'pianoLand').length, 1)
})
test('a Mystical Piano aimed at no ground keeps its cooldown and drops nothing', () => {
  const { state, b, a } = boot()
  const caster = fighter(state, blue)
  caster.progression.owned = ['piano']; caster.progression.setup = 'piano'
  const result = step(state, frame(9, [b, a]), [{ kind: 'tool', actor: ref(state, blue), tool: 'setup', menuAtPress: 'closed', launch: undefined }])
  assert.equal(result.commands.some(command => command.kind === 'piano'), false)
  assert.equal(fighter(result.state, blue).setupUntil, caster.setupUntil)
  assert.equal(fighter(result.state, blue).notice.text, 'Aim at the ground')
})
test('the piano mark is the ground under the aim, capped at its range, and a landing reaches only heroes near that ground', () => {
  const height = (x: number) => x > 400 ? 100 : 0
  const world = (start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }) => {
    if (start.x === end.x && start.y === end.y) return start.z < height(start.x) ? { position: start, startSolid: true } : end.z <= height(start.x) ? { position: { ...start, z: height(start.x) }, startSolid: false } : undefined
    return end.z < 0 ? { position: { x: start.x + (end.x - start.x) * start.z / (start.z - end.z), y: start.y + (end.y - start.y) * start.z / (start.z - end.z), z: 0 }, startSolid: false } : undefined
  }
  const near = pianoMark({ x: 0, y: 0, z: 100 }, { pitch: 45, yaw: 0 }, world)
  assert.ok(near && near.x > 80 && near.x <= 100 && near.z === 0)
  const far = pianoMark({ x: 0, y: 0, z: 100 }, { pitch: 0, yaw: 90 }, world)
  assert.ok(far && Math.abs(far.y - pianoRules.range) < 1 && far.z === 0)
  const bank = pianoMark({ x: 0, y: 0, z: 140 }, { pitch: 10, yaw: 0 }, world)
  assert.ok(bank && bank.x > 400 && bank.x < 440 && bank.z === 100)
  assert.equal(pianoMark({ x: 0, y: 0, z: 100 }, { pitch: 0, yaw: 0 }, () => undefined), undefined)
  assert.equal(flattened({ x: 0, y: 0, z: 0 }, { x: pianoRules.radius - 1, y: 0, z: 40 }), true)
  assert.equal(flattened({ x: 0, y: 0, z: 0 }, { x: pianoRules.radius + 1, y: 0, z: 0 }), false)
  assert.equal(flattened({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: pianoRules.reach + 1 }), false)
})

test('Knockdown marks the enemy in the sights, drops them when the mark runs out, and spends nothing with nobody in the sights', () => {
  const { state, b, a } = boot()
  const caster = fighter(state, blue)
  caster.progression.owned = ['knockdown']; caster.progression.setup = 'knockdown'
  const press = (sighted?: typeof amber): Request => ({ kind: 'tool', actor: ref(state, blue), tool: 'setup', menuAtPress: 'closed', launch: undefined, sighted })
  const empty = step(state, frame(9, [b, a]), [press()])
  assert.equal(empty.commands.some(command => command.kind === 'knockdown'), false)
  assert.equal(fighter(empty.state, blue).setupUntil, caster.setupUntil)
  assert.equal(fighter(empty.state, blue).notice.text, 'No enemy in your sights')
  assert.equal(step(state, frame(9, [b, a]), [press(blue)]).commands.some(command => command.kind === 'knockdown'), false)
  const cast = step(state, frame(9, [b, a]), [press(amber)])
  const marked = cast.commands.find(command => command.kind === 'knockdown')
  assert.ok(marked && marked.kind === 'knockdown' && marked.victim.id === amber)
  assert.equal(fighter(cast.state, blue).setupUntil, 9 + catalog.knockdown.cooldown)
  const waiting = step(cast.state, frame(10, [b, a]))
  assert.equal(waiting.commands.some(command => command.kind === 'stun'), false)
  const landed = step(waiting.state, frame(9 + knockdownRules.delay, [b, a]))
  assert.deepEqual(landed.commands.filter(command => command.kind === 'stun').map(command => command.kind === 'stun' && [command.actor.id, command.seconds]), [[amber, knockdownRules.stun]])
  assert.equal(landed.state.knockdowns.length, 0)
  assert.equal(step(landed.state, frame(12, [b, a])).commands.some(command => command.kind === 'stun'), false)
})
test('the sights pick the hero nearest the middle of the view, in range, inside the cone and not behind cover', () => {
  const camera = { x: 0, y: 0, z: 48 }, ahead = { pitch: 0, yaw: 0 }, open = () => true
  const heroes = [{ id: 'near', position: { x: 400, y: 30, z: 0 } }, { id: 'centre', position: { x: 800, y: 0, z: 0 } }, { id: 'side', position: { x: 400, y: 400, z: 0 } }]
  assert.equal(inSights(camera, ahead, heroes, 1200, 9, open), 'centre')
  assert.equal(inSights(camera, ahead, heroes, 600, 9, open), 'near')
  assert.equal(inSights(camera, ahead, heroes.slice(2), 1200, 9, open), undefined)
  assert.equal(inSights(camera, ahead, heroes, 1200, 9, (_, end) => end.x < 600), 'near')
  assert.equal(inSights(camera, { pitch: 0, yaw: 180 }, heroes, 1200, 9, open), undefined)
})
