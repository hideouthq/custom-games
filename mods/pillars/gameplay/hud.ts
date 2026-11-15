import {
  type Child,
  heroes,
  item,
  Meter,
  type Style,
  theme,
  type Tone,
  type UiElement,
} from 'modlock'

import type { Role } from './loot'
import type { Phase } from './round'

const { tones, shades, plate, types } = theme

export interface HudRow {
  readonly name: string
  readonly hero: number
  readonly points: number
  readonly wins: number
  readonly eliminations: number
  readonly gained: number
  readonly out: boolean
  readonly self: boolean
  readonly winner: boolean
}

export interface HudDrop {
  readonly serial: number
  readonly label: string
  readonly role: Role
  readonly hint: string
  readonly item?: string
  readonly where: string
  readonly charges: number
}

export interface HudView {
  readonly phase: Phase
  readonly round: number
  readonly rounds: number
  readonly alive: number
  readonly seconds: number
  readonly dropFill: number
  readonly standing: 'in' | 'out' | 'watching'
  readonly watched?: string
  readonly centre: boolean
  readonly drop?: HudDrop
  readonly reserve: number
  readonly rows: readonly HudRow[]
}

export const roleLooks: Readonly<Record<Role, { name: string; tone: Tone }>> = {
  ammo: { name: 'Ammo', tone: 'muted' },
  stamina: { name: 'Stamina', tone: 'success' },
  mobility: { name: 'Mobility', tone: 'sapphire' },
  force: { name: 'Shove', tone: 'accent' },
  defence: { name: 'Defence', tone: 'amber' },
  legendary: { name: 'Legendary', tone: 'gold' },
}

const portraits = new Map(heroes.map((hero) => [hero.id, hero.portrait]))

const boardWidth = 276
const resultWidth = 520

function panel(style: Style, children?: Child, key?: string): UiElement {
  return { type: 'panel', props: { style, children }, key }
}

function moving(
  style: Style,
  from: Style,
  children: Child,
  key: string,
): UiElement {
  return {
    type: 'panel',
    props: {
      style: { transition: { seconds: 0.25, easing: 'out' }, ...style },
      enter: { opacity: 0, ...from },
      exit: { opacity: 0 },
      children,
    },
    key,
  }
}

function image(src: string, style: Style): UiElement {
  return { type: 'image', props: { src, scaling: 'cover', style } }
}

function words(
  role: keyof typeof types,
  text: string,
  style: Style = {},
  plated = true,
): UiElement {
  const type = types[role]
  return {
    type: 'label',
    props: {
      style: {
        face: type.face,
        fontSize: type.size,
        uppercase: type.uppercase,
        color: tones.text,
        shadow: !plated,
        noWrap: true,
        verticalAlign: 'center',
        ...style,
      },
      children: text,
    },
  }
}

function phaseTone(phase: Phase): Tone {
  return phase === 'final' ? 'danger' : phase === 'overtime' ? 'amber' : 'gold'
}

function playing(phase: Phase): boolean {
  return phase === 'live' || phase === 'overtime' || phase === 'final'
}

function heading(view: HudView): string {
  switch (view.phase) {
    case 'waiting':
      return 'Pillars'
    case 'overtime':
      return `Overtime  ·  Round ${view.round} of ${view.rounds}`
    case 'final':
      return `Final Stand  ·  Round ${view.round} of ${view.rounds}`
    case 'matchEnd':
      return 'Match over'
    default:
      return `Round ${view.round} of ${view.rounds}`
  }
}

function underline(view: HudView): { text: string; tone: Tone } | undefined {
  if (playing(view.phase) && view.standing !== 'in') {
    return {
      text:
        view.watched === undefined
          ? 'You are out'
          : `You are out  ·  Watching ${view.watched}`,
      tone: 'muted',
    }
  }
  if (view.phase === 'final') {
    return { text: 'One deck. No way off it.', tone: 'danger' }
  }
  if (view.phase === 'overtime') {
    return { text: 'Faster drops. The void is rising.', tone: 'amber' }
  }
  if (playing(view.phase) && view.centre) {
    return {
      text: 'Legendary crate on the centre deck: heavy melee it',
      tone: 'gold',
    }
  }
  return undefined
}

function divider(): UiElement {
  return panel({
    width: 1,
    height: 26,
    margin: [0, 16],
    verticalAlign: 'center',
    background: shades.faint,
    opacity: 0.5,
  })
}

function counter(view: HudView): UiElement {
  const tone = phaseTone(view.phase)
  return panel({ flow: 'right', verticalAlign: 'center' }, [
    words('title', `${view.alive}`, {
      color: tones[tone],
      margin: [0, 6, 0, 0],
    }),
    words('label', 'left', { color: tones.muted }),
  ])
}

function dropTimer(view: HudView): UiElement {
  return panel({ flow: 'right', verticalAlign: 'center' }, [
    words('label', 'Next drop', { color: tones.muted, margin: [0, 10, 0, 0] }),
    Meter({
      value: view.dropFill,
      tone: 'accent',
      width: 96,
      height: 6,
      style: { verticalAlign: 'center' },
    }),
    words('label', `${view.seconds}s`, {
      width: 30,
      margin: [0, 0, 0, 8],
      textAlign: 'right',
    }),
  ])
}

function bar(view: HudView): UiElement {
  let inside: Child
  if (playing(view.phase)) {
    inside =
      view.standing === 'in'
        ? [counter(view), divider(), dropTimer(view)]
        : [counter(view)]
  } else if (view.phase === 'countdown') {
    inside = [
      words('label', 'Starts in', {
        color: tones.muted,
        margin: [0, 10, 0, 0],
      }),
      words('title', `${view.seconds}`, { color: tones.gold }),
    ]
  } else if (view.phase === 'waiting') {
    inside = [words('label', 'Waiting for players', { color: tones.muted })]
  } else if (view.phase === 'matchEnd') {
    inside = [words('label', 'Thanks for playing', { color: tones.muted })]
  } else {
    inside = [
      words('label', 'Next round in', {
        color: tones.muted,
        margin: [0, 10, 0, 0],
      }),
      words('title', `${view.seconds}`, { color: tones.text }),
    ]
  }
  return panel(
    {
      flow: 'right',
      horizontalAlign: 'center',
      height: 46,
      margin: [5, 0, 0, 0],
      padding: [0, 22],
      background: plate.color,
      borderRadius: 23,
      borderWidth: 1,
      borderColor: theme.pillEdge,
    },
    inside,
  )
}

function topBar(view: HudView): UiElement {
  const parts: UiElement[] = [
    words(
      'label',
      heading(view),
      {
        horizontalAlign: 'center',
        letterSpacing: 2,
        color: playing(view.phase) ? tones[phaseTone(view.phase)] : tones.text,
      },
      false,
    ),
    bar(view),
  ]
  const line = underline(view)
  if (line !== undefined) {
    parts.push(
      words(
        'label',
        line.text,
        {
          horizontalAlign: 'center',
          margin: [8, 0, 0, 0],
          letterSpacing: 1,
          color: tones[line.tone],
        },
        false,
      ),
    )
  }
  return panel(
    { flow: 'down', horizontalAlign: 'center', margin: [14, 0, 0, 0] },
    parts,
    'top',
  )
}

function portrait(hero: number, size: number): UiElement {
  const src = portraits.get(hero)
  return panel(
    {
      width: size,
      height: size,
      verticalAlign: 'center',
      background: shades.raised,
      borderRadius: 4,
      overflow: 'clip',
    },
    src === undefined
      ? undefined
      : image(src, { width: '100%', height: '100%' }),
  )
}

function boardRow(row: HudRow, index: number): UiElement {
  return panel(
    {
      flow: 'right',
      width: '100%',
      height: 36,
      padding: [0, 10, 0, 0],
      margin: [2, 0, 0, 0],
      borderRadius: 4,
      background: row.self ? shades.lit : shades.clear,
      opacity: row.out ? 0.45 : 1,
      transition: 0.25,
    },
    [
      panel({
        width: 3,
        height: 20,
        verticalAlign: 'center',
        borderRadius: 2,
        background: row.self ? tones.accent : shades.clear,
      }),
      words('label', `${index + 1}`, {
        width: 22,
        textAlign: 'center',
        color: tones.muted,
      }),
      portrait(row.hero, 28),
      words('label', row.name, {
        width: 'fill',
        margin: [0, 8, 0, 10],
        textOverflow: 'ellipsis',
        color: row.winner ? tones.gold : tones.text,
      }),
      words('caption', row.out ? 'OUT' : `${row.eliminations} KO`, {
        width: 44,
        textAlign: 'right',
        color: row.out ? tones.danger : tones.muted,
      }),
      words('label', `${row.points}`, {
        width: 34,
        textAlign: 'right',
        fontSize: 18,
      }),
    ],
    `board-${index}`,
  )
}

function board(view: HudView): UiElement {
  return panel(
    {
      flow: 'down',
      width: boardWidth,
      horizontalAlign: 'right',
      verticalAlign: 'top',
      margin: [theme.fpsReadoutBottom + 8, 24, 0, 0],
      padding: [10, 8, 8, 8],
      background: plate.color,
      borderRadius: plate.radius,
    },
    [
      panel({ flow: 'right', width: '100%', padding: [0, 10, 4, 6] }, [
        words('label', 'Leaderboard', {
          width: 'fill',
          letterSpacing: 1,
          color: tones.muted,
        }),
        words('label', 'Pts', { color: tones.muted }),
      ]),
      ...view.rows.map(boardRow),
    ],
    'board',
  )
}

function dropCard(drop: HudDrop): UiElement {
  const look = roleLooks[drop.role]
  const icon = drop.item === undefined ? undefined : item(drop.item)?.icon
  const body: UiElement[] = [
    panel({
      width: 4,
      height: 52,
      verticalAlign: 'center',
      borderRadius: 2,
      background: tones[look.tone],
    }),
  ]
  if (icon !== undefined) {
    body.push(
      image(icon, {
        width: 48,
        height: 48,
        margin: [0, 0, 0, 14],
        verticalAlign: 'center',
      }),
    )
  }
  const name: UiElement[] = [words('title', drop.label, { fontSize: 24 })]
  if (drop.charges > 1) {
    name.push(
      words('title', `×${drop.charges}`, {
        fontSize: 24,
        margin: [0, 0, 0, 10],
        color: tones[look.tone],
      }),
    )
  }
  body.push(
    panel({ flow: 'down', verticalAlign: 'center', margin: [0, 6, 0, 14] }, [
      panel({ flow: 'right' }, [
        words('label', look.name, {
          fontSize: 12,
          letterSpacing: 1,
          color: tones[look.tone],
        }),
        words('label', `·  ${drop.where}`, {
          fontSize: 12,
          letterSpacing: 1,
          margin: [0, 0, 0, 8],
          color: tones.muted,
        }),
      ]),
      panel({ flow: 'right', margin: [2, 0, 0, 0] }, name),
      words('caption', drop.hint, { margin: [2, 0, 0, 0], color: tones.muted }),
    ]),
  )
  return moving(
    {
      flow: 'right',
      horizontalAlign: 'center',
      verticalAlign: 'bottom',
      margin: [0, 0, 208, 0],
      padding: [10, 18, 10, 12],
      background: plate.color,
      borderRadius: plate.radius,
      borderWidth: 1,
      borderColor: theme.pillEdge,
    },
    { translate: [0, 14], scale: 0.96 },
    body,
    `drop-${drop.serial}`,
  )
}

function reserveTag(reserve: number): UiElement {
  return panel(
    {
      flow: 'right',
      horizontalAlign: 'right',
      verticalAlign: 'bottom',
      margin: [0, 330, 128, 0],
      padding: [6, 12, 6, 12],
      background: plate.color,
      borderRadius: plate.radius,
      borderWidth: 1,
      borderColor: theme.pillEdge,
    },
    [
      words('label', 'Reserve', {
        fontSize: 12,
        letterSpacing: 1,
        color: tones.muted,
        margin: [0, 8, 0, 0],
        verticalAlign: 'center',
      }),
      words('title', `${reserve}`, {
        fontSize: 20,
        color: reserve > 0 ? tones.text : tones.danger,
        verticalAlign: 'center',
      }),
    ],
    'reserve',
  )
}

function resultRow(row: HudRow, index: number): UiElement {
  const cell = (text: string, width: number, color: string) =>
    words('label', text, { width, textAlign: 'right', color })
  return panel(
    {
      flow: 'right',
      width: '100%',
      height: 40,
      padding: [0, 14],
      margin: [2, 0, 0, 0],
      borderRadius: 4,
      background: row.self ? shades.lit : shades.raised,
    },
    [
      words('label', `${index + 1}`, { width: 24, color: tones.muted }),
      portrait(row.hero, 30),
      words('label', row.name, {
        width: 'fill',
        margin: [0, 8, 0, 12],
        textOverflow: 'ellipsis',
        color: row.winner ? tones.gold : tones.text,
      }),
      cell(row.gained > 0 ? `+${row.gained}` : '', 44, tones.success),
      cell(`${row.wins}`, 56, tones.muted),
      cell(`${row.eliminations}`, 56, tones.muted),
      cell(`${row.points}`, 56, tones.text),
    ],
    `result-${index}`,
  )
}

function results(view: HudView): UiElement {
  const over = view.phase === 'matchEnd'
  const top = over ? view.rows[0] : view.rows.find((row) => row.winner)
  const title =
    top === undefined
      ? 'Nobody is left'
      : over
        ? `${top.name} wins the match`
        : `${top.name} wins the round`
  const detail = over
    ? `${view.rounds} rounds played`
    : view.round >= view.rounds
      ? 'That was the last round'
      : `Round ${view.round} of ${view.rounds}  ·  Round ${view.round + 1} is next`
  const head = (text: string, width: number) =>
    words('label', text, {
      width,
      textAlign: 'right',
      fontSize: 12,
      letterSpacing: 1,
      color: tones.muted,
    })
  return moving(
    {
      flow: 'down',
      width: resultWidth,
      horizontalAlign: 'center',
      verticalAlign: 'top',
      margin: [190, 0, 0, 0],
      padding: [22, 18, 16, 18],
      background: shades.veil,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.pillEdge,
    },
    { scale: 0.94 },
    [
      words('label', over ? 'Match over' : 'Round over', {
        horizontalAlign: 'center',
        letterSpacing: 2,
        color: tones.muted,
      }),
      words('title', title, {
        horizontalAlign: 'center',
        fontSize: 34,
        margin: [4, 0, 0, 0],
        color: tones.gold,
      }),
      words('caption', detail, {
        horizontalAlign: 'center',
        margin: [4, 0, 14, 0],
        color: tones.muted,
      }),
      panel({ flow: 'right', width: '100%', padding: [0, 14, 4, 14] }, [
        panel({ width: 'fill' }),
        head('Wins', 56),
        head('KOs', 56),
        head('Pts', 56),
      ]),
      ...view.rows.map(resultRow),
    ],
    over ? 'results-match' : `results-${view.round}`,
  )
}

export function hud(view: HudView): UiElement {
  const between = view.phase === 'intermission' || view.phase === 'matchEnd'
  const parts: UiElement[] = [topBar(view)]
  if (between) {
    parts.push(results(view))
  } else if (view.rows.length > 0) {
    parts.push(board(view))
  }
  if (view.drop !== undefined && view.standing === 'in' && !between) {
    parts.push(dropCard(view.drop))
  }
  if (playing(view.phase) && view.standing === 'in') {
    parts.push(reserveTag(view.reserve))
  }
  return panel({ width: '100%', height: '100%' }, parts, 'pillars')
}

function sampleRow(
  name: string,
  hero: number,
  points: number,
  wins: number,
  eliminations: number,
  gained: number,
  out: boolean,
): HudRow {
  const self = name === 'Mugi'
  return {
    name,
    hero,
    points,
    wins,
    eliminations,
    gained,
    out,
    self,
    winner: self,
  }
}

const sampleRows: readonly HudRow[] = [
  sampleRow('Mugi', 6, 9, 2, 3, 4, false),
  sampleRow('Vindicta main', 3, 7, 1, 3, 1, false),
  sampleRow('a very long player name here', 31, 5, 1, 2, 0, true),
  sampleRow('Lee', 27, 4, 0, 3, 1, true),
  sampleRow('oobabooga', 35, 2, 0, 1, 1, false),
  sampleRow('Daniel', 20, 0, 0, 0, 0, true),
]

const sampleBase: HudView = {
  phase: 'live',
  round: 2,
  rounds: 5,
  alive: 3,
  seconds: 3,
  dropFill: 0.6,
  standing: 'in',
  centre: false,
  reserve: 24,
  rows: sampleRows.map((row) => ({ ...row, gained: 0, winner: false })),
}

export const samples: Readonly<Record<string, HudView>> = {
  waiting: { ...sampleBase, phase: 'waiting', round: 0, rows: [] },
  countdown: {
    ...sampleBase,
    phase: 'countdown',
    seconds: 4,
    alive: 6,
    rows: sampleBase.rows.map((row) => ({ ...row, out: false })),
  },
  live: sampleBase,
  item: {
    ...sampleBase,
    drop: {
      serial: 1,
      label: 'Warp Stone',
      role: 'mobility',
      hint: 'Blink 11 m the way you face.',
      item: 'upgrade_warp_stone',
      where: 'Item 1',
      charges: 2,
    },
  },
  ability: {
    ...sampleBase,
    centre: true,
    drop: {
      serial: 2,
      label: 'Puddle Punch',
      role: 'force',
      hint: 'Punch a player up and away from range.',
      where: 'Ability 3',
      charges: 1,
    },
  },
  out: { ...sampleBase, standing: 'out', watched: 'Vindicta main' },
  overtime: { ...sampleBase, phase: 'overtime', alive: 2, seconds: 2 },
  final: { ...sampleBase, phase: 'final', alive: 2, seconds: 1 },
  results: {
    ...sampleBase,
    phase: 'intermission',
    seconds: 5,
    rows: sampleRows,
  },
  match: {
    ...sampleBase,
    phase: 'matchEnd',
    round: 5,
    seconds: 9,
    rows: sampleRows,
  },
}
