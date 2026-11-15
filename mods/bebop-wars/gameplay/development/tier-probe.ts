import { Buttons, log, readField, type Player } from 'modlock'
import { distance, type Vec3 } from '../arena.ts'
import { canAct, hookBusy, type AccountId, type Fighter } from '../model.ts'
import { hookAbility, type Game } from '../native.ts'

const unitsPerMeter = 39.37007874
const sourcePosition = { x: 704, y: 16 * unitsPerMeter, z: 104 }
const targetPosition = { x: 704, y: -16 * unitsPerMeter, z: 104 }
const scenarios = [
  { name: 'base range', mask: 1, kills: 0, cooldown: 5, aimed: true, hit: false },
  { name: 'tier one range', mask: 3, kills: 3, cooldown: 5, aimed: true, hit: true },
  { name: 'tier two cooldown', mask: 7, kills: 5, cooldown: 4, aimed: false, hit: false },
  { name: 'tier three Rebound', mask: 15, kills: 10, cooldown: 4, aimed: true, hit: true },
]

export class TierProbe {
  private phase: 'prepare' | 'ready' | 'flight' = 'prepare'
  private index = 0
  private since = 0
  private deadline = 0
  private beforeHealth = 0
  private executed = false
  private hitAt: number | undefined
  private damageAt: number | undefined
  private nativeEnd = 0
  private baseTravel = 0
  private refunded = false

  constructor(private readonly source: AccountId, private readonly victim: AccountId) {}

  tick(game: Game, now: number): false | true | string {
    if (!this.deadline) {
      this.deadline = now + 35
      log('[BebopWarsProbe] Tier fixtures set kill entitlement and native masks directly; this tests effects, not native upgrade spending controls')
    }
    const scenario = scenarios[this.index]
    if (!scenario) return true
    const player = game.player(this.source), target = game.player(this.victim)
    const fighter = game.state.fighters.get(this.source), enemy = game.state.fighters.get(this.victim)
    const pawn = player?.pawn(), targetPawn = target?.pawn()
    const ability = player?.abilities().find(ability => ability.name === hookAbility)
    const hook = game.frame.players.find(sample => sample.id === this.source)?.body?.hook
    if (!player || !target || !fighter || !enemy || !pawn || !targetPawn || !ability || !hook) return 'native tier fixture participants or Hook disappeared'
    if (now > this.deadline || (this.phase !== 'prepare' && now - this.since > 6)) {
      log(`[BebopWarsProbe] tier timeout ${JSON.stringify({ scenario: scenario.name, phase: this.phase, executed: this.executed, hitAt: this.hitAt, ability, source: pawn.position, target: targetPawn.position, diagnostic: game.diagnostic(this.source) })}`)
      return `native tier verification timed out at ${scenario.name}/${this.phase}`
    }
    if (this.phase === 'prepare') {
      const targetHook = game.frame.players.find(sample => sample.id === this.victim)?.body?.hook
      if (!canAct(game.state, fighter) || !canAct(game.state, enemy) || hookBusy(hook) || (targetHook && hookBusy(targetHook))) return false
      if (fighter.life.kind !== 'alive' || enemy.life.kind !== 'alive' || fighter.life.protectionUntil > now || enemy.life.protectionUntil > now) return false
      if (!player.heal(100000) || !target.heal(100000)) return 'tier fixture healing failed'
      fighter.kills = scenario.kills
      if (!player.setAbility({ ability: hookAbility, upgrades: scenario.mask, cooldownEnd: 0 })) return 'native tier fixture could not set Hook rank'
      if (!this.place(player, fighter, sourcePosition, 3) || !this.place(target, enemy, targetPosition, 2)) return 'tier fixture placement failed'
      this.executed = false; this.hitAt = undefined; this.damageAt = undefined; this.nativeEnd = 0; this.refunded = false
      this.phase = 'ready'; this.since = now
      log(`[BebopWarsProbe] Tier fixture ${JSON.stringify({ scenario: scenario.name, kills: scenario.kills, nativeMask: scenario.mask, targetMeters: 32 })}`)
      return false
    }
    if (this.phase === 'ready') {
      if (now - this.since < 0.5 || ability.upgrades !== scenario.mask) return false
      const meters = distance(pawn.eyePosition, targetPawn.eyePosition) / unitsPerMeter
      if (Math.abs(meters - 32) > 0.25) return `tier range fixture is ${meters.toFixed(2)}m instead of 32m`
      const dx = targetPawn.eyePosition.x - pawn.eyePosition.x, dy = targetPawn.eyePosition.y - pawn.eyePosition.y, dz = targetPawn.eyePosition.z - pawn.eyePosition.z
      const facing = scenario.aimed
        ? { pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI, yaw: Math.atan2(dy, dx) * 180 / Math.PI, roll: 0 }
        : { pitch: 0, yaw: 0, roll: 0 }
      this.beforeHealth = targetPawn.health
      if (!player.drive({ facing, forward: 0, left: 0, held: 0n, pressed: Buttons.ability3 })) return 'native tier fixture Hook input failed'
      this.phase = 'flight'; this.since = now
      return false
    }
    if (hook.executed) {
      if (this.executed) return `tier fixture executed more than one Hook during ${scenario.name}`
      this.executed = true
      this.nativeEnd = ability.cooldownEnd
      const duration = ability.cooldownEnd - ability.cooldownStart
      const travel = readField(ability.entity, 'CCitadel_Ability_Hook', 'm_flMaxHookTravelTime', 'float32')
      log(`[BebopWarsProbe] Native tier throw ${JSON.stringify({ scenario: scenario.name, mask: ability.upgrades, duration, maxTravelTime: travel, cooldownStart: ability.cooldownStart, cooldownEnd: ability.cooldownEnd })}`)
      if (Math.abs(duration - scenario.cooldown) > 0.15) return `${scenario.name} native cooldown was ${duration.toFixed(3)}s, expected ${scenario.cooldown}s`
      if (scenario.mask === 1 || scenario.mask === 3) {
        if (typeof travel !== 'number' || !Number.isFinite(travel) || travel <= 0) return 'native Hook travel-time observation is unavailable'
        if (scenario.mask === 1) this.baseTravel = travel
        else if (Math.abs(travel / this.baseTravel - 1.2) > 0.015) return `tier one native travel time did not increase 30m to 36m: ${this.baseTravel} -> ${travel}`
      }
    }
    if (targetPawn.health < this.beforeHealth) this.damageAt ??= now
    if (hook.victim === this.victim || this.damageAt !== undefined) this.hitAt ??= now
    if (this.hitAt !== undefined && !scenario.hit) return `${scenario.name} unexpectedly hit the enemy at 32m`
    if (!this.executed) return false
    if (scenario.mask === 15 && this.hitAt !== undefined) {
      if (this.damageAt === undefined) {
        if (now - this.hitAt > 2) return 'tier three caught its victim but applied no Hook damage within two seconds'
        return false
      }
      const expected = this.nativeEnd - 1
      if (ability.cooldownEnd < expected - 0.08) return `Rebound refunded more than once: expected endpoint ${expected}, observed ${ability.cooldownEnd}`
      this.refunded ||= Math.abs(ability.cooldownEnd - expected) <= 0.08
      if (!this.refunded && now - this.damageAt > 0.4) return 'tier three enemy hit did not refund one second of native Hook cooldown'
      if (this.refunded && Math.abs(ability.cooldownEnd - expected) > 0.08) return 'Rebound cooldown changed again without a new throw'
      if (!this.refunded || now - this.damageAt < 1.2) return false
    }
    if (now - this.since < 1.5 || hookBusy(hook)) return false
    if (scenario.hit && this.hitAt === undefined) return `${scenario.name} failed to catch the enemy at 32m`
    log(`[BebopWarsProbe] PASS ${scenario.mask === 1 ? 'native base Hook misses at 32m with five-second cooldown' : scenario.mask === 3 ? 'native tier one Hook catches at 32m beyond base 30m reach' : scenario.mask === 7 ? 'native tier two executed throw has four-second cooldown' : 'native tier three enemy hit refunds exactly one second and does not repeat through pull completion'}`)
    this.index++
    this.phase = 'prepare'; this.since = now
    return this.index === scenarios.length
  }

  private place(player: Player, fighter: Fighter, position: Vec3, bank: 2 | 3): boolean {
    if (fighter.life.kind !== 'alive') return false
    fighter.life.bank = bank; fighter.life.safe = position; fighter.life.position = position
    const facing = { pitch: 0, yaw: bank === 3 ? 270 : 90, roll: 0 }
    return player.teleport(position, facing, { x: 0, y: 0, z: 0 }) && player.drive({ facing, forward: 0, left: 0, held: 0n, pressed: 0n })
  }
}
