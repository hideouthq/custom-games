import { hide, hideHud, itemId, route, show, type Player } from 'modlock'
import { rules } from './config'
import { length } from './geometry'
import type { Phase } from './round'
import type { ScoreRow } from './score'
import { specialCarrier, specialIds, specials, type SpecialId } from './special'

export interface Notice {
  title: string
  ballCue: 'none' | 'frozen' | 'restarting' | 'resumed'
  detail: string
  targeted: boolean
  spectating: boolean
}

export interface NoticeSeat {
  chosen: boolean
  spectating: boolean
  targeted: boolean
  penaltyUntil: number | undefined
  blockCooldown: number
}

export interface NoticeContext {
  now: number
  round: number
  remaining: number
  seats: number
  winnerName: string
  resumeCueUntil: number
}

export function notice(
  phase: Phase,
  seat: NoticeSeat,
  context: NoticeContext,
): Notice {
  const { now } = context
  const { targeted, spectating } = seat
  let title = `ROUND ${context.round} · ${context.remaining} REMAINING`,
    detail = ''
  if (phase.kind === 'flight')
    title += ` · ${(length(phase.velocity) * 0.0254).toFixed(1)} m/s`
  if (phase.kind === 'waiting') {
    title = 'WAITING FOR PLAYERS'
    detail = 'Two players needed · Left click or parry to block'
  } else if (phase.kind === 'countdown') {
    title = 'ROUND STARTING'
    detail = `${Math.max(1, Math.ceil(phase.until - now))}`
  } else if (phase.kind === 'spawning') {
    title = 'GET READY'
    detail = 'One life · Last player standing wins'
  } else if (phase.kind === 'intermission') {
    title = `${context.winnerName.toUpperCase()} WINS`
    detail = 'Next round shortly'
  } else if (spectating) detail = 'SPECTATING · You return next round'
  else if (seat.penaltyUntil !== undefined)
    detail = `ORBIT PENALTY · Stunned for ${(seat.penaltyUntil - now).toFixed(1)}s`
  else if (targeted) {
    const cooldown = seat.blockCooldown
    detail =
      phase.kind === 'serve'
        ? 'YOU ARE TARGETED · Ball launches in 1 second'
        : cooldown > 0
          ? `YOU ARE TARGETED · Block ready in ${cooldown.toFixed(1)}s`
          : 'YOU ARE TARGETED · LEFT CLICK / PARRY'
    if (phase.kind === 'flight' && phase.orbitSeconds >= rules.orbitWarning)
      detail = `ORBIT WARNING · Parry or separate from the ball · ${(rules.orbitTime - phase.orbitSeconds).toFixed(1)}s`
  } else
    detail =
      phase.kind === 'reset'
        ? 'Ball returning to center'
        : 'Aim your return · Left click or parry when targeted'
  if (!seat.chosen) {
    title = 'CHOOSE YOUR ABILITY'
    detail = 'One choice for this match · Abilities reset each round'
  } else if (phase.kind === 'waiting' && context.seats >= 2) {
    title = 'WAITING FOR CHOICES'
    detail = 'The round starts when everyone has chosen'
  }
  const ballCue =
    phase.kind === 'frozen'
      ? phase.until - now <= 0.2
        ? 'restarting'
        : 'frozen'
      : phase.kind === 'flight' && now < context.resumeCueUntil
        ? 'resumed'
        : 'none'
  if (phase.kind === 'frozen') {
    title = `TIME FROZEN · ${(phase.until - now).toFixed(1)}s`
    detail =
      ballCue === 'restarting'
        ? 'BALL RESTARTING'
        : 'Ball resumes with the same target and momentum'
  } else if (ballCue === 'resumed') {
    title = 'BALL RESUMED'
  }
  return { title, ballCue, detail, targeted, spectating }
}

export interface SpecialState {
  choice: SpecialId | null
  armed: boolean
  available: boolean
}

export interface Standings {
  rows: ScoreRow[]
  full: boolean
}

export interface RallyCount {
  count: number
  live: boolean
}

export interface HudState {
  notice: Notice
  special: SpecialState
  standings: Standings | undefined
  rally: RallyCount
}

export function cleanHud(player: Player): void {
  // A reused player slot needs a reset before the SDK can send HUD deltas.
  hide(player)
  hideHud(player, [
    'levelUp',
    'ownHealth',
    'topBar',
    'ammo',
    'souls',
    'minimap',
    'abilities',
    'status',
    'stats',
  ])
  route(player, 'choices', {
    choices: specialIds.map((id) => ({ id, ...specials[id] })),
    nativeAbilityId: itemId(specialCarrier),
    playerSlot: player.slot,
  })
}

// The SDK sends a route only when its value differs from the last one.
export function drawHud(player: Player, state: HudState): void {
  show(player, {
    type: 'layout',
    props: {
      src: 'rally.xml',
      data: state.notice,
      style: { width: 'fill', height: 'fill' },
    },
  })
  route(player, 'special', state.special)
  route(player, 'scores', state.standings)
  route(player, 'rally', state.rally)
}
