import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Scores, type ScoreRow } from '../gameplay/score'

const players = (alive = true) =>
  ['a', 'b', 'c'].map((key) => ({ key, name: key.toUpperCase(), alive }))

test('standings order by wins, then knockouts, then parries, and share a rank on equal wins', () => {
  const scores = new Scores()
  scores.win('b')
  scores.parry('c')
  scores.hit('a')
  scores.parry('a')
  const board = scores.board(players(), 'c')
  expect(board.map((row) => [row.rank, row.name])).toEqual([
    [1, 'B'],
    [2, 'C'],
    [2, 'A'],
  ])
  expect(board.map((row) => row.leader)).toEqual([true, false, false])
  expect(board.map((row) => row.self)).toEqual([false, true, false])
  expect(board[1]).toMatchObject({ knockouts: 1, parries: 1 })
})

test('nobody leads before the first win, and tied winners all lead', () => {
  const scores = new Scores()
  expect(scores.board(players()).some((row) => row.leader)).toBe(false)
  scores.win('a')
  scores.win('c')
  expect(
    scores
      .board(players())
      .filter((row) => row.leader)
      .map((row) => row.name),
  ).toEqual(['A', 'C'])
})

test('a streak counts consecutive wins and ends when another player or nobody wins', () => {
  const scores = new Scores()
  scores.win('a')
  scores.win('a')
  expect(scores.board(players())[0]).toMatchObject({ wins: 2, streak: 2 })
  scores.win('b')
  expect(scores.board(players())[0]).toMatchObject({ name: 'A', streak: 0 })
  scores.win(undefined)
  expect(scores.board(players()).map((row) => row.streak)).toEqual([0, 0, 0])
})

test('a knockout needs a sender other than the victim and is spent by the hit', () => {
  const scores = new Scores()
  scores.hit('a')
  scores.parry('a')
  scores.hit('a')
  scores.parry('a')
  scores.clearSender()
  scores.hit('b')
  scores.parry('a')
  scores.hit('b')
  scores.hit('c')
  expect(scores.board(players())[0]).toMatchObject({ name: 'A', knockouts: 1 })
})

test('absent players are not listed and a forgotten player starts over', () => {
  const scores = new Scores()
  scores.win('a')
  expect(scores.board(players().slice(1)).map((row) => row.name)).toEqual([
    'B',
    'C',
  ])
  scores.forget('a')
  expect(scores.board(players())[0]).toMatchObject({ wins: 0, leader: false })
})

class Panel {
  children: Panel[] = []
  classes = new Set<string>()
  text = ''
  visible = true
  constructor(
    public id: string,
    parent?: Panel,
  ) {
    parent?.children.push(this)
  }
  IsValid(): boolean {
    return true
  }
  AddClass(name: string): void {
    this.classes.add(name)
  }
  SetHasClass(name: string, value: boolean): void {
    value ? this.classes.add(name) : this.classes.delete(name)
  }
  FindChildTraverse(id: string): Panel | undefined {
    for (const child of this.children) {
      if (child.id === id) return child
      const nested = child.FindChildTraverse(id)
      if (nested) return nested
    }
    return undefined
  }
}

function board() {
  const root = new Panel('RallyHud')
  const compact = new Panel('LeaderboardRows', root)
  const full = new Panel('StandingsRows', root)
  const routes = new Map<string, (value: unknown) => void>()
  runInNewContext(
    readFileSync(
      new URL(
        '../content/citadel_addons/new_deadlock_game/panorama/scripts/scores.js',
        import.meta.url,
      ),
      'utf8',
    ),
    {
      $: {
        GetContextPanel: () => root,
        CreatePanel: (_type: string, parent: Panel, id: string) =>
          new Panel(id, parent),
      },
      Modlock: {
        route: (name: string, handler: (value: unknown) => void) => {
          routes.set(name, handler)
        },
      },
    },
  )
  const shown = (rows: Panel) =>
    rows.children
      .filter((row) => row.visible)
      .map((row) => row.children.map((cell) => cell.text))
  expect([...routes.keys()]).toEqual(['scores'])
  const receive = (value: unknown) => routes.get('scores')!(value)
  return { root, compact, full, receive, shown }
}

function rows(count: number, self: number): ScoreRow[] {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    name: `P${i + 1}`,
    wins: count - i,
    knockouts: i === 0 ? 3 : 0,
    parries: 2,
    streak: i === 0 ? 2 : 0,
    alive: i !== 1,
    self: i === self,
    leader: i === 0,
  }))
}

test('the compact leaderboard lists rank, name and wins and marks leader, self and eliminated players', () => {
  const view = board()
  view.receive({ rows: rows(3, 2), full: false })
  expect([...view.root.classes]).toEqual(['ShowLeaderboard'])
  expect(view.shown(view.compact)).toEqual([
    ['1', 'P1', '3'],
    ['2', 'P2', '2'],
    ['3', 'P3', '1'],
  ])
  expect(view.shown(view.full)).toEqual([])
  const [first, second, third] = view.compact.children
  expect([...first!.classes]).toEqual(['ScoreRow', 'Leader', 'OnStreak'])
  expect([...second!.classes]).toEqual(['ScoreRow', 'Out'])
  expect([...third!.classes]).toEqual(['ScoreRow', 'Self'])
})

test('the compact leaderboard keeps a viewer below the cut in its last row', () => {
  const view = board()
  view.receive({ rows: rows(8, 6), full: false })
  expect(view.shown(view.compact).map((row) => row[1])).toEqual([
    'P1',
    'P2',
    'P3',
    'P4',
    'P7',
  ])
})

test('intermission swaps to full standings and reuses rows when players leave', () => {
  const view = board()
  view.receive({ rows: rows(3, 0), full: false })
  view.receive({ rows: rows(3, 0), full: true })
  expect([...view.root.classes]).toEqual(['ShowStandings'])
  expect(view.shown(view.compact)).toEqual([])
  expect(view.shown(view.full)).toEqual([
    ['1', 'P1', '3', '2', '3', '2'],
    ['2', 'P2', '2', '-', '-', '2'],
    ['3', 'P3', '1', '-', '-', '2'],
  ])
  view.receive({ rows: rows(2, 0), full: true })
  expect(view.shown(view.full)).toHaveLength(2)
  expect(view.full.children).toHaveLength(3)
})

test('the board hides while no standings are sent, as while choosing an ability, or without scores', () => {
  const view = board()
  view.receive(undefined)
  expect(view.root.classes.size).toBe(0)
  view.receive({ rows: rows(3, 0), full: false })
  expect(view.shown(view.compact)).toHaveLength(3)
  view.receive(undefined)
  expect(view.root.classes.size).toBe(0)
  expect(view.shown(view.compact)).toEqual([])
  view.receive({ rows: 'bad', full: true })
  expect(view.root.classes.size).toBe(0)
  expect(view.shown(view.full)).toEqual([])
})
