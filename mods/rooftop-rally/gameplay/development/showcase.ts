import {
  addBot,
  log,
  onFrame,
  onStart,
  onWorld,
  readFile,
  serverCommand,
  vector,
  type Player,
} from 'modlock'
import { hero, rules } from '../config'
import type { Game } from '../game'
import { dot, length, normalized, subtract } from '../geometry'

const commandFile = 'showcase.txt'

interface Waiting {
  due: { at: number } | { rally: number }
  lines: string[]
}

class Stage {
  private last = 0
  private primed = false
  private now = 0
  private readonly bots = new Map<string, Player>()
  private readonly rallying = new Map<Player, Player | undefined>()
  private readonly blocked = new Map<Player, number>()
  private waiting: Waiting[] = []

  constructor(private readonly game: Game) {}

  reset(): void {
    this.bots.clear()
    this.rallying.clear()
    this.blocked.clear()
    this.waiting = []
  }

  tick(now: number): void {
    this.now = now
    this.read()
    const due = this.waiting.filter((entry) =>
      'at' in entry.due
        ? now >= entry.due.at
        : this.game.round.rally >= entry.due.rally,
    )
    this.waiting = this.waiting.filter((entry) => !due.includes(entry))
    for (const entry of due)
      for (const line of entry.lines) this.report('-', line)
    for (const [player, facing] of this.rallying) this.rally(player, facing)
  }

  private read(): void {
    const text = readFile(commandFile)
    if (text === undefined) {
      this.primed = true
      return
    }
    const lines = text.split('\n').filter((line) => line.trim())
    if (!this.primed) {
      this.primed = true
      this.last = Math.max(0, ...lines.map((line) => Number.parseInt(line)))
      return
    }
    for (const line of lines) {
      const space = line.indexOf(' ')
      const sequence = Number.parseInt(line)
      if (!(sequence > this.last) || space < 0) continue
      this.last = sequence
      this.report(String(sequence), line.slice(space + 1).trim())
    }
  }

  private report(sequence: string, line: string): void {
    let result: unknown
    try {
      result = this.run(line)
    } catch (error) {
      result = `error: ${error instanceof Error ? error.message : String(error)}`
    }
    log(
      `[Showcase] t=${this.now.toFixed(3)} ${sequence} ${line} -> ${JSON.stringify(result)}`,
    )
  }

  private human(): Player | undefined {
    for (const seat of this.game.seats.values())
      if (!seat.connection.bot) return seat.connection.player
    return undefined
  }

  private who(name: string | undefined): Player | undefined {
    return name === 'me' ? this.human() : this.bots.get(name ?? '')
  }

  private scoreKey(player: Player): string | undefined {
    for (const [id, seat] of this.game.seats)
      if (seat.connection.player === player)
        return seat.connection.bot || seat.connection.steamId === 0n
          ? id
          : `steam:${seat.connection.steamId}`
    return undefined
  }

  private run(line: string): unknown {
    const [name = '', ...args] = line.split(/\s+/)
    const numbers = args.map(Number)
    switch (name) {
      case 'bot': {
        const player = addBot({ name: args[0] ?? 'Yamato', hero, team: 2 })
        if (player) this.bots.set(args[0] ?? 'Yamato', player)
        return player !== undefined
      }
      case 'choose': {
        const player = this.human()
        return player ? this.game.choose(player, args[0] ?? '') : false
      }
      case 'tp': {
        const player = this.who(args[0])
        const pawn = player?.pawn()
        if (!player || !pawn) return false
        const position = {
          x: numbers[1] ?? 0,
          y: numbers[2] ?? 0,
          z: numbers[5] ?? pawn.position.z,
        }
        const moved = player.teleport(
          position,
          { pitch: numbers[4] ?? 0, yaw: numbers[3] ?? 0, roll: 0 },
          { x: 0, y: 0, z: 0 },
        )
        for (const [id, seat] of this.game.seats)
          if (moved && seat.connection.player === player)
            this.game.round.relocate(id, position)
        return moved
      }
      case 'rally': {
        const players = args.map((arg) => this.who(arg))
        if (players.some((player) => !player)) return false
        this.rallying.clear()
        players.forEach((player, index) => {
          if (player)
            this.rallying.set(
              player,
              players[(index + 1) % players.length],
            )
        })
        return players.length
      }
      case 'cover': {
        const player = this.who(args[0])
        const facing = this.who(args[1])
        if (!player || !facing) return false
        this.rallying.set(player, facing)
        return true
      }
      case 'drop': {
        const player = this.who(args[0])
        return player ? this.rallying.delete(player) : false
      }
      case 'kill': {
        const player = this.who(args[0])
        return player ? player.kill() : false
      }
      case 'tally': {
        const player = this.who(args[0])
        const key = player && this.scoreKey(player)
        if (!key) return false
        const scores = this.game.scores
        const [, wins = 0, knockouts = 0, parries = 0] = numbers
        for (let i = 0; i < parries - knockouts; i++) scores.parry(key)
        for (let i = 0; i < knockouts; i++) {
          scores.parry(key)
          scores.hit('showcase')
        }
        scores.clearSender()
        for (let i = 0; i < wins; i++) scores.win(key)
        return true
      }
      case 'round':
        this.game.round.number = numbers[0] ?? 0
        return this.game.round.number
      case 'cam': {
        const player = this.human()
        if (!player) return false
        if (args[0] === 'off') return player.unwatch()
        return player.freeCamera(
          { x: numbers[0] ?? 0, y: numbers[1] ?? 0, z: numbers[2] ?? 0 },
          { pitch: numbers[3] ?? 0, yaw: numbers[4] ?? 0, roll: 0 },
        )
      }
      case 'sv':
        return serverCommand(args.join(' '))
      case 'mark':
        return args[0] ?? ''
      case 'clear':
        this.waiting = []
        return true
      case 'at':
      case 'when': {
        const lines = args
          .slice(1)
          .join(' ')
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
        const value = numbers[0] ?? 0
        this.waiting.push({
          due: name === 'at' ? { at: this.now + value } : { rally: value },
          lines,
        })
        return lines.length
      }
      case 'snap': {
        const phase = this.game.round.phase
        return {
          phase: phase.kind,
          round: this.game.round.number,
          rally: this.game.round.rally,
          living: [...this.game.round.living],
          players: [...this.game.seats].map(([id, seat]) => ({
            id,
            name: seat.connection.name,
            state: seat.state.kind,
            position: seat.connection.player.pawn()?.position,
          })),
        }
      }
      default:
        return 'unknown command'
    }
  }

  private rally(player: Player, facing: Player | undefined): void {
    const pawn = player.pawn()
    const other = facing?.pawn()
    if (!pawn || pawn.health <= 0) return
    const seat = [...this.game.seats.values()].find(
      (candidate) => candidate.connection.player === player,
    )
    if (seat?.connection.bot && other) {
      player.drive({
        facing: vector.level(vector.yawToward(pawn.position, other.position)),
        forward: 0,
        left: 0,
        held: 0n,
        pressed: 0n,
      })
    }
    const phase = this.game.round.phase
    if (
      phase.kind !== 'flight' ||
      this.game.seats.get(phase.target)?.connection.player !== player ||
      this.now < (this.blocked.get(player) ?? -Infinity) + rules.blockWindow
    )
      return
    const toPlayer = subtract(
      { ...pawn.position, z: pawn.position.z + rules.chestHeight },
      phase.position,
    )
    const approach = Math.max(0, dot(phase.velocity, normalized(toPlayer)))
    if (
      length(toPlayer) < rules.blockRadius + approach * 0.12 &&
      this.now >= phase.safeUntil - 0.15 &&
      this.game.block(player)
    )
      this.blocked.set(player, this.now)
  }
}

export function stage(game: Game): void {
  onStart((args) => {
    if (!args.includes('showcase')) return
    const staged = new Stage(game)
    onWorld(() => staged.reset())
    onFrame((frame) => staged.tick(frame.timeSeconds))
  })
}
