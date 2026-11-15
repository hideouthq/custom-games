import { Buttons, log, modifierState, readModifierField, type Player } from 'modlock'
import { catalog, economy, type ProductId } from '../catalog.ts'
import { nativeItemButton } from '../native-equipment.ts'
import type { AccountId } from '../model.ts'
import { chillModifier, type Game } from '../native.ts'

export class EquipmentProbe {
  private phase: 'start' | 'buy' | 'buyGlobe' | 'purchased' | 'baseline' | 'sprint' | 'expiry' | 'expired' | 'snowGlobeSetup' | 'snowGlobe' | 'chillRelease' | 'shop' | 'choose' | 'die' | 'respawn' | 'missSetup' | 'miss' | 'echo' = 'start'
  private since = 0
  private baseline = 0
  private boosted = 0
  private initialLife = 0
  private sawFlight = false
  private sawChill = false
  private detonated = false
  private sawCast = false
  private purchaseTicks = 0

  constructor(private readonly source: AccountId, private readonly victim: AccountId) {}

  tick(game: Game, now: number): false | true | string {
    const player = game.player(this.source), target = game.player(this.victim)
    const fighter = game.state.fighters.get(this.source), enemy = game.state.fighters.get(this.victim)
    if (!player || !target || !fighter || !enemy) return 'equipment participants disappeared'
    const pawn = player.pawn(), targetPawn = target.pawn()
    if (!pawn || !targetPawn) return false
    const speed = Math.hypot(pawn.velocity.x, pawn.velocity.y)
    switch (this.phase) {
      case 'start':
        for (const sample of game.frame.players) {
          if (sample.id === this.source || sample.id === this.victim || !sample.body) continue
          const spectator = game.player(sample.id)
          const north = sample.body.side === 3
          spectator?.teleport({ x: -800 + sample.slot * 32, y: north ? 984 : -984, z: 104 }, { pitch: 0, yaw: north ? 270 : 90, roll: 0 }, { x: 0, y: 0, z: 0 })
          if (spectator) this.drive(spectator, north ? 270 : 90, 0)
        }
        if (!player.adjustSouls(2300 - pawn.souls, true)) return 'native equipment fixture could not set test budget'
        this.upper(player)
        this.drive(player, 0, 0)
        this.phase = 'buy'; this.since = now
        log('[BebopWarsProbe] Equipment fixture starts with 2300 Souls; purchases use real shop requests')
        return false
      case 'buy':
        if (now - this.since < 0.3) return false
        if (pawn.souls < 2300 || (pawn.souls > 2300 && !player.adjustSouls(2300 - pawn.souls, true))) return 'native test budget could not be normalized'
        this.purchaseTicks = fighter.income.passiveTicks
        game.request(this.source, { kind: 'shop' })
        game.request(this.source, { kind: 'buy', product: 'sprint' })
        game.request(this.source, { kind: 'buy', product: 'sprint' })
        game.request(this.source, { kind: 'close' })
        this.phase = 'buyGlobe'; this.since = now
        return false
      case 'buyGlobe':
        if (now - this.since < 0.3) return false
        if (!fighter.progression.owned.includes('sprint') || pawn.souls !== 2000 + (fighter.income.passiveTicks - this.purchaseTicks) * economy.passive) return 'Sprint purchase did not debit exactly once'
        game.request(this.source, { kind: 'buy', product: 'snowGlobe' })
        game.request(this.source, { kind: 'buy', product: 'snowGlobe' })
        this.phase = 'purchased'; this.since = now
        return false
      case 'purchased':
        if (now - this.since < 0.3) return false
        if (!fighter.progression.owned.includes('sprint') || !fighter.progression.owned.includes('snowGlobe') || pawn.souls !== 1700 + (fighter.income.passiveTicks - this.purchaseTicks) * economy.passive) return `equipment purchase failed: ${JSON.stringify(fighter.progression)}`
        log('[BebopWarsProbe] PASS native shop requests bought Sprint and Snow Globe; duplicate click charged once')
        this.course(player)
        this.drive(player, 0, 1)
        this.phase = 'baseline'; this.since = now
        return false
      case 'baseline':
        if (now - this.since < 2.2) return false
        this.baseline = speed
        if (speed < 80) return `Sprint baseline is obstructed: ${speed.toFixed(1)} units/s`
        this.course(player)
        {
          const button = this.itemButton(player, 'sprint')
          if (button === undefined) return 'purchased Sprint has no native active slot'
          this.drive(player, 0, 1, button)
        }
        this.phase = 'sprint'; this.since = now
        return false
      case 'sprint':
        if (now - this.since < 2.2) return false
        this.boosted = speed
        if (fighter.utilityUntil < now + 12) return 'native utility key did not activate scripted Sprint'
        if (speed < this.baseline + 50) return `Sprint gave no movement increase: ${this.baseline.toFixed(1)} -> ${speed.toFixed(1)}`
        this.drive(player, 0, 0)
        this.phase = 'expiry'
        return false
      case 'expiry':
        if (now - this.since < 3.4) return false
        this.course(player)
        this.drive(player, 0, 1)
        this.phase = 'expired'; this.since = now
        return false
      case 'expired':
        if (now - this.since < 2.2) return false
        if (speed > this.baseline + 20) return `Sprint did not expire: baseline ${this.baseline.toFixed(1)}, expired ${speed.toFixed(1)}`
        log(`[BebopWarsProbe] PASS native Sprint speed ${this.baseline.toFixed(1)} -> ${this.boosted.toFixed(1)} -> ${speed.toFixed(1)} after three seconds`)
        this.drive(player, 270, 0)
        player.teleport({ x: 704, y: 256, z: 4 }, { pitch: 0, yaw: 270, roll: 0 }, { x: 0, y: 0, z: 0 })
        target.teleport({ x: 704, y: -260, z: 4 }, { pitch: 0, yaw: 90, roll: 0 }, { x: 0, y: 0, z: 0 })
        this.drive(target, 90, 0)
        this.phase = 'snowGlobeSetup'; this.since = now
        return false
      case 'snowGlobeSetup': {
        if (now - this.since < 0.4) return false
        const delta = { x: targetPawn.position.x - pawn.eyePosition.x, y: targetPawn.position.y - pawn.eyePosition.y, z: targetPawn.position.z + 40 - pawn.eyePosition.z }
        const yaw = Math.atan2(delta.y, delta.x) * 180 / Math.PI
        const pitch = -Math.atan2(delta.z, Math.hypot(delta.x, delta.y)) * 180 / Math.PI
        const button = this.itemButton(player, 'snowGlobe')
        if (button === undefined) return 'purchased Snow Globe has no native active slot'
        player.drive({ facing: { pitch, yaw, roll: 0 }, forward: 0, left: 0, held: 0n, pressed: button })
        this.phase = 'snowGlobe'; this.since = now
        return false
      }
      case 'snowGlobe': {
        const globe = game.state.globes.find(effect => effect.actor.id === this.source)
        this.sawFlight ||= globe !== undefined
        if (globe && !this.detonated && Math.hypot(globe.position.x - targetPawn.position.x, globe.position.y - targetPawn.position.y, globe.position.z - targetPawn.position.z - 40) < 45) {
          const button = this.itemButton(player, 'snowGlobe')
          if (button === undefined) return 'flying Snow Globe lost its native active slot'
          player.drive({ facing: pawn.eyeAngles, forward: 0, left: 0, held: 0n, pressed: button })
          this.detonated = true
        }
        this.sawChill ||= typeof readModifierField(targetPawn.entity, chillModifier, 'CBaseModifier', 'm_hAbility', 'handle') === 'number' && enemy.chillUntil > now
        if (this.sawChill) {
          if (!this.sawFlight) return 'Snow Globe had no observed flight'
          if (modifierState(targetPawn.entity, 'MODIFIER_STATE_IMMOBILIZED')) return 'Snow Globe immobilized instead of slowing'
          this.phase = 'chillRelease'; this.since = now
        } else if (now - this.since > 2) return `Snow Globe did not chill target: flight=${this.sawFlight}, setupUntil=${fighter.setupUntil}, notice=${fighter.notice.text}`
        return false
      }
      case 'chillRelease':
        if (now - this.since < 1.3) return false
        if (typeof readModifierField(targetPawn.entity, chillModifier, 'CBaseModifier', 'm_hAbility', 'handle') === 'number') return 'Snow Globe chill did not expire'
        log('[BebopWarsProbe] PASS native Snow Globe flight, manual detonation, chill and expiry through native item binding')
        this.upper(player)
        this.drive(player, 0, 0)
        this.phase = 'shop'; this.since = now
        return false
      case 'shop':
        if (now - this.since < 0.2) return false
        game.request(this.source, { kind: 'shop' })
        this.phase = 'choose'; this.since = now
        return false
      case 'choose':
        if (fighter.menu !== 'loadout') return now - this.since > 1 ? 'loadout shop did not open in spawn' : false
        game.request(this.source, { kind: 'buy', product: 'echo' })
        game.request(this.source, { kind: 'close' })
        this.phase = 'die'; this.since = now
        return false
      case 'die':
        if (fighter.progression.utility !== 'echo') return false
        if (!fighter.progression.owned.includes('sprint')) return 'buying Echo lost owned Sprint'
        this.initialLife = fighter.serial
        player.kill()
        this.phase = 'respawn'; this.since = now
        return false
      case 'respawn':
        if (fighter.serial <= this.initialLife || fighter.life.kind !== 'alive' || fighter.utilityUntil > now || fighter.life.protectionUntil > now) return false
        if (fighter.progression.utility !== 'echo') return 'purchased Echo did not survive respawn'
        player.teleport({ x: -704, y: 256, z: 4 }, { pitch: 0, yaw: 0, roll: 0 }, { x: 0, y: 0, z: 0 })
        this.drive(player, 0, 0)
        this.phase = 'missSetup'; this.since = now
        return false
      case 'missSetup':
        if (now - this.since < 0.3) return false
        this.sawCast = false
        this.drive(player, 0, 0, Buttons.ability3)
        this.phase = 'miss'; this.since = now
        return false
      case 'miss': {
        const hook = game.frame.players.find(p => p.id === this.source)?.body?.hook
        this.sawCast ||= hook?.executed === true
        if (hook && this.sawCast && !hook.casting && hook.victim === undefined && hook.cooldownEnd > now + 0.2) {
          const button = this.itemButton(player, 'echo')
          if (button === undefined) return 'purchased Echo has no native active slot'
          this.drive(player, 0, 0, button)
          this.phase = 'echo'; this.since = now
        } else if (now - this.since > 4) return 'Echo setup did not produce an idle hook on cooldown'
        return false
      }
      case 'echo': {
        if (now - this.since < 0.2) return false
        const hook = game.frame.players.find(p => p.id === this.source)?.body?.hook
        if (fighter.utilityUntil < now + 19 || !hook || hook.cooldownEnd > now) return 'Echo did not refresh only the finished Hook'
        log('[BebopWarsProbe] PASS native Echo after a real missed hook, with twenty-second utility cooldown')
        return true
      }
    }
  }

  private itemButton(player: Player, product: ProductId): bigint | undefined {
    const item = player.abilities().find(ability => ability.name === catalog[product].nativeItem)
    return item === undefined ? undefined : nativeItemButton(item.slot)
  }

  private upper(player: Player): void {
    player.teleport({ x: -120, y: 984, z: 104 }, { pitch: 0, yaw: 0, roll: 0 }, { x: 0, y: 0, z: 0 })
  }

  private course(player: Player): void {
    player.teleport({ x: -600, y: 720, z: 104 }, { pitch: 0, yaw: 0, roll: 0 }, { x: 0, y: 0, z: 0 })
  }

  private drive(player: Player, yaw: number, forward: number, pressed = 0n): void {
    player.drive({ facing: { pitch: 0, yaw, roll: 0 }, forward, left: 0, held: 0n, pressed })
  }
}
