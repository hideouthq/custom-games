import { log, modifierState, readModifierField, type Player } from 'modlock'
import { catalog, type Group, type ProductId } from '../catalog.ts'
import { nativeItemButton } from '../native-equipment.ts'
import { deadlineOf, type AccountId } from '../model.ts'
import type { Game } from '../native.ts'

type Cast = Exclude<ProductId, 'snowGlobe' | 'sprint' | 'echo'>
interface Step { readonly product: Cast; readonly facing: 'enemy' | 'away' | 'teammate'; readonly expect: 'cast' | 'miss'; readonly modifier?: { readonly name: string; readonly on: 'self' | 'enemy' | 'teammate' }; readonly settle: number; readonly pitch?: number; readonly stunned?: boolean }

const budget = 3000

export class ItemProbe {
  private phase: 'start' | 'buy' | 'bought' | 'place' | 'press' | 'check' = 'start'
  private since = 0
  private index = 0
  private pressedAt = 0
  private ally: Player | undefined
  private sawModifier = false
  private startedAfter: number | undefined
  private readonly steps: Step[]

  constructor(private readonly source: AccountId, private readonly victim: AccountId, teamSize: number) {
    this.steps = [
      { product: 'etherealShift', facing: 'enemy', expect: 'cast', modifier: { name: 'upgrade_self_bubble/modifier_citadel_bubble', on: 'self' }, settle: 0.6 },
      { product: 'knockdown', facing: 'away', expect: 'miss', settle: 0.5 },
      { product: 'knockdown', facing: 'enemy', expect: 'cast', modifier: { name: 'upgrade_target_stun/modifier_citadel_delayed_stun', on: 'enemy' }, stunned: true, settle: 2.3 },
      { product: 'piano', facing: 'enemy', pitch: 10, expect: 'cast', stunned: true, settle: 2 },
      { product: 'shrinkRay', facing: 'enemy', expect: 'cast', modifier: { name: 'upgrade_shrink_ray/modifier_shrink_ray', on: 'self' }, settle: 0.6 },
      ...(teamSize > 1 ? [{ product: 'rescueBeam', facing: 'teammate', expect: 'cast', modifier: { name: 'upgrade_rescue_beam/modifier_citadel_rescue_beam', on: 'teammate' }, settle: 3.6 } satisfies Step] : []),
    ]
  }

  tick(game: Game, now: number): false | true | string {
    const player = game.player(this.source), target = game.player(this.victim)
    const fighter = game.state.fighters.get(this.source)
    if (!player || !target || !fighter) return 'item participants disappeared'
    const pawn = player.pawn(), targetPawn = target.pawn()
    if (!pawn || !targetPawn) return false
    const step = this.steps[this.index]
    if (!step) return true
    const item = catalog[step.product], group: Group = item.group
    switch (this.phase) {
      case 'start':
        if (!player.adjustSouls(budget - pawn.souls, true)) return 'item fixture could not set its budget'
        this.shop(player)
        this.phase = 'buy'; this.since = now
        log(`[BebopWarsProbe] Item fixture starts with ${budget} Souls; purchases use real shop requests and presses use the real item keys`)
        return false
      case 'buy':
        if (now - this.since < 0.4) return false
        if (!fighter.progression.owned.includes(step.product)) {
          this.shop(player)
          game.request(this.source, { kind: 'shop' })
          game.request(this.source, { kind: 'buy', product: step.product })
          game.request(this.source, { kind: 'close' })
        } else game.request(this.source, { kind: 'equip', utility: step.product })
        this.phase = 'bought'; this.since = now
        return false
      case 'bought':
        if (now - this.since < 0.6) return false
        if (fighter.progression[group] !== step.product) return `${item.name} was not bought and equipped: ${JSON.stringify(fighter.progression)}; notice=${fighter.notice.text}`
        if (this.button(player, step.product) === undefined) return `${item.name} has no native active slot`
        this.phase = 'place'; this.since = now
        return false
      case 'place': {
        if (now - this.since < 0.2) return false
        if (deadlineOf(fighter, group) > now) return false
        const yaw = step.facing === 'away' ? 90 : 270
        if (step.facing === 'teammate') {
          const mate = game.frame.players.find(sample => sample.id !== this.source && sample.body?.side === pawn.team)
          const ally = mate && game.player(mate.id)
          if (!ally) return 'Rescue Beam has no teammate to target'
          this.ally = ally
          player.teleport({ x: 704, y: 256, z: 4 }, { pitch: 0, yaw: 90, roll: 0 }, { x: 0, y: 0, z: 0 })
          ally.teleport({ x: 704, y: 420, z: 4 }, { pitch: 0, yaw: 270, roll: 0 }, { x: 0, y: 0, z: 0 })
          this.drive(player, 90)
        } else {
          player.teleport({ x: 704, y: 256, z: 4 }, { pitch: 0, yaw, roll: 0 }, { x: 0, y: 0, z: 0 })
          target.teleport({ x: 704, y: -260, z: 4 }, { pitch: 0, yaw: 90, roll: 0 }, { x: 0, y: 0, z: 0 })
          this.drive(player, yaw, 0n, step.pitch)
        }
        this.phase = 'press'; this.since = now
        return false
      }
      case 'press': {
        if (now - this.since < 0.5) return false
        const button = this.button(player, step.product)
        if (button === undefined) return `${item.name} lost its native active slot`
        this.drive(player, step.facing === 'away' || step.facing === 'teammate' ? 90 : 270, button, step.pitch)
        this.pressedAt = now; this.sawModifier = false; this.startedAfter = undefined
        this.phase = 'check'; this.since = now
        return false
      }
      case 'check': {
        const native = player.abilities().find(ability => ability.name === item.nativeItem)
        if (this.startedAfter === undefined && native && native.cooldownEnd > now) this.startedAfter = now - this.pressedAt
        if (step.modifier) {
          const holder = step.modifier.on === 'self' ? pawn.entity : step.modifier.on === 'enemy' ? targetPawn.entity : this.ally?.pawn()?.entity
          this.sawModifier ||= holder !== undefined && typeof readModifierField(holder, step.modifier.name, 'CBaseModifier', 'm_hAbility', 'handle') === 'number'
        }
        if (now - this.since < step.settle) return false
        const deadline = deadlineOf(fighter, group)
        const held = deadline > now + item.cooldown - step.settle - 1
        const describe = `deadline=${(deadline - now).toFixed(1)}s native=${native ? (native.cooldownEnd - now).toFixed(1) : 'none'}s notice=${fighter.notice.text} nativeStartedAfter=${this.startedAfter?.toFixed(2)}`
        if (step.expect === 'miss') {
          if (held) return `${item.name} kept its cooldown after a press with no target: ${describe}`
          log(`[BebopWarsProbe] PASS ${item.name} with no target gives its cooldown back`)
        } else {
          if (!held) return `${item.name} did not cast from its key: ${describe}`
          if (!native || Math.abs(native.cooldownEnd - deadline) > 0.6) return `${item.name} native cooldown does not match the mode's: ${describe}`
          if (step.modifier && !this.sawModifier) return `${item.name} cast but ${step.modifier.name} never reached ${step.modifier.on}: ${describe}`
          if (step.stunned && !modifierState(targetPawn.entity, 'MODIFIER_STATE_STUNNED')) return `${item.name} landed but the enemy is not stunned: ${describe}`
          log(`[BebopWarsProbe] PASS ${item.name} cast from its key ${(now - this.pressedAt).toFixed(2)}s ago with a ${item.cooldown}s cooldown${step.modifier ? ` and ${step.modifier.name} on ${step.modifier.on}` : ''}${step.stunned ? ' and the enemy stunned' : ''}`)
        }
        this.drive(player, 270)
        if (step.facing === 'teammate') this.ally?.teleport({ x: -200, y: 984, z: 104 }, { pitch: 0, yaw: 270, roll: 0 }, { x: 0, y: 0, z: 0 })
        this.index++
        this.phase = 'buy'; this.since = now
        return this.index >= this.steps.length
      }
    }
  }

  private button(player: Player, product: ProductId): bigint | undefined {
    const item = player.abilities().find(ability => ability.name === catalog[product].nativeItem)
    return item === undefined ? undefined : nativeItemButton(item.slot)
  }

  private shop(player: Player): void {
    player.teleport({ x: -120, y: 984, z: 104 }, { pitch: 0, yaw: 0, roll: 0 }, { x: 0, y: 0, z: 0 })
  }

  private drive(player: Player, yaw: number, pressed = 0n, pitch = 0): void {
    player.drive({ facing: { pitch, yaw, roll: 0 }, forward: 0, left: 0, held: 0n, pressed })
  }
}
