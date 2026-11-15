import assert from 'node:assert/strict'
import test from 'node:test'
import { accountId } from './model.ts'
import { NativeProgress, exactWallet, hookRank } from './native-progress.ts'

type Port = Parameters<NativeProgress['reconcile']>[0]
type Participant = Parameters<NativeProgress['reconcile']>[1]
type Match = Parameters<NativeProgress['reconcile']>[2]
type Body = NonNullable<ReturnType<Port['pawn']>>
type NativeAbility = ReturnType<Port['abilities']>[number]

function fixture() {
  const progress = new NativeProgress()
  const id = accountId('steam:1')
  const fighter: Participant = { id, presence: { kind: 'connected', slot: 1, generation: 1 }, kills: 0, progression: { owned: [], utility: null, purchase: null, feedback: { text: '', until: 0 } } }
  const state: Match = { round: 0, now: 10, phase: { kind: 'live', until: 480 } }
  let pawn: Body = { entity: 20, hero: 1, health: 880, souls: 1500, abilityPoints: 5, abilityUnlocks: 2 }
  let abilities: NativeAbility[] = [
    { name: 'citadel_ability_hook', slot: 2, entity: 30, upgrades: 15, charges: 0, cooldownStart: 10, cooldownEnd: 20, rechargeEnd: 0 },
    { name: 'citadel_ability_bomb', slot: 0, entity: 31, upgrades: 7, charges: 0, cooldownStart: 10, cooldownEnd: 0, rechargeEnd: 0 },
  ]
  let resets = 0
  let failPoints = false
  let failSoulWrites = false
  let failRankWrites = false
  const timerWrites: number[] = []
  const soulWrites: number[] = []
  const port: Port = {
    pawn: () => pawn,
    abilities: () => abilities,
    resetHero: souls => { resets++; pawn = { ...pawn, souls, abilityPoints: 0, abilityUnlocks: 0 }; abilities = abilities.map(ability => ({ ...ability, upgrades: 1, cooldownEnd: 0 })); return true },
    setAbility: options => {
      if (failRankWrites) return false
      if (options.cooldownEnd !== undefined) timerWrites.push(options.cooldownEnd)
      abilities = abilities.map(ability => ability.name === options.ability ? { ...ability, upgrades: options.upgrades ?? ability.upgrades, charges: options.charges ?? ability.charges, cooldownEnd: options.cooldownEnd ?? ability.cooldownEnd, rechargeEnd: options.rechargeEnd ?? ability.rechargeEnd } : ability)
      return true
    },
    adjustSouls: delta => { soulWrites.push(delta); if (failSoulWrites) return false; pawn = { ...pawn, souls: pawn.souls + delta }; return true },
    adjustAbilityPoints: (points, unlocks) => { if (failPoints) return false; pawn = { ...pawn, abilityPoints: pawn.abilityPoints + points, abilityUnlocks: pawn.abilityUnlocks + unlocks }; return true },
  }
  const reconcile = () => progress.reconcile(port, fighter, state, pawn, abilities)
  return { progress, fighter, state, port, reconcile, timerWrites, soulWrites,
    get pawn() { return pawn }, set pawn(next: Body) { pawn = next },
    get abilities() { return abilities }, set abilities(next: NativeAbility[]) { abilities = next },
    get resets() { return resets },
    set failPoints(value: boolean) { failPoints = value },
    set failSoulWrites(value: boolean) { failSoulWrites = value },
    set failRankWrites(value: boolean) { failRankWrites = value },
  }
}

function rank(f: ReturnType<typeof fixture>, upgrades: number): void {
  f.abilities = f.abilities.map(ability => ability.name === 'citadel_ability_hook' ? { ...ability, upgrades } : ability)
}

test('income waits for initial baseline and new body restoration, then survives native snapshots', () => {
  const f = fixture()
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 650), 'deferred')
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 300)
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 650), 'paid')
  assert.equal(f.pawn.souls, 950)
  assert.equal(f.progress.export()?.[0]?.souls, 950)
  f.fighter.presence = { kind: 'connected', slot: 2, generation: 2 }
  f.pawn = { ...f.pawn, entity: 21, souls: 0 }
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 25), 'deferred')
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 950)
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 25), 'paid')
  assert.equal(f.pawn.souls, 975)
  assert.equal(f.progress.export()?.[0]?.souls, 975)
  f.state.round++
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 25), 'deferred')
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 300)
})

test('native reward credit works while dead and reports failed exact grants', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.pawn = { ...f.pawn, health: 0 }
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 100), 'paid')
  assert.equal(f.pawn.souls, 400)
  f.failSoulWrites = true
  assert.equal(f.progress.credit(f.port, f.fighter, f.state, 25), 'failed')
  assert.equal(f.pawn.souls, 400)
  assert.equal(f.progress.export()?.[0]?.souls, 400)
})

test('initialization resets once and ordinary death and respawn retain purchases and native timers', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  assert.equal(f.resets, 1)
  assert.equal(f.pawn.souls, 300)
  f.pawn = { ...f.pawn, health: 0, souls: 1267 }
  f.abilities = f.abilities.map(ability => ({ ...ability, cooldownEnd: 15 }))
  const writes = f.timerWrites.length
  assert.equal(f.reconcile(), true)
  f.pawn = { ...f.pawn, health: 880 }
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 1267)
  assert.equal(f.resets, 1)
  assert.equal(f.timerWrites.length, writes)
  f.progress.reset(f.fighter.id, 0)
  assert.equal(f.reconcile(), true)
  assert.equal(f.resets, 1)
})

test('kill entitlement accepts tiers at 3, 5 and 10 kills and strips level currencies and other upgrades', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  for (const [kills, mask, expected] of [[2, 3, 1], [3, 3, 3], [4, 7, 3], [5, 7, 7], [9, 15, 7], [10, 15, 15]]) {
    assert.ok(kills !== undefined && mask !== undefined && expected !== undefined)
    f.fighter.kills = kills
    f.pawn = { ...f.pawn, abilityPoints: 30, abilityUnlocks: 4 }
    rank(f, mask)
    f.abilities = f.abilities.map(ability => ability.slot === 0 ? { ...ability, upgrades: 15 } : ability)
    assert.equal(f.reconcile(), true)
    assert.equal(f.abilities.find(ability => ability.slot === 2)?.upgrades, expected)
    assert.equal(f.abilities.find(ability => ability.slot === 0)?.upgrades, 1)
    assert.equal(f.pawn.abilityUnlocks, 0)
    const spent = expected === 15 ? 8 : expected === 7 ? 3 : expected === 3 ? 1 : 0
    assert.equal(f.pawn.abilityPoints, Math.min(8, Math.max(0, kills - 2)) - spent)
  }
  assert.equal(hookRank(5), undefined)
})

test('point correction failure blocks purchases and persistence without rewinding native wallet or timers', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.fighter.kills = 3
  f.pawn = { ...f.pawn, souls: 900, abilityPoints: 10 }
  f.failPoints = true
  const timerWrites = f.timerWrites.length
  assert.equal(f.reconcile(), false)
  assert.equal(f.progress.ready(f.fighter.id), false)
  assert.equal(f.progress.export(), undefined)
  f.pawn = { ...f.pawn, souls: 1000 }
  f.failPoints = false
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 1000)
  assert.equal(f.pawn.abilityPoints, 1)
  assert.equal(f.timerWrites.length, timerWrites)
  assert.equal(f.resets, 1)
})

test('body rebuild restores last native wallet, accepted tier and absolute cooldown once', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.fighter.kills = 5
  rank(f, 7)
  f.pawn = { ...f.pawn, souls: 800 }
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, cooldownEnd: 15 } : ability)
  assert.equal(f.reconcile(), true)
  f.pawn = { ...f.pawn, entity: 21, souls: 300 }
  f.abilities = f.abilities.map(ability => ({ ...ability, entity: ability.entity + 10, upgrades: 1, cooldownEnd: 0 }))
  f.failSoulWrites = true
  assert.equal(f.reconcile(), false)
  assert.equal(f.progress.ready(f.fighter.id), false)
  f.failSoulWrites = false
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 800)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.upgrades, 7)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 15)
  const writes = f.timerWrites.length
  assert.equal(f.reconcile(), true)
  assert.equal(f.timerWrites.length, writes)
  assert.equal(f.resets, 1)
})

test('post-transaction reconciliation persists wallet and Echo, reconnect expires elapsed cooldowns', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.pawn = { ...f.pawn, souls: 0 }
  f.abilities = f.abilities.map(ability => ({ ...ability, cooldownEnd: 12 }))
  assert.equal(f.reconcile(), true)
  const snapshot = f.progress.export()
  assert.ok(snapshot)
  const resumed = new NativeProgress()
  assert.equal(resumed.restore(JSON.parse(JSON.stringify(snapshot))), true)
  f.fighter.presence = { kind: 'connected', slot: 1, generation: 2 }
  f.state.now = 20
  f.pawn = { ...f.pawn, souls: 300 }
  assert.equal(resumed.reconcile(f.port, f.fighter, f.state, f.pawn, f.abilities), true)
  assert.equal(f.pawn.souls, 0)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 0)
})

test('new round resets once while warmup removes combat income without refunding owned tools', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.state.round = 1
  f.state.phase = { kind: 'warmup' }
  assert.equal(f.reconcile(), true)
  assert.equal(f.resets, 2)
  f.fighter.progression.owned = ['sprint']
  f.pawn = { ...f.pawn, souls: 1267 }
  assert.equal(f.reconcile(), true)
  assert.equal(f.pawn.souls, 0)
  assert.equal(f.resets, 2)
})

test('failed initialization correction retries without another native reset', () => {
  const f = fixture()
  f.failRankWrites = true
  assert.equal(f.reconcile(), false)
  assert.equal(f.resets, 1)
  assert.equal(f.progress.ready(f.fighter.id), false)
  f.failRankWrites = false
  assert.equal(f.reconcile(), true)
  assert.equal(f.resets, 1)
  assert.equal(f.pawn.souls, 300)
})

test('malformed or duplicate persisted snapshots are rejected without replacing valid state', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  const saved = f.progress.export()
  assert.ok(saved && saved[0])
  for (const value of [null, [{}], [saved[0], saved[0]], [{ ...saved[0], souls: -1 }], [{ ...saved[0], rank: 4 }], [{ ...saved[0], cooldownEnd: Infinity }]]) {
    assert.equal(f.progress.restore(value), false)
    assert.deepEqual(f.progress.export(), saved)
  }
})

test('scaled positive grants are corrected to exact wallet and retries use the remaining difference', () => {
  let body: Body = { entity: 1, hero: 1, health: 880, souls: 0, abilityPoints: 0, abilityUnlocks: 0 }
  const writes: number[] = []
  let failDebit = true
  const player = {
    pawn: () => body,
    adjustSouls(delta: number): boolean {
      writes.push(delta)
      if (delta < 0 && failDebit) return false
      body = { ...body, souls: body.souls + (delta > 0 ? delta * 2 : delta) }
      return true
    },
  }
  assert.equal(exactWallet(player, 300), false)
  assert.equal(body.souls, 600)
  failDebit = false
  assert.equal(exactWallet(player, 300), true)
  assert.equal(body.souls, 300)
  assert.deepEqual(writes, [300, -300, -300])
})

test('clean frames do not requery native samples or write timers', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  let queries = 0
  const player: Port = { ...f.port, pawn: () => { queries++; return f.pawn }, abilities: () => { queries++; return f.abilities } }
  const timerWrites = f.timerWrites.length
  assert.equal(f.progress.reconcile(player, f.fighter, f.state, f.pawn, f.abilities), true)
  assert.equal(queries, 0)
  assert.equal(f.timerWrites.length, timerWrites)
})

test('disconnect during currency repair preserves the snapshot without holding persistence', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.failPoints = true
  f.pawn = { ...f.pawn, abilityPoints: 30, souls: 900 }
  assert.equal(f.reconcile(), false)
  assert.equal(f.progress.busy, true)
  f.progress.disconnected(f.fighter.id)
  assert.equal(f.progress.busy, false)
  assert.equal(f.progress.ready(f.fighter.id), false)
  const saved = f.progress.export()
  assert.ok(saved)
  assert.equal(saved[0]?.souls, 900)
})

test('rejecting an unaffordable tier restores only the existing throw cooldown', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, cooldownStart: 10, cooldownEnd: 15 } : ability)
  assert.equal(f.reconcile(), true)
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, upgrades: 15, cooldownEnd: 14 } : ability)
  assert.equal(f.reconcile(), true)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 15)
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, upgrades: 15, cooldownStart: 11, cooldownEnd: 16 } : ability)
  assert.equal(f.reconcile(), true)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 16)
})


test('rejected tier cooldown and current wallet survive failed and partial correction retries', () => {
  for (const partial of [false, true]) {
    const f = fixture()
    assert.equal(f.reconcile(), true)
    f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, cooldownStart: 10, cooldownEnd: 15 } : ability)
    assert.equal(f.reconcile(), true)
    f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, upgrades: 15, cooldownEnd: 14 } : ability)
    f.pawn = { ...f.pawn, souls: 900 }
    const failing: Port = { ...f.port, setAbility: options => {
      if (partial) f.port.setAbility({ ability: options.ability, upgrades: options.upgrades })
      return false
    } }
    assert.equal(f.progress.reconcile(failing, f.fighter, f.state, f.pawn, f.abilities), false)
    f.progress.disconnected(f.fighter.id)
    assert.equal(f.progress.export()?.[0]?.souls, 900)
    assert.equal(f.progress.export()?.[0]?.cooldownEnd, 15)
    f.pawn = { ...f.pawn, souls: 1000 }
    assert.equal(f.reconcile(), true)
    assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 15)
    assert.equal(f.pawn.souls, 1000)
    assert.equal(f.progress.export()?.[0]?.souls, 1000)
  }
})

test('a new throw supersedes an unverified old cooldown correction', () => {
  const f = fixture()
  assert.equal(f.reconcile(), true)
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, cooldownStart: 10, cooldownEnd: 15 } : ability)
  assert.equal(f.reconcile(), true)
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, upgrades: 15, cooldownEnd: 14 } : ability)
  f.failRankWrites = true
  assert.equal(f.reconcile(), false)
  f.failRankWrites = false
  f.abilities = f.abilities.map(ability => ability.slot === 2 ? { ...ability, cooldownStart: 11, cooldownEnd: 16 } : ability)
  assert.equal(f.reconcile(), true)
  assert.equal(f.abilities.find(ability => ability.slot === 2)?.cooldownEnd, 16)
})
