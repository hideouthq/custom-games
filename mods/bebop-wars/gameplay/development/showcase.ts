import { addBot, Buttons, hideHud, type HudPart, log, pause, players, type Player, readFile, serverCommand } from 'modlock'
import { isProductId } from '../catalog.ts'
import type { Fighter } from '../model.ts'
import type { Game } from '../native.ts'
import type { Side } from '../hud-model.ts'

const names: Record<'ally' | 'enemy', readonly string[]> = { ally: ['Juno', 'Okabe'], enemy: ['Rill', 'Marlowe', 'Tessa'] }
const modeHud: readonly HudPart[] = ['topBar', 'ammo', 'minimap', 'stats']
const cameraParams = ['distance', 'fieldOfView', 'verticalOffset', 'horizontalOffset'] as const
type CameraParam = typeof cameraParams[number]

export class Showcase {
  private last = 0
  private seated = false
  private frames = 0
  private primed = false
  private slow = false
  private waiting: { readonly lines: readonly string[]; readonly ready: (game: Game) => boolean }[] = []

  reset(): void { this.seated = false }

  tick(game: Game): void {
    if (game.failure || game.frame.now === 0) return
    this.seat(game)
    const due = this.waiting.filter(wait => wait.ready(game))
    this.waiting = this.waiting.filter(wait => !due.includes(wait))
    for (const wait of due) for (const line of wait.lines) this.line(game, line)
    if (++this.frames % (this.slow ? 1 : 6)) return
    const lines = (readFile('showcase.txt') ?? '').split('\n')
    // A hot reload constructs this class again, and the lines already in the file have run.
    if (!this.primed) {
      this.primed = true
      this.last = Math.max(0, ...lines.map(line => Number(line.trim().split(/\s+/)[0]) || 0))
      return
    }
    for (const line of lines) {
      const [sequence, ...rest] = line.trim().split(/\s+/)
      const number = Number(sequence)
      if (!rest.length || !Number.isInteger(number) || number <= this.last) continue
      this.last = number
      this.line(game, rest.join(' '), `${number} `)
    }
  }

  private line(game: Game, text: string, label = ''): void {
    const [name = '', ...rest] = text.trim().split(/\s+/)
    log(`[Showcase] t=${game.frame.now.toFixed(3)} ${label}${text} -> ${JSON.stringify(this.run(game, name, rest))}`)
  }

  private later(game: Game, name: string, args: string[]): unknown {
    const skip = name === 'at' ? 1 : 4
    const lines = args.slice(skip).join(' ').split(' ; ')
    if (name === 'at') {
      const time = game.frame.now + Number(args[0])
      this.waiting.push({ lines, ready: current => current.frame.now >= time })
      return time
    }
    const [who = '', axis, sign, value] = args
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') return false
    this.waiting.push({
      lines,
      ready: current => {
        const fighter = this.find(current, who)
        const position = current.frame.players.find(sample => sample.id === fighter?.id)?.body?.position
        return position !== undefined && (sign === '<' ? position[axis] < Number(value) : position[axis] > Number(value))
      },
    })
    return true
  }

  private seat(game: Game): void {
    if (this.seated) return
    const human = this.human(game)
    if (human?.membership.kind !== 'seated') return
    const side = human.membership.side, size = game.state.config.teamSize
    for (let index = 0; index < size - 1; index++) addBot({ name: names.ally[index] ?? `Ally${index}`, team: side, hero: 'hero_bebop' })
    for (let index = 0; index < size; index++) addBot({ name: names.enemy[index] ?? `Enemy${index}`, team: side === 2 ? 3 : 2, hero: 'hero_bebop' })
    this.seated = true
    log(`[Showcase] seated around ${human.name} on side ${side}`)
  }

  private human(game: Game): Fighter | undefined {
    const sample = game.frame.players.find(player => !player.bot)
    return sample && game.state.fighters.get(sample.id)
  }

  private find(game: Game, who: string): Fighter | undefined {
    const me = this.human(game)
    if (who === 'me') return me
    const fighters = [...game.state.fighters.values()]
    const alias = /^([ae])(\d)$/.exec(who)
    if (!alias) return fighters.find(fighter => fighter.name === who)
    const side = me?.membership.kind === 'seated' ? me.membership.side : undefined
    const seat = (fighter: Fighter) => fighter.membership.kind === 'seated' ? fighter.membership.seat : 0
    return fighters
      .filter(fighter => fighter !== me && fighter.membership.kind === 'seated' && (fighter.membership.side === side) === (alias[1] === 'a'))
      .sort((a, b) => seat(a) - seat(b))[Number(alias[2]) - 1]
  }

  private everyone(game: Game, who: string): Fighter[] {
    if (who === 'all') return [...game.state.fighters.values()]
    const fighter = this.find(game, who)
    return fighter ? [fighter] : []
  }

  private run(game: Game, name: string, args: string[]): unknown {
    const numbers = args.map(Number)
    const actor = (index = 0) => { const fighter = this.find(game, args[index] ?? ''); return fighter && { fighter, player: game.player(fighter.id) } }
    switch (name) {
      case 'mark':
        return args[0] ?? ''
      case 'clear':
        return this.waiting.splice(0).length
      case 'at':
      case 'when':
        return this.later(game, name, args)
      case 'ready':
        for (const fighter of game.state.fighters.values()) if (!fighter.ready) game.request(fighter.id, { kind: 'ready' })
        return game.state.phase.kind
      case 'snap':
        return {
          phase: game.state.phase, score: game.state.score,
          players: game.frame.players.map(sample => {
            const pawn = game.player(sample.id)?.pawn()
            return { name: sample.name, bot: sample.bot, side: sample.body?.side, position: sample.body?.position, health: sample.body?.health, hook: sample.body?.hook, eye: pawn?.eyePosition, angles: pawn?.eyeAngles, camera: pawn?.cameraPosition }
          }),
        }
      case 'tp': {
        const target = actor()
        const [, x = 0, y = 0, yaw = y > 0 ? 270 : 90, pitch = 0, z = 4] = numbers
        const moved = target?.player?.teleport({ x, y, z }, { pitch, yaw, roll: 0 }, { x: 0, y: 0, z: 0 })
        if (target?.player && target.fighter.presence.kind === 'connected' && this.bot(game, target.fighter)) this.still(target.player, { pitch, yaw, roll: 0 })
        return moved
      }
      case 'look': {
        const target = actor(), pawn = target?.player?.pawn()
        if (!target?.player || !pawn) return false
        const facing = { pitch: numbers[2] ?? 0, yaw: numbers[1] ?? 0, roll: 0 }
        if (this.bot(game, target.fighter)) return this.still(target.player, facing)
        return target.player.teleport(pawn.position, facing)
      }
      case 'aim':
      case 'cast': {
        const source = actor(0), target = actor(1)
        const from = source?.player?.pawn(), to = target?.player?.pawn()
        if (!source?.player || !from || !to) return false
        const lead = numbers[4] || 0, eye = from.eyePosition
        const aim = { x: to.eyePosition.x + to.velocity.x * lead, y: to.eyePosition.y + to.velocity.y * lead, z: to.eyePosition.z + to.velocity.z * lead }
        const facing = {
          yaw: Math.atan2(aim.y - eye.y, aim.x - eye.x) * 180 / Math.PI + (numbers[2] || 0),
          pitch: -Math.atan2(aim.z - eye.z, Math.hypot(aim.x - eye.x, aim.y - eye.y)) * 180 / Math.PI + (numbers[3] || 0), roll: 0,
        }
        const pressed = name === 'cast' ? Buttons.ability3 : 0n
        if (this.bot(game, source.fighter)) return source.player.drive({ facing, forward: 0, left: 0, held: 0n, pressed })
        const turned = source.player.teleport(from.position, facing)
        return name === 'cast' ? turned && source.player.press(Buttons.ability3) : turned
      }
      case 'castat': {
        const source = actor(0), from = source?.player?.pawn()
        if (!source?.player || !from) return false
        const eye = from.eyePosition, [, x = 0, y = 0, z = 0] = numbers
        const facing = { yaw: Math.atan2(y - eye.y, x - eye.x) * 180 / Math.PI, pitch: -Math.atan2(z - eye.z, Math.hypot(x - eye.x, y - eye.y)) * 180 / Math.PI, roll: 0 }
        if (this.bot(game, source.fighter)) return source.player.drive({ facing, forward: 0, left: 0, held: 0n, pressed: Buttons.ability3 })
        return source.player.teleport(from.position, facing) && source.player.press(Buttons.ability3)
      }
      case 'drive': {
        const target = actor()
        return target?.player?.drive({ facing: { pitch: 0, yaw: numbers[3] ?? 0, roll: 0 }, forward: numbers[1] ?? 0, left: numbers[2] ?? 0, held: BigInt(args[4] ?? '0'), pressed: 0n })
      }
      case 'press':
        return actor()?.player?.press(BigInt(args[1] ?? '0'))
      case 'heal':
        return this.everyone(game, args[0] ?? 'all').map(fighter => { const player = game.player(fighter.id), pawn = player?.pawn(); return pawn ? player?.heal(pawn.maxHealth) : false })
      case 'kill':
        return actor()?.player?.kill()
      case 'souls':
        return actor()?.player?.adjustSouls(numbers[1] ?? 0, true)
      case 'buy': {
        const fighter = this.find(game, args[0] ?? ''), product = args[1]
        if (!fighter || !isProductId(product)) return false
        game.request(fighter.id, { kind: 'buy', product })
        return true
      }
      case 'shop': {
        const fighter = this.find(game, args[0] ?? '')
        if (!fighter) return false
        game.request(fighter.id, { kind: args[1] === 'close' ? 'close' : 'shop' })
        return true
      }
      case 'score':
        game.state.score = { 2: numbers[0] ?? 0, 3: numbers[1] ?? 0 } as Record<Side, number>
        return game.state.score
      case 'clock':
        if (game.state.phase.kind !== 'live') return false
        game.state.phase = { kind: 'live', until: game.state.now + (numbers[0] ?? 0) }
        return game.state.phase
      case 'cam': {
        const me = this.human(game), player = me && game.player(me.id)
        if (!player) return false
        if (args[0] === 'free') return player.freeCamera({ x: numbers[1] ?? 0, y: numbers[2] ?? 0, z: numbers[3] ?? 0 }, { pitch: numbers[4] ?? 0, yaw: numbers[5] ?? 0, roll: 0 })
        if (args[0] === 'watch') { const target = actor(1)?.player?.pawn(); return target ? player.watch(target.entity, args[2] === 'chase') : false }
        if (args[0] === 'off') return player.unwatch()
        if (args[0] === 'clear') return player.clearCamera()
        if (isCameraParam(args[0])) return player.moveCamera({ param: args[0], context: `showcase.${args[0]}`, priority: 100, motion: { spring: { value: numbers[1] ?? 0, strength: 60, maxDuration: 0 } } })
        return false
      }
      case 'hud': {
        const me = this.human(game), player = me && game.player(me.id)
        return player ? hideHud(player, args.length ? args as HudPart[] : modeHud) : false
      }
      case 'pause':
        return pause(args[0] !== '0')
      case 'sv':
        if (args[0] === 'host_timescale') this.slow = Number(args[1]) < 0.5
        return serverCommand(args.join(' '))
      default:
        return 'unknown command'
    }
  }

  private bot(game: Game, fighter: Fighter): boolean {
    return game.frame.players.find(sample => sample.id === fighter.id)?.bot ?? false
  }

  private still(player: Player, facing = player.pawn()?.eyeAngles ?? { pitch: 0, yaw: 0, roll: 0 }): boolean {
    return player.drive({ facing, forward: 0, left: 0, held: 0n, pressed: 0n })
  }
}

function isCameraParam(value: string | undefined): value is CameraParam { return cameraParams.some(param => param === value) }
