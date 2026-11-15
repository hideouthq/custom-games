import { Buttons, log, modifierState, type MeleeEvent, type ParryEvent, type Player } from 'modlock'
import { canAct, hookBusy, type AccountId } from '../model.ts'
import type { Game } from '../native.ts'

const sourcePosition = { x: 704, y: 300, z: 4 }
const targetPosition = { x: 704, y: 370, z: 4 }
const sourceFacing = { pitch: 0, yaw: 90, roll: 0 }
const targetFacing = { pitch: 0, yaw: 270, roll: 0 }
type Phase = 'setupLight' | 'lightReady' | 'light' | 'setupHeavy' | 'heavyReady' | 'heavy' | 'setupParry' | 'parryReady' | 'parry' | 'release'

export class MeleeProbe {
  private phase: Phase = 'setupLight'
  private since = 0
  private deadline = 0
  private beforeHealth = 0
  private lightDamage = 0
  private heavyDelay = 0
  private parryPressed = false
  private sawStun = false
  private minimumHealth = Infinity
  private swings: MeleeEvent[] = []
  private parries: ParryEvent[] = []

  constructor(private readonly source: AccountId, private readonly target: AccountId) {}

  swing(event: MeleeEvent): void { this.swings.push(event) }
  parried(event: ParryEvent): void { this.parries.push(event) }

  tick(game: Game, now: number): false | true | string {
    if (!this.deadline) this.deadline = now + 22
    const source = game.player(this.source), target = game.player(this.target)
    const fighter = game.state.fighters.get(this.source), victim = game.state.fighters.get(this.target)
    const sourcePawn = source?.pawn(), targetPawn = target?.pawn()
    if (!source || !target || !fighter || !victim || !sourcePawn || !targetPawn) return 'melee fixture participants disappeared'
    if (!source.abilities().some(ability => ability.name === 'citadel_ability_melee_bebop') || !target.abilities().some(ability => ability.name === 'citadel_ability_melee_parry')) return 'native melee or parry ability missing'
    const struck = this.swings.filter(swing => swing.attacker === sourcePawn.entity && swing.hits.includes(targetPawn.entity))
    const parried = this.parries.some(parry => parry.parrier === targetPawn.entity && parry.attacker === sourcePawn.entity)
    if (now > this.deadline) {
      this.release(source, target)
      log(`[BebopWarsProbe] melee timeout ${JSON.stringify({ phase: this.phase, swings: this.swings, parries: this.parries, sourceEntity: sourcePawn.entity, targetEntity: targetPawn.entity, source: sourcePawn.position, target: targetPawn.position, health: targetPawn.health, beforeHealth: this.beforeHealth, lightDamage: this.lightDamage, heavyDelay: this.heavyDelay, parryPressed: this.parryPressed, sawStun: this.sawStun, diagnostic: game.diagnostic(this.source) })}`)
      return `native melee/parry timed out at ${this.phase}`
    }
    if (this.phase === 'setupLight' || this.phase === 'setupHeavy' || this.phase === 'setupParry') {
      if (now - this.since < 1.5 || !canAct(game.state, fighter) || !canAct(game.state, victim)) return false
      const hooks = game.frame.players.filter(sample => sample.id === this.source || sample.id === this.target).map(sample => sample.body?.hook)
      if (hooks.some(hook => hook && hookBusy(hook))) return false
      if (fighter.life.kind !== 'alive' || victim.life.kind !== 'alive') return 'melee fixture participant died'
      if (!source.heal(100000) || !target.heal(100000)) return 'native fixture healing unavailable'
      fighter.life.bank = 3; fighter.life.safe = sourcePosition; fighter.life.position = sourcePosition
      victim.life.bank = 3; victim.life.safe = targetPosition; victim.life.position = targetPosition
      source.teleport(sourcePosition, sourceFacing, { x: 0, y: 0, z: 0 })
      target.teleport(targetPosition, targetFacing, { x: 0, y: 0, z: 0 })
      this.release(source, target)
      const phase = this.phase === 'setupLight' ? 'lightReady' : this.phase === 'setupHeavy' ? 'heavyReady' : 'parryReady'
      this.next(phase, now)
      return false
    }
    if (this.phase === 'lightReady' || this.phase === 'heavyReady' || this.phase === 'parryReady') {
      if (now - this.since < 0.4) return false
      this.beforeHealth = targetPawn.health
      this.minimumHealth = targetPawn.health
      this.swings = []; this.parries = []
      const light = this.phase === 'lightReady'
      if (!source.drive({ facing: sourceFacing, forward: 0, left: 0, held: light ? 0n : Buttons.melee, pressed: Buttons.melee })) return 'native melee input refused'
      log(`[BebopWarsProbe] melee input ${JSON.stringify({ phase: this.phase, health: this.beforeHealth, source: sourcePawn.position, target: targetPawn.position })}`)
      this.next(light ? 'light' : this.phase === 'heavyReady' ? 'heavy' : 'parry', now)
      return false
    }
    const elapsed = now - this.since
    if (this.phase === 'light') {
      if (elapsed >= 0.08) source.drive({ facing: sourceFacing, forward: 0, left: 0, held: 0n, pressed: 0n })
      if (targetPawn.health < this.beforeHealth && struck.length) {
        this.lightDamage = this.beforeHealth - targetPawn.health
        if (struck.some(swing => swing.heavy)) return `light melee input was reported as a heavy swing: damage=${this.lightDamage}`
        log(`[BebopWarsProbe] PASS native light melee removed ${this.lightDamage} health; the game reported a light swing on the target`)
        this.release(source, target)
        this.next('setupHeavy', now)
      }
      return false
    }
    if (this.phase === 'heavy') {
      if (targetPawn.health >= this.beforeHealth || !struck.length) return false
      this.release(source, target)
      const damage = this.beforeHealth - targetPawn.health
      if (!struck.some(swing => swing.heavy) || damage <= this.lightDamage) return `charged attack was not verified heavy melee: swings=${JSON.stringify(struck)}, damage=${damage}, light=${this.lightDamage}`
      this.heavyDelay = elapsed
      log(`[BebopWarsProbe] PASS native charged heavy melee removed ${damage} health after ${elapsed.toFixed(3)}s; light=${this.lightDamage}; the game reported a heavy swing on the target`)
      this.next('setupParry', now)
      return false
    }
    if (this.phase === 'parry') {
      this.minimumHealth = Math.min(this.minimumHealth, targetPawn.health)
      if (!this.parryPressed && elapsed >= Math.max(0, this.heavyDelay - 0.25)) {
        if (!target.drive({ facing: targetFacing, forward: 0, left: 0, held: 0n, pressed: Buttons.parry })) return 'native parry input refused'
        this.parryPressed = true
        log(`[BebopWarsProbe] parry input at ${elapsed.toFixed(3)}s; heavy contact measured ${this.heavyDelay.toFixed(3)}s`)
      }
      this.sawStun ||= modifierState(sourcePawn.entity, 'MODIFIER_STATE_STUNNED')
      if (this.minimumHealth < this.beforeHealth) { this.release(source, target); return `native parry did not prevent heavy damage: ${this.beforeHealth} -> ${this.minimumHealth}` }
      if (parried && this.sawStun) {
        this.release(source, target)
        const caught = this.swings.filter(swing => swing.attacker === sourcePawn.entity).map(swing => ({ heavy: swing.heavy, hits: swing.hits.length }))
        log(`[BebopWarsProbe] PASS native parry prevented heavy melee damage and stunned attacker; the game reported the parry; caught swings=${JSON.stringify(caught)}`)
        this.next('release', now)
      }
      return false
    }
    if (this.phase === 'release') {
      if (modifierState(sourcePawn.entity, 'MODIFIER_STATE_STUNNED') || now - this.since < 1.5) return false
      if (fighter.life.kind !== 'alive' || victim.life.kind !== 'alive' || victim.membership.kind !== 'seated') return 'melee fixture cleanup lost participants'
      const side = victim.membership.side, position = { x: 704, y: side === 3 ? 370 : -370, z: 4 }
      victim.life.bank = side; victim.life.safe = position; victim.life.position = position
      target.teleport(position, side === 3 ? targetFacing : sourceFacing, { x: 0, y: 0, z: 0 })
      source.heal(100000); target.heal(100000)
      this.release(source, target)
      return true
    }
    return false
  }

  private next(phase: Phase, now: number): void { this.phase = phase; this.since = now }
  private release(source: Player, target: Player): void {
    source.drive({ facing: sourceFacing, forward: 0, left: 0, held: 0n, pressed: 0n })
    target.drive({ facing: targetFacing, forward: 0, left: 0, held: 0n, pressed: 0n })
  }
}
