import { addBot, log, players } from 'modlock'
import { direction } from './arena.ts'
import type { Game } from './native.ts'
import { freeSeat } from './model.ts'

const route = [{ x: 0, y: 360 }, { x: 704, y: 360 }, { x: 704, y: 256 }]

export class Practice {
  private bot: { slot: number; generation: number } | undefined
  private routeLife = -1
  private routeRound = -1
  private waypoint = 0
  private retryAt = 0

  reset(): void {
    const previous = this.bot
    if (previous) players().find(connection => connection.bot && connection.player.slot === previous.slot && connection.generation === previous.generation)?.player.removeBot()
    this.bot = undefined
    this.routeLife = -1
    this.routeRound = -1
    this.waypoint = 0
    this.retryAt = 0
  }

  tick(game: Game): void {
    if (game.failure || game.frame.now === 0) return
    const connection = players().find(candidate => candidate.bot && candidate.name === 'Practice Bebop')
    if (!connection) {
      this.bot = undefined
      if (game.frame.now < this.retryAt) return
      this.retryAt = game.frame.now + 2
      const seat = freeSeat(game.state)
      if (seat.kind === 'watching') return
      if (addBot({ name: 'Practice Bebop', team: seat.side, hero: 'hero_bebop' })) log('[BebopWars] Practice opponent added. Open Shop with your shop binding, then ready up.')
      return
    }
    if (this.bot?.slot !== connection.player.slot || this.bot.generation !== connection.generation) {
      this.bot = { slot: connection.player.slot, generation: connection.generation }
      this.routeLife = -1
      this.routeRound = -1
      this.waypoint = 0
    }
    const bot = connection.player
    const sample = game.frame.players.find(player => player.bot && player.slot === connection.player.slot && player.generation === connection.generation)
    const fighter = sample && game.state.fighters.get(sample.id)
    if (!fighter || fighter.membership.kind !== 'seated') return
    if (game.state.phase.kind === 'warmup' && !fighter.ready) game.request(fighter.id, { kind: 'ready' })
    const side = fighter.membership.side
    const facing = { pitch: 0, yaw: side === 3 ? 270 : 90, roll: 0 }
    if (this.routeLife !== fighter.serial || this.routeRound !== game.state.round) {
      this.routeLife = fighter.serial
      this.routeRound = game.state.round
      this.waypoint = 0
    }
    if (fighter.life.kind !== 'alive' || fighter.life.protectionUntil > game.frame.now ||
      fighter.life.bank !== side || fighter.life.transit.kind !== 'none' || fighter.menu !== 'closed' ||
      game.state.phase.kind === 'countdown' || game.state.phase.kind === 'results') {
      bot.drive({ facing, forward: 0, left: 0, held: 0n, pressed: 0n })
      return
    }
    const position = fighter.life.position
    let target = route[this.waypoint]
    while (target && Math.hypot(target.x - position.x, direction(side) * target.y - position.y) < 18) {
      this.waypoint++
      target = route[this.waypoint]
    }
    if (target) facing.yaw = Math.atan2(direction(side) * target.y - position.y, target.x - position.x) * 180 / Math.PI
    bot.drive({ facing, forward: target ? 1 : 0, left: 0, held: 0n, pressed: 0n })
  }
}
