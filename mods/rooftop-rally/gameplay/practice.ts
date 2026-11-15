import { addBot, vector, type Connection, type Player } from 'modlock'
import { hero, rules } from './config'
import type { Game } from './game'
import { dot, length, normalized, subtract } from './geometry'

export class PracticeOpponent {
  private player: Player | undefined
  private nextAttempt = 1
  private lastSelection = -Infinity
  enabled = false

  reset(): void {
    this.player = undefined
    this.nextAttempt = 1
    this.lastSelection = -Infinity
  }

  leave(connection: Connection): void {
    if (connection.player === this.player) this.reset()
  }

  frame(now: number, game: Game): void {
    if (!this.enabled) return
    if (!this.player && now >= this.nextAttempt) {
      this.player = addBot({ name: 'Practice Yamato', hero, team: 2 })
      this.nextAttempt = now + 1
    }
    const player = this.player
    if (!player) return
    const connection = [...game.seats.values()].find(
      (s) => s.connection.player === player,
    )?.connection
    if (!connection?.bot) return
    const pawn = player.pawn()
    if (!pawn || pawn.health <= 0 || pawn.generation !== connection.generation)
      return
    const opponent = [...game.seats.values()]
      .find((s) => !s.connection.bot && s.state.kind === 'playing')
      ?.connection.player.pawn()
    player.drive({
      facing: vector.level(
        vector.yawToward(
          pawn.position,
          opponent?.position ?? { x: 0, y: 0, z: 0 },
        ),
      ),
      forward: 0,
      left: 0,
      held: 0n,
      pressed: 0n,
    })
    const phase = game.round.phase
    if (
      phase.kind !== 'flight' ||
      game.seats.get(phase.target)?.connection.player !== player ||
      phase.selectedAt === this.lastSelection
    )
      return
    const toPlayer = subtract(
      { ...pawn.position, z: pawn.position.z + rules.chestHeight },
      phase.position,
    )
    const distance = length(toPlayer),
      approachSpeed = Math.max(0, dot(phase.velocity, normalized(toPlayer)))
    if (
      distance < rules.blockRadius + approachSpeed * 0.12 &&
      now >= phase.safeUntil - 0.15 &&
      game.block(player)
    )
      this.lastSelection = phase.selectedAt
  }
}
