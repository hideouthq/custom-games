import {
  addBot,
  Buttons,
  log,
  onFrame,
  onStart,
  onWorld,
  readFile,
  serverCommand,
  type Player,
} from 'modlock'

import type { Game } from '../game'
import { pool } from '../heroes'
import type { Inventory } from '../inventory'
import { catalog, type Loot } from '../loot'
import type { Phase } from '../round'
import type { Point } from '../seating'

const commandFile = 'showcase.txt'

const team = 2

interface Member {
  readonly id: number
  readonly player: Player
  readonly name: string
  readonly bot: boolean
  hero: { readonly name: string; readonly label: string }
  entity: number
  alive: boolean
  position: Point
  stamina: number
  grounded: boolean
  inventory: Inventory
}

interface Score {
  points: number
  wins: number
  eliminations: number
}

interface Backstage {
  readonly members: Map<number, Member>
  readonly round: {
    readonly phase: Phase
    number: number
    nextDrop: number
    readonly scores: Map<number, Score>
    survivors(): number[]
  }
  readonly centre: { dueAt: number }
  grant(member: Member, loot: Loot): void
}

interface Driven {
  yaw: number
  pitch: number
  held: bigint
  pressed: bigint
  forward: number
}

interface Waiting {
  at: number
  lines: string[]
}

const buttons: Readonly<Record<string, bigint>> = {
  attack: Buttons.attack,
  jump: Buttons.jump,
  crouch: Buttons.crouch,
  dash: Buttons.dash,
  melee: Buttons.melee,
  parry: Buttons.parry,
  a1: Buttons.ability1,
  a2: Buttons.ability2,
  a3: Buttons.ability3,
  a4: Buttons.ultimate,
  alt: Buttons.altFire,
}

const abilityKeys = [
  Buttons.ability1,
  Buttons.ability2,
  Buttons.ability3,
  Buttons.ultimate,
]

function button(names: string | undefined): bigint {
  let bits = 0n
  for (const name of (names ?? '').split('+')) {
    bits |= buttons[name] ?? 0n
  }
  return bits
}

class Stage {
  private last = 0
  private primed = false
  private now = 0
  private readonly driven = new Map<Player, Driven>()
  private waiting: Waiting[] = []
  private readonly back: Backstage

  constructor(game: Game) {
    this.back = game as unknown as Backstage
  }

  reset(): void {
    this.driven.clear()
    this.waiting = []
  }

  tick(now: number): void {
    this.now = now
    this.read()
    const due = this.waiting.filter((entry) => now >= entry.at)
    this.waiting = this.waiting.filter((entry) => !due.includes(entry))
    for (const entry of due) {
      for (const line of entry.lines) {
        this.report('-', line)
      }
    }
    for (const [player, drive] of this.driven) {
      player.drive({
        facing: { pitch: drive.pitch, yaw: drive.yaw, roll: 0 },
        forward: drive.forward,
        left: 0,
        held: drive.held,
        pressed: drive.pressed,
      })
      drive.pressed = 0n
    }
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
      if (!(sequence > this.last) || space < 0) {
        continue
      }
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

  private who(name: string | undefined): Member | undefined {
    for (const member of this.back.members.values()) {
      if (name === 'me' ? !member.bot : member.name === name) {
        return member
      }
    }
    return undefined
  }

  private aim(from: Point, to: Point): { yaw: number; pitch: number } {
    const flat = Math.hypot(to.x - from.x, to.y - from.y)
    return {
      yaw: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      pitch: (-Math.atan2(to.z - from.z, flat) * 180) / Math.PI,
    }
  }

  private turn(member: Member, yaw: number, pitch: number): boolean {
    if (!member.bot) {
      const pawn = member.player.pawn()
      return pawn
        ? member.player.teleport(pawn.position, { pitch, yaw, roll: 0 })
        : false
    }
    const drive = this.driven.get(member.player)
    if (drive) {
      drive.yaw = yaw
      drive.pitch = pitch
    } else {
      this.driven.set(member.player, {
        yaw,
        pitch,
        held: 0n,
        pressed: 0n,
        forward: 0,
      })
    }
    return true
  }

  private press(member: Member, bits: bigint): boolean {
    if (!member.bot) {
      return member.player.press(bits)
    }
    this.turn(
      member,
      this.driven.get(member.player)?.yaw ?? 0,
      this.driven.get(member.player)?.pitch ?? 0,
    )
    const drive = this.driven.get(member.player)
    if (drive) {
      drive.pressed |= bits
    }
    return true
  }

  private run(line: string): unknown {
    const [name = '', ...args] = line.split(/\s+/)
    const numbers = args.map(Number)
    switch (name) {
      case 'bot': {
        const hero = pool.find((entry) => entry.name === args[1])
        return (
          addBot({ name: args[0] ?? 'Bot', team, hero: hero?.name }) !==
          undefined
        )
      }
      case 'hero': {
        const member = this.who('me')
        return member?.player.selectHero(args[0] ?? '', team) !== undefined
      }
      case 'give': {
        const member = this.who(args[0])
        const loot = catalog.find((entry) => entry.id === args[1])
        if (!member || !loot) {
          return false
        }
        this.back.grant(member, loot)
        return member.inventory.find(loot.native ?? '') ?? true
      }
      case 'use': {
        const member = this.who(args[0])
        const loot = catalog.find((entry) => entry.id === args[1])
        const where = member?.inventory.find(loot?.native ?? '')
        if (!member || where?.kind !== 'ability') {
          return false
        }
        return this.press(member, abilityKeys[where.slot] ?? 0n)
      }
      case 'tp': {
        const member = this.who(args[0])
        if (!member) {
          return false
        }
        const [, x = 0, y = 0, z = 0, yaw = 0, pitch = 0] = numbers
        if (member.bot) {
          this.turn(member, yaw, pitch)
        }
        return member.player.teleport(
          { x, y, z },
          { pitch, yaw, roll: 0 },
          { x: 0, y: 0, z: 0 },
        )
      }
      case 'look': {
        const member = this.who(args[0])
        return member
          ? this.turn(member, numbers[1] ?? 0, numbers[2] ?? 0)
          : false
      }
      case 'face': {
        const member = this.who(args[0])
        const target = this.who(args[1])
        const pawn = member?.player.pawn()
        const other = target?.player.pawn()
        if (!member || !pawn || !other) {
          return false
        }
        const from = member.bot
          ? pawn.eyePosition
          : (pawn.cameraPosition ?? pawn.eyePosition)
        const look = this.aim(from, {
          ...other.position,
          z: other.position.z + (numbers[2] ?? 45),
        })
        return this.turn(member, look.yaw, look.pitch) ? look : false
      }
      case 'at-point': {
        const member = this.who(args[0])
        const pawn = member?.player.pawn()
        if (!member || !pawn) {
          return false
        }
        const from = member.bot
          ? pawn.eyePosition
          : (pawn.cameraPosition ?? pawn.eyePosition)
        const look = this.aim(from, {
          x: numbers[1] ?? 0,
          y: numbers[2] ?? 0,
          z: numbers[3] ?? 0,
        })
        return this.turn(member, look.yaw, look.pitch) ? look : false
      }
      case 'press': {
        const member = this.who(args[0])
        if (!member) {
          return false
        }
        return this.press(member, button(args[1]))
      }
      case 'hold': {
        const member = this.who(args[0])
        if (!member?.bot) {
          return false
        }
        this.turn(
          member,
          this.driven.get(member.player)?.yaw ?? 0,
          this.driven.get(member.player)?.pitch ?? 0,
        )
        const drive = this.driven.get(member.player)
        if (drive) {
          drive.held = button(args[1])
          drive.forward = numbers[2] ?? 0
        }
        return true
      }
      case 'release': {
        const member = this.who(args[0])
        return member ? this.driven.delete(member.player) : false
      }
      case 'velocity': {
        const member = this.who(args[0])
        return member
          ? member.player.setVelocity({
              x: numbers[1] ?? 0,
              y: numbers[2] ?? 0,
              z: numbers[3] ?? 0,
            })
          : false
      }
      case 'stamina': {
        const member = this.who(args[0])
        return member ? member.player.setStamina(numbers[1] ?? 0) : false
      }
      case 'heal': {
        const member = this.who(args[0])
        return member ? member.player.heal(numbers[1] ?? 800) : false
      }
      case 'kill': {
        const member = this.who(args[0])
        return member ? member.player.kill() : false
      }
      case 'score': {
        const member = this.who(args[0])
        if (!member) {
          return false
        }
        const [, points = 0, wins = 0, eliminations = 0] = numbers
        this.back.round.scores.set(member.id, {
          points,
          wins,
          eliminations,
        })
        return true
      }
      case 'round':
        this.back.round.number = numbers[0] ?? 0
        return this.back.round.number
      case 'drops':
        this.back.round.nextDrop = this.now + (numbers[0] ?? 0)
        return this.back.round.nextDrop
      case 'centre':
        this.back.centre.dueAt = this.now + (numbers[0] ?? 0)
        return this.back.centre.dueAt
      case 'cam': {
        const member = this.who('me')
        if (!member) {
          return false
        }
        if (args[0] === 'off') {
          return member.player.unwatch()
        }
        return member.player.freeCamera(
          { x: numbers[0] ?? 0, y: numbers[1] ?? 0, z: numbers[2] ?? 0 },
          { pitch: numbers[3] ?? 0, yaw: numbers[4] ?? 0, roll: 0 },
        )
      }
      case 'lens': {
        // Unlike the free camera, moving the person's own camera still lets them cast.
        const member = this.who('me')
        if (!member) {
          return false
        }
        if (args[0] === 'off') {
          return member.player.clearCamera('showcase')
        }
        const value =
          args[0] === 'target'
            ? { x: numbers[1] ?? 0, y: numbers[2] ?? 0, z: numbers[3] ?? 0 }
            : (numbers[1] ?? 0)
        return member.player.moveCamera({
          context: 'showcase',
          param: args[0] as 'distance',
          motion: { lerp: { start: value, end: value, duration: 3600 } },
          priority: 9,
          shared: true,
        })
      }
      case 'sv':
        return serverCommand(args.join(' '))
      case 'mark':
        return args[0] ?? ''
      case 'clear':
        this.waiting = []
        return true
      case 'at': {
        const lines = args
          .slice(1)
          .join(' ')
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
        this.waiting.push({ at: this.now + (numbers[0] ?? 0), lines })
        return lines.length
      }
      case 'snap':
        return {
          phase: this.back.round.phase,
          round: this.back.round.number,
          living: this.back.round.survivors(),
          players: [...this.back.members.values()].map((member) => {
            const pawn = member.player.pawn()
            return {
              id: member.id,
              slot: member.player.slot,
              name: member.name,
              hero: member.hero.label,
              alive: member.alive,
              grounded: member.grounded,
              stamina: member.stamina,
              position: pawn?.position,
              eye: pawn?.eyePosition,
              camera: pawn?.cameraPosition,
              abilities: member.inventory
                .held('ability')
                .map((held) => held?.loot.id ?? ''),
              items: member.inventory
                .held('item')
                .map((held) => held?.loot.id ?? ''),
            }
          }),
        }
      default:
        return 'unknown command'
    }
  }
}

export function stage(game: Game): void {
  onStart((args) => {
    if (!args.includes('showcase')) {
      return
    }
    const staged = new Stage(game)
    onWorld(() => staged.reset())
    onFrame((frame) => staged.tick(frame.timeSeconds))
  })
}
