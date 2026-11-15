import { addBot, Buttons, log, modifierState, serverCommand, type MeleeEvent, type ParryEvent, type Player } from 'modlock'
import { hookBusy, type AccountId } from '../model.ts'
import type { Game } from '../native.ts'
import { TierProbe } from './tier-probe.ts'
import { MeleeProbe } from './melee-probe.ts'
import { EquipmentProbe } from './equipment-probe.ts'
import { ItemProbe } from './item-probe.ts'
import { distance, spawn } from '../arena.ts'
import { economy } from '../catalog.ts'

type Phase = 'seating' | 'ready' | 'cast' | 'land' | 'second' | 'kill' | 'respawn' | 'rescueSetup' | 'rescueCast' | 'rescuePull' | 'save' | 'released' | 'incomeIdle' | 'melee' | 'equipment' | 'items' | 'tiers' | 'done'

export class Probe {
  private phase: Phase = 'seating'
  private since = 0
  private deadline = 0
  private bots: Player[] = []
  private source: AccountId | undefined
  private victim: AccountId | undefined
  private rescuer: AccountId | undefined
  private caught = false
  private victimLife = 0
  private respawnObservedAt: number | undefined
  private beforeSouls = 0
  private beforePassiveTicks = 0
  private wallets = new Map<AccountId, { souls: number; ticks: number }>()
  private idleKilled = false
  private idlePaid = false
  private equipment: EquipmentProbe | undefined
  private melee: MeleeProbe | undefined
  private items: ItemProbe | undefined
  private tiers: TierProbe | undefined
  private traced = false

  reset(): void {
    this.phase = 'seating'; this.since = 0; this.deadline = 0; this.bots = []
    this.source = undefined; this.victim = undefined; this.rescuer = undefined
    this.wallets.clear(); this.idleKilled = false; this.idlePaid = false
    this.caught = false; this.victimLife = 0; this.respawnObservedAt = undefined; this.beforeSouls = 0; this.beforePassiveTicks = 0; this.equipment = undefined; this.melee = undefined; this.items = undefined; this.tiers = undefined; this.traced = false
  }

  swing(event: MeleeEvent): void { if (this.phase === 'melee') this.melee?.swing(event) }
  parried(event: ParryEvent): void { if (this.phase === 'melee') this.melee?.parried(event) }

  tick(game: Game, now: number): void {
    if (this.phase === 'done') return
    if (!this.deadline) this.deadline = now + 240
    if (game.failure) { this.finish(false, game.failure); return }
    if (now > this.deadline) { this.finish(false, `timed out at ${this.phase}`); return }
    if (this.phase === 'seating') {
      if (game.frame.now === 0) return
      for (let index = 0; index < game.state.config.teamSize * 2; index++) {
        const bot = addBot({ name: `BebopProbe${index + 1}`, team: index % 2 ? 2 : 3, hero: 'hero_bebop' })
        if (!bot) { this.finish(false, 'native bot creation failed'); return }
        this.bots.push(bot)
      }
      this.next('ready', now)
      return
    }
    if (this.phase === 'ready') {
      for (const bot of this.bots) this.still(bot)
      if (game.state.phase.kind !== 'live') return
      const fighters = [...game.state.fighters.values()].filter(p => p.life.kind === 'alive' && p.membership.kind === 'seated')
      this.source = fighters.find(p => p.membership.kind === 'seated' && p.membership.side === 3)?.id
      const south = fighters.filter(p => p.membership.kind === 'seated' && p.membership.side === 2)
      this.victim = south[0]?.id; this.rescuer = south[1]?.id
      if (!this.source || !this.victim) return
      this.place(game, this.source, 704, 400)
      this.place(game, this.victim, 704, -400)
      if (this.rescuer) this.place(game, this.rescuer, -704, -500)
      this.next('cast', now)
      return
    }
    if (!this.source || !this.victim) { this.finish(false, 'probe participants missing'); return }
    const source = game.state.fighters.get(this.source), victim = game.state.fighters.get(this.victim)
    const sourceBody = game.frame.players.find(p => p.id === this.source)?.body
    const victimBody = game.frame.players.find(p => p.id === this.victim)?.body
    const hook = sourceBody?.hook
    if (!source || !victim || !sourceBody || !victimBody) return
    if ((this.phase === 'second' || this.phase === 'kill') && now - this.since >= 8 && !this.traced) {
      this.traced = true
      log(`[BebopWarsProbe] second Hook diagnostic ${JSON.stringify({ phase: this.phase, elapsed: now - this.since, source: sourceBody, victim: victimBody, sourceLife: source.life, victimLife: victim.life, diagnostic: game.diagnostic(this.source) })}`)
    }
    if ((this.phase === 'second' || this.phase === 'kill') && now - this.since >= 15) {
      this.finish(false, `second Hook timed out in ${this.phase}`)
      return
    }
    switch (this.phase) {
      case 'cast':
        if (now - this.since < 1.5) return
        this.victimLife = victim.serial
        this.cast(game, this.source, this.victim)
        this.next('land', now)
        break
      case 'land':
        this.caught ||= hook?.victim === this.victim
        if (this.caught && victim.life.kind === 'alive' && victim.life.bank === 3 && victim.life.transit.kind === 'none') {
          if (game.state.score[3] !== 0 || victimBody.health <= 0 || victimBody.health >= victimBody.maxHealth) { this.finish(false, 'first native Hook did not land a living damaged enemy without scoring'); return }
          log(`[BebopWarsProbe] PASS first Hook lands enemy alive on enemy bank, health=${victimBody.health}/${victimBody.maxHealth}`)
          this.place(game, this.source, 704, 256)
          this.next('second', now)
        }
        break
      case 'second':
        if (!hook || hookBusy(hook) || hook.cooldownEnd > now || now - this.since < 0.4) return
        this.beforeSouls = game.player(this.source)?.pawn()?.souls ?? sourceBody.souls
        this.beforePassiveTicks = source.income.passiveTicks
        this.snapshotWallets(game)
        this.cast(game, this.source, this.victim)
        this.next('kill', now)
        break
      case 'kill':
        if (game.state.score[3] !== 1) return
        if (victim.life.kind !== 'dead' || source.kills !== 1) { this.finish(false, 'second Hook score lacks one native death'); return }
        if (source.income.pending > 0) return
        {
          const wallet = game.player(this.source)?.pawn()?.souls
          const passive = (source.income.passiveTicks - this.beforePassiveTicks) * economy.passive
          if (wallet === undefined || wallet - this.beforeSouls - passive !== economy.kill) { this.finish(false, `kill reward must be exactly 100 after separating passive ${passive}: ${this.beforeSouls} -> ${wallet}`); return }
          log(`[BebopWarsProbe] PASS native kill reward exactly100 Souls; passive=${passive}; wallet=${this.beforeSouls}->${wallet}`)
        }
        {
          const mismatch = this.walletMismatch(game, id => id === this.source ? economy.kill : game.state.fighters.get(id)?.membership.kind === 'seated' && game.frame.players.find(p => p.id === id)?.body?.side === sourceBody.side ? economy.teamKill : 0)
          if (mismatch) { this.finish(false, mismatch); return }
          log('[BebopWarsProbe] PASS killer100, teammates50 and opponents0 with passive income isolated for every participant')
        }
        log('[BebopWarsProbe] PASS second native Hook kills and scores once')
        this.next('respawn', now)
        break
      case 'respawn': {
        const elapsed = now - this.since
        if (elapsed > 6) {
          log(`[BebopWarsProbe] respawn timeout ${JSON.stringify({ elapsed, actual: victimBody.position, life: victim.life })}`)
          this.finish(false, 'native death missed bounded shop respawn')
          return
        }
        if (victim.serial === this.victimLife || victim.life.kind !== 'alive' || victim.membership.kind !== 'seated') return
        const expected = spawn(victim.membership.side, victim.membership.seat, game.state.config.teamSize)
        if (this.respawnObservedAt === undefined) {
          this.respawnObservedAt = now
          log(`[BebopWarsProbe] respawn deployment ${JSON.stringify({ elapsed, observed: victimBody.position, native: game.player(this.victim)?.pawn()?.position, expected })}`)
          return
        }
        if (now <= this.respawnObservedAt) return
        if (distance(victimBody.position, expected) > 16 || elapsed < 3.8) {
          log(`[BebopWarsProbe] respawn position mismatch ${JSON.stringify({ elapsed, actual: victimBody.position, expected })}`)
          this.finish(false, 'native death missed four-second shop respawn')
          return
        }
        const wallet = game.player(this.source)?.pawn()?.souls
        if (game.state.score[3] !== 1 || wallet === undefined || wallet - this.beforeSouls !== economy.kill + (source.income.passiveTicks - this.beforePassiveTicks) * economy.passive) { this.finish(false, 'unexpected native income after kill and shop respawn'); return }
        log(`[BebopWarsProbe] PASS shop respawn, single score and native wallet ${this.beforeSouls} -> ${wallet}`)
        if (this.rescuer) this.next('rescueSetup', now)
        else { log('[BebopWarsProbe] NOT APPLICABLE teammate rescue in 1v1'); this.startIdleIncome(game, now) }
        break
      }
      case 'rescueSetup':
        if (now - this.since < 1.5 || !this.rescuer || !hook || hook.cooldownEnd > now) return
        this.place(game, this.source, 704, 256)
        this.place(game, this.victim, 704, -224)
        this.place(game, this.rescuer, 704, -316)
        this.next('rescueCast', now)
        break
      case 'rescueCast':
        if (now - this.since < 0.5) return
        this.snapshotWallets(game)
        this.cast(game, this.source, this.victim)
        this.next('rescuePull', now)
        break
      case 'rescuePull':
        if (!this.rescuer || hook?.victim !== this.victim || victimBody.position.y <= -190) return
        this.cast(game, this.rescuer, this.victim)
        this.next('save', now)
        break
      case 'save': {
        const rescuer = this.rescuer && game.state.fighters.get(this.rescuer)
        if (!rescuer || rescuer.saves !== 1 || victim.life.kind !== 'alive' || victim.life.bank !== 2 || victim.life.transit.kind !== 'none') return
        if (game.state.score[3] !== 1 || game.state.score[2] !== 0) { this.finish(false, 'rescue changed kill score'); return }
        if (rescuer.income.pending > 0) return
        const mismatch = this.walletMismatch(game, id => id === this.rescuer ? economy.rescue : 0)
        if (mismatch) { this.finish(false, mismatch); return }
        log('[BebopWarsProbe] PASS verified rescue pays exactly25 only to the rescuer')
        log('[BebopWarsProbe] PASS friendly rehook returns victim alive with one save and no kill point')
        this.next('released', now)
        break
      }
      case 'released': {
        if (now - this.since < 2) return
        const pawn = game.player(this.victim)?.pawn()
        if (!pawn || modifierState(pawn.entity, 'MODIFIER_STATE_STUNNED') || victim.life.kind !== 'alive' || victim.life.transit.kind !== 'none') { this.finish(false, 'rescued player did not regain control'); return }
        const mismatch = this.walletMismatch(game, id => id === this.rescuer ? economy.rescue : 0)
        if (mismatch) { this.finish(false, mismatch); return }
        this.startIdleIncome(game, now)
        break
      }
      case 'incomeIdle': {
        const baseline = this.wallets.get(this.victim)
        if (!baseline) { this.finish(false, 'idle income baseline missing'); return }
        const nextTick = (baseline.ticks + 1) * economy.passiveSeconds
        if (!this.idleKilled && nextTick - game.state.liveSeconds <= 1) {
          if (!game.player(this.victim)?.kill()) { this.finish(false, 'passive income death fixture failed'); return }
          this.idleKilled = true
        }
        if (!this.idlePaid && game.state.liveSeconds >= nextTick) {
          if (victim.life.kind !== 'dead') { this.finish(false, 'passive tick did not observe dead participant'); return }
          const mismatch = this.walletMismatch(game, () => 0)
          if (mismatch) { this.finish(false, mismatch); return }
          for (const [id, before] of this.wallets) {
            if (game.player(id)?.pawn()?.souls !== before.souls + economy.passive) { this.finish(false, `idle tick must pay exactly25 to ${id}`); return }
          }
          this.idlePaid = true
          log('[BebopWarsProbe] PASS one live10s interval pays exactly25 to every participant, including a dead player')
        }
        if (this.idlePaid && victim.life.kind === 'alive' && victim.life.protectionUntil <= now) this.startMelee(now)
        break
      }
      case 'melee': {
        const result = this.melee?.tick(game, now)
        if (result === true) {
          this.equipment = new EquipmentProbe(this.source, this.victim)
          this.next('equipment', now)
        } else if (typeof result === 'string') this.finish(false, result)
        break
      }
      case 'equipment': {
        const result = this.equipment?.tick(game, now)
        if (result === true) {
          this.items = new ItemProbe(this.source, this.victim, game.state.config.teamSize)
          this.next('items', now)
        } else if (typeof result === 'string') this.finish(false, result)
        break
      }
      case 'items': {
        const result = this.items?.tick(game, now)
        if (result === true) {
          this.tiers = new TierProbe(this.source, this.victim)
          this.next('tiers', now)
        } else if (typeof result === 'string') this.finish(false, result)
        break
      }
      case 'tiers': {
        const result = this.tiers?.tick(game, now)
        if (result === true) this.finish(true, `complete teams=${game.state.config.teamSize}v${game.state.config.teamSize}`)
        else if (typeof result === 'string') this.finish(false, result)
        break
      }
    }
  }

  private next(phase: Phase, now: number): void { this.phase = phase; this.since = now; this.traced = false }
  private snapshotWallets(game: Game): void {
    this.wallets.clear()
    for (const sample of game.frame.players) {
      const fighter = game.state.fighters.get(sample.id), pawn = game.player(sample.id)?.pawn()
      if (fighter?.membership.kind === 'seated' && pawn) this.wallets.set(sample.id, { souls: pawn.souls, ticks: fighter.income.passiveTicks })
    }
  }
  private walletMismatch(game: Game, reward: (id: AccountId) => number): string | undefined {
    for (const [id, before] of this.wallets) {
      const fighter = game.state.fighters.get(id), pawn = game.player(id)?.pawn()
      if (!fighter || !pawn) return `native wallet unavailable for ${id}`
      const expected = before.souls + reward(id) + (fighter.income.passiveTicks - before.ticks) * economy.passive
      if (fighter.income.pending !== 0 || pawn.souls !== expected) return `unexpected reward for ${id}: expected=${expected}, actual=${pawn.souls}, pending=${fighter.income.pending}`
    }
    return undefined
  }
  private startIdleIncome(game: Game, now: number): void {
    this.snapshotWallets(game)
    this.idleKilled = false; this.idlePaid = false
    this.next('incomeIdle', now)
  }
  private startMelee(now: number): void {
    if (!this.source || !this.victim) return
    this.melee = new MeleeProbe(this.source, this.victim)
    this.next('melee', now)
  }
  private place(game: Game, id: AccountId, x: number, y: number): void {
    const player = game.player(id)
    player?.teleport({ x, y, z: 4 }, { pitch: 0, yaw: y > 0 ? 270 : 90, roll: 0 }, { x: 0, y: 0, z: 0 })
    if (player) this.still(player)
  }
  private still(player: Player): void { player.drive({ facing: player.pawn()?.eyeAngles ?? { pitch: 0, yaw: 0, roll: 0 }, forward: 0, left: 0, held: 0n, pressed: 0n }) }
  private cast(game: Game, id: AccountId, targetId: AccountId): void {
    const player = game.player(id), from = player?.pawn()?.eyePosition, to = game.player(targetId)?.pawn()?.eyePosition
    if (!player || !from || !to) return
    const facing = { yaw: Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI, pitch: -Math.atan2(to.z - from.z, Math.hypot(to.x - from.x, to.y - from.y)) * 180 / Math.PI, roll: 0 }
    const accepted = player.drive({ facing, forward: 0, left: 0, held: 0n, pressed: Buttons.ability3 })
    log(`[BebopWarsProbe] cast ${JSON.stringify({ phase: this.phase, id, targetId, from, to, facing, accepted })}`)
  }
  private finish(passed: boolean, message: string): void {
    this.phase = 'done'
    log(`[BebopWarsProbe] ${passed ? 'PASS' : 'FAIL'} ${message}`)
    log('[BebopWarsProbe] UNTESTED human latency, native upgrade controls, simultaneous rehooks and clean guest installation')
    for (const player of this.bots) player.drive()
    serverCommand('quit')
  }
}
