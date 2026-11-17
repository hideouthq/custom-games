import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Panel } from './panorama'

function meter() {
  const root = new Panel('RallyHud')
  const panel = new Panel('RallyMeter', root)
  const count = new Panel('RallyCount', panel)
  const caption = new Panel('RallyCaption', panel)
  const pips = new Panel('RallyPips', panel)
  for (let i = 0; i < 5; i++) new Panel('', pips)
  const scheduled = new Map<number, () => void>()
  let nextId = 0
  const routes = new Map<string, (value: unknown) => void>()
  runInNewContext(
    readFileSync(
      new URL(
        '../content/citadel_addons/new_deadlock_game/panorama/scripts/meter.js',
        import.meta.url,
      ),
      'utf8',
    ),
    {
      $: {
        GetContextPanel: () => root,
        Schedule: (_seconds: number, action: () => void) => {
          scheduled.set(++nextId, action)
          return nextId
        },
        CancelScheduled: (id: number) => scheduled.delete(id),
      },
      Modlock: {
        route: (name: string, handler: (value: unknown) => void) => {
          routes.set(name, handler)
        },
        onUnload: () => {},
      },
    },
  )
  expect([...routes.keys()]).toEqual(['rally'])
  const receive = (value: unknown) => routes.get('rally')!(value)
  const lit = () => pips.children.filter((pip) => pip.classes.has('Lit')).length
  const settle = () => {
    const actions = [...scheduled.values()]
    scheduled.clear()
    actions.forEach((action) => action())
  }
  return { root, panel, count, caption, lit, settle, receive }
}

test('the rally meter appears on the second return and pops on each one after', () => {
  const view = meter()
  view.receive({ count: 1, live: true })
  expect(view.root.classes.has('ShowRally')).toBe(false)
  view.receive({ count: 2, live: true })
  expect(view.root.classes.has('ShowRally')).toBe(true)
  expect(view.count.text).toBe('2')
  expect(view.caption.text).toBe('RALLY')
  expect(view.lit()).toBe(2)
  expect(view.panel.classes.has('Pop')).toBe(true)
  view.settle()
  expect(view.panel.classes.has('Pop')).toBe(false)
  view.receive({ count: 2, live: true })
  expect(view.panel.classes.has('Pop')).toBe(false)
  view.receive({ count: 3, live: true })
  expect(view.panel.classes.has('Pop')).toBe(true)
})

test('five returns fill the pips and raise the heat, which tops out at fifteen', () => {
  const view = meter()
  const heat = () =>
    ['Warm', 'Hot', 'Blazing'].filter((name) => view.panel.classes.has(name))
  view.receive({ count: 4, live: true })
  expect([view.lit(), heat()]).toEqual([4, []])
  view.receive({ count: 5, live: true })
  expect([view.lit(), heat()]).toEqual([5, ['Warm']])
  view.receive({ count: 6, live: true })
  expect([view.lit(), heat()]).toEqual([1, ['Warm']])
  view.receive({ count: 10, live: true })
  expect([view.lit(), heat()]).toEqual([5, ['Hot']])
  view.receive({ count: 23, live: true })
  expect([view.lit(), heat()]).toEqual([3, ['Blazing']])
})

test('a knockout leaves the count up as over, and the next serve clears it', () => {
  const view = meter()
  view.receive({ count: 7, live: true })
  view.receive({ count: 7, live: false })
  expect(view.panel.classes.has('Broken')).toBe(true)
  expect(view.caption.text).toBe('RALLY OVER')
  expect(view.count.text).toBe('7')
  view.receive({ count: 0, live: true })
  expect(view.root.classes.has('ShowRally')).toBe(false)
  expect(view.panel.classes.has('Broken')).toBe(false)
  expect(view.lit()).toBe(0)
  view.receive({ count: 'bad' })
  expect(view.root.classes.has('ShowRally')).toBe(false)
})
