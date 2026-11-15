export const specialIds = ['powerSlash', 'blink', 'timeFreeze'] as const
export type SpecialId = (typeof specialIds)[number]
export const specialCarrier = 'citadel_ability_healing_slash'
export const powerSlashMultiplier = 1.5
export const blinkDistance = 12 / 0.0254
export const timeFreezeDuration = 0.6

export const specials = {
  powerSlash: {
    name: 'Power Slash',
    cooldown: 20,
    icon: 's2r://panorama/images/hud/abilities/yamato/yamato_power_slash_psd.vtex',
    category: 'isWeapon',
    description:
      'Charge your next shot, any time. Your next return launches the ball with 50% extra velocity. Block as usual; the charge waits until you return the ball or the round ends.',
    stat: '+50% launch velocity',
  },
  blink: {
    name: 'Blink',
    cooldown: 18,
    icon: 's2r://panorama/images/hud/abilities/sumo/sumo_quantum_psd.vtex',
    category: 'isTech',
    description:
      'Instantly teleport up to 12m in your movement direction. With no movement input, blink forward. Solid obstacles shorten the teleport.',
    stat: '12m teleport',
  },
  timeFreeze: {
    name: 'Time Freeze',
    cooldown: 22,
    icon: 's2r://panorama/images/hud/abilities/chrono/chrono_time_bomb_psd.vtex',
    category: 'isArmor',
    description:
      'Freeze the ball in flight for 0.6s, whoever it is flying at, before it enters its target’s block sphere. It resumes with the same target and momentum. Anti-orbit time pauses during the freeze.',
    stat: '0.6s time freeze',
  },
} satisfies Record<
  SpecialId,
  {
    name: string
    cooldown: number
    icon: string
    category: string
    description: string
    stat: string
  }
>

type SpecialState =
  | { kind: 'choosing' }
  | { kind: 'powerSlash'; readyAt: number; armed: boolean }
  | { kind: 'blink'; readyAt: number }
  | { kind: 'timeFreeze'; readyAt: number }

export function isSpecialId(value: string): value is SpecialId {
  return specialIds.some((id) => id === value)
}

export class Special {
  private state: SpecialState = { kind: 'choosing' }

  get choice(): SpecialId | undefined {
    return this.state.kind === 'choosing' ? undefined : this.state.kind
  }

  choose(choice: SpecialId): boolean {
    if (this.choice) return false
    this.state = this.fresh(choice)
    return true
  }

  resetRound(): void {
    const choice = this.choice
    if (choice) this.state = this.fresh(choice)
  }

  private fresh(choice: SpecialId): SpecialState {
    switch (choice) {
      case 'powerSlash':
        return { kind: choice, readyAt: 0, armed: false }
      case 'blink':
      case 'timeFreeze':
        return { kind: choice, readyAt: 0 }
      default: {
        const exhaustive: never = choice
        return exhaustive
      }
    }
  }

  get readyAt(): number {
    return this.state.kind === 'choosing' ? 0 : this.state.readyAt
  }
  get armed(): boolean {
    return this.state.kind === 'powerSlash' && this.state.armed
  }
  canActivate(now: number): boolean {
    const state = this.state
    return state.kind !== 'choosing' && now >= state.readyAt && !this.armed
  }

  activate(now: number): boolean {
    const state = this.state
    if (!this.canActivate(now) || state.kind === 'choosing') return false
    state.readyAt = now + specials[state.kind].cooldown
    if (state.kind === 'powerSlash') state.armed = true
    return true
  }

  consumePower(): void {
    if (this.state.kind === 'powerSlash') this.state.armed = false
  }

  cancelLife(): void {
    if (this.state.kind === 'powerSlash') this.state.armed = false
  }
}
