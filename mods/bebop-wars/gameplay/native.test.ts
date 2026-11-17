import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'modlock' || specifier.endsWith('/hud.tsx')) return next(new URL('./testing/host.ts', import.meta.url).href, context)
    if (specifier === 'modlock/console') return next(new URL('../.tools/modlock/js/src/console.ts', import.meta.url).href, context)
    return next(specifier, context)
  },
})
const { Game } = await import('./native.ts')
const { Buttons, host } = await import('./testing/host.ts')
type FakePlayer = ReturnType<typeof host.join>

const frame = 0.05

function match(sides: readonly number[] = [3, 2]) {
  host.reset()
  const players = sides.map((side, index) => host.join(`Player ${index}`, side))
  const game = new Game([`teams=${sides.length / 2}v${sides.length / 2}`])
  game.start()
  game.world('winter_arena')
  let now = 0
  const run = (seconds: number) => { for (const end = now + seconds - frame / 2; now < end;) { now += frame; game.tick({ timeSeconds: now }) } }
  const fighter = (player: FakePlayer) => {
    const found = [...game.state.fighters.values()].find(each => each.presence.kind === 'connected' && each.presence.slot === player.slot)
    assert.ok(found, `${player.name} has a fighter`)
    return found
  }
  run(1)
  return {
    game, players, run, fighter,
    get now() { return now },
    goLive() {
      for (const player of players) game.request(fighter(player).id, { kind: 'ready' })
      for (let waited = 0; game.state.phase.kind !== 'live'; waited++) { assert.ok(waited < 400, 'the match goes live'); run(frame) }
      run(1)
    },
    buy(player: FakePlayer, product: string, item: string) {
      if (game.state.phase.kind !== 'warmup') player.body!.souls = 600
      game.request(fighter(player).id, { kind: 'buy', product })
      run(0.5)
      return player.item(item)
    },
    press(player: FakePlayer, item: { slot: number }) {
      game.input(player, 1n << BigInt(33 + item.slot), 0n)
      game.input(player, 0n, 1n << BigInt(33 + item.slot))
    },
  }
}

const button = (item: { slot: number }) => 1n << BigInt(33 + item.slot)

test('Sprint waits for the game to cast it, then keeps its cooldown', () => {
  const m = match(), [ada] = m.players
  const boots = m.buy(ada!, 'sprint', 'upgrade_fleetfoot_boots')
  m.press(ada!, boots)
  m.run(frame)
  assert.deepEqual(ada!.presses, [button(boots)])
  const cooldown = m.fighter(ada!).utilityUntil
  assert.ok(cooldown > m.now, 'Sprint starts its cooldown on the press')
  assert.equal(host.reloadHeld, true, 'a pending Sprint holds reloads')
  m.run(0.5)
  m.game.cast({ ability: boots.entity })
  m.run(2)
  assert.equal(m.fighter(ada!).utilityUntil, cooldown)
  assert.equal(m.fighter(ada!).notice.text, '')
  assert.deepEqual(ada!.cancelled, [button(boots)], 'the settled press is cleared')
  assert.equal(host.reloadHeld, false)
})

test('Sprint the game never casts is put away after a second and its cooldown restored', () => {
  const m = match(), [ada] = m.players
  const boots = m.buy(ada!, 'sprint', 'upgrade_fleetfoot_boots')
  m.press(ada!, boots)
  m.run(0.9)
  assert.deepEqual(ada!.cancelled, [], 'still waiting just under a second')
  m.run(0.3)
  assert.deepEqual(ada!.cancelled, [button(boots)])
  assert.deepEqual(ada!.writes.filter(write => write.ability === boots.name).at(-1), { ability: boots.name, cooldownEnd: 0 })
  assert.equal(m.fighter(ada!).utilityUntil, 0)
  assert.equal(m.fighter(ada!).notice.text, 'Tool unavailable; cooldown restored')
  assert.equal(host.reloadHeld, false)
})

test('a pending Sprint is dropped without a refund when its Bebop dies', () => {
  const m = match(), [ada] = m.players
  const boots = m.buy(ada!, 'sprint', 'upgrade_fleetfoot_boots')
  m.press(ada!, boots)
  m.run(frame)
  const cooldown = m.fighter(ada!).utilityUntil
  ada!.body!.health = 0
  m.run(frame * 2)
  assert.deepEqual(ada!.cancelled, [button(boots)])
  assert.equal(m.fighter(ada!).utilityUntil, cooldown)
  assert.equal(m.fighter(ada!).notice.text, '')
})

test('buying another item drops a pending Sprint without a refund', () => {
  const m = match(), [ada] = m.players
  m.goLive()
  const boots = m.buy(ada!, 'sprint', 'upgrade_fleetfoot_boots')
  m.press(ada!, boots)
  m.run(frame)
  const cooldown = m.fighter(ada!).utilityUntil
  m.buy(ada!, 'etherealShift', 'upgrade_self_bubble')
  assert.deepEqual(ada!.cancelled, [button(boots)])
  m.run(1)
  assert.equal(m.fighter(ada!).utilityUntil, cooldown)
  assert.equal(m.fighter(ada!).notice.text, '')
})

test('a cast item the game casts keeps the cooldown Bebop Wars set', () => {
  const m = match(), [ada] = m.players
  const shift = m.buy(ada!, 'etherealShift', 'upgrade_self_bubble')
  m.press(ada!, shift)
  m.run(frame)
  const cooldown = m.fighter(ada!).defenseUntil
  assert.ok(cooldown > m.now)
  assert.equal(host.reloadHeld, true, 'a pending cast holds reloads')
  ada!.item(shift.name).cooldownEnd = m.now + 99
  m.game.cast({ ability: shift.entity })
  m.run(frame)
  assert.equal(ada!.item(shift.name).cooldownEnd, cooldown, 'the native cooldown is replaced by the Bebop Wars one')
  m.run(2)
  assert.deepEqual(ada!.presses, [button(shift)])
  assert.deepEqual(ada!.cancelled, [button(shift) | Buttons.attack])
  assert.equal(m.fighter(ada!).notice.text, '')
  assert.equal(host.reloadHeld, false)
})

test('a cast item that never starts is put away after 1.2 seconds and its cooldown restored', () => {
  const m = match(), [ada] = m.players
  const shift = m.buy(ada!, 'etherealShift', 'upgrade_self_bubble')
  m.press(ada!, shift)
  m.run(1.1)
  assert.deepEqual(ada!.cancelled, [], 'still waiting just under 1.2 seconds')
  m.run(0.2)
  assert.deepEqual(ada!.cancelled, [button(shift) | Buttons.attack])
  assert.deepEqual(ada!.presses, [button(shift)], 'an unaimed item is not pressed again')
  assert.deepEqual(ada!.writes.filter(write => write.ability === shift.name).at(-1), { ability: shift.name, cooldownEnd: 0 })
  assert.equal(m.fighter(ada!).defenseUntil, 0)
  assert.equal(m.fighter(ada!).notice.text, 'Ethereal Shift found no target')
})

test('an aimed item is confirmed after a moment and put away again when it finds no hero', () => {
  const m = match([3, 3, 2, 2]), [ada] = m.players
  m.goLive()
  const beam = m.buy(ada!, 'rescueBeam', 'upgrade_rescue_beam')
  m.press(ada!, beam)
  m.run(frame)
  assert.deepEqual(ada!.presses, [button(beam)])
  m.run(0.15)
  assert.deepEqual(ada!.presses, [button(beam), Buttons.attack], 'the aimed cast is confirmed once')
  m.run(1.1)
  assert.deepEqual(ada!.presses, [button(beam), Buttons.attack, button(beam)])
  assert.deepEqual(ada!.cancelled, [button(beam) | Buttons.attack])
  assert.equal(m.fighter(ada!).notice.text, 'Rescue Beam found no target')
})

test('a pending cast is dropped without a refund when its Bebop dies', () => {
  const m = match(), [ada] = m.players
  const shift = m.buy(ada!, 'etherealShift', 'upgrade_self_bubble')
  m.press(ada!, shift)
  m.run(frame)
  const cooldown = m.fighter(ada!).defenseUntil
  ada!.body!.health = 0
  m.run(frame * 2)
  assert.deepEqual(ada!.cancelled, [button(shift) | Buttons.attack])
  assert.equal(m.fighter(ada!).defenseUntil, cooldown)
  assert.equal(m.fighter(ada!).notice.text, '')
})

test('Sprint and a defense item pressed together each settle on their own', () => {
  const m = match(), [ada] = m.players
  m.goLive()
  const boots = m.buy(ada!, 'sprint', 'upgrade_fleetfoot_boots')
  const shift = m.buy(ada!, 'etherealShift', 'upgrade_self_bubble')
  const sprintReady = m.fighter(ada!).utilityUntil
  m.game.input(ada!, button(boots) | button(shift), 0n)
  m.run(frame)
  assert.deepEqual(ada!.presses.slice().sort(), [button(boots), button(shift)].sort())
  m.game.cast({ ability: shift.entity })
  m.run(frame)
  assert.deepEqual(ada!.cancelled, [button(shift) | Buttons.attack], 'the cast settles while Sprint still waits')
  m.run(1.2)
  assert.deepEqual(ada!.cancelled, [button(shift) | Buttons.attack, button(boots)])
  assert.equal(m.fighter(ada!).utilityUntil, sprintReady, 'the Sprint that never started is refunded')
  assert.ok(m.fighter(ada!).defenseUntil > m.now, 'the defense item that started keeps its cooldown')
})

test('Mystical Piano shows its warning until it lands, then the smash', () => {
  const m = match(), [ada] = m.players
  m.goLive()
  const piano = m.buy(ada!, 'piano', 'upgrade_return_fire')
  ada!.body!.cameraAngles = { pitch: 30, yaw: -90, roll: 0 }
  m.press(ada!, piano)
  m.run(frame)
  const shown = () => host.particles.filter(particle => !particle.removed).map(particle => particle.resource).sort()
  assert.deepEqual(shown(), ['particles/upgrades/mystical_piano.vpcf', 'particles/upgrades/mystical_piano_aoe_indicator.vpcf'])
  m.run(1.7)
  assert.deepEqual(shown(), ['particles/upgrades/mystical_piano.vpcf', 'particles/upgrades/mystical_piano_hit.vpcf'])
  m.run(0.35)
  assert.deepEqual(shown(), ['particles/upgrades/mystical_piano_hit.vpcf'])
  m.run(3)
  assert.deepEqual(shown(), [])
})

test('a Snow Globe flies as a particle, bursts into an impact and frosts the enemy it chills', () => {
  const m = match(), [ada, bo] = m.players
  ada!.body!.position = { ...ada!.body!.position, y: 400 }
  bo!.body!.position = { ...bo!.body!.position, y: -760 }
  const globe = m.buy(ada!, 'snowGlobe', 'upgrade_cold_front')
  m.press(ada!, globe)
  m.run(frame)
  const [flight] = host.particles
  assert.equal(flight?.resource, 'particles/abilities/kelvin/kelvin_ice_grenade_projectile.vpcf')
  const launched = flight.position.y
  m.run(0.3)
  assert.ok(flight.position.y < launched - 300, 'the particle follows the globe')
  assert.equal(flight.removed, false)
  m.run(0.6)
  assert.equal(flight.removed, true)
  const shown = () => host.particles.filter(particle => !particle.removed).map(particle => particle.resource).sort()
  assert.deepEqual(shown(), ['particles/abilities/kelvin/kelvin_ice_grenade_explode_v2.vpcf', 'particles/abilities/kelvin/kelvin_ice_grenade_slow.vpcf'])
  assert.equal(m.fighter(bo!).notice.text, 'Chilled by Snow Globe')
  m.run(1.2)
  assert.deepEqual(shown(), ['particles/abilities/kelvin/kelvin_ice_grenade_explode_v2.vpcf'])
  m.run(2)
  assert.deepEqual(shown(), [])
})
