import { hide, hideHud, itemId, route, show, type Player } from 'modlock'
import type { ScoreRow } from './score'
import { specialCarrier, specialIds, specials, type SpecialId } from './special'

export interface Notice {
  title: string
  ballCue: 'none' | 'frozen' | 'restarting' | 'resumed'
  detail: string
  targeted: boolean
  spectating: boolean
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
