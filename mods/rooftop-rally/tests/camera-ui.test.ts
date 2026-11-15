import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function camera({ inHideout = false } = {}) {
  const commands: string[] = []
  const scheduled = new Map<number, () => void>()
  let scheduleId = 0
  let unload = () => {}
  let receive: (value: unknown) => void = () => {}
  const events = new Map<string, () => unknown>()
  const hudClasses = new Set<string>()
  if (inHideout) hudClasses.add('InHideout')
  const hud = {
    id: 'Hud',
    IsValid: () => true,
    BHasClass: (name: string) => hudClasses.has(name),
    GetParent: () => null,
  }
  const root = {
    id: 'RallyHud',
    valid: true,
    IsValid: () => root.valid,
    GetParent: () => hud,
  }
  runInNewContext(
    readFileSync(
      new URL(
        '../content/citadel_addons/new_deadlock_game/panorama/scripts/camera.js',
        import.meta.url,
      ),
      'utf8',
    ),
    {
      $: {
        GetContextPanel: () => root,
        Schedule: (_seconds: number, action: () => void) => {
          scheduled.set(++scheduleId, action)
          return scheduleId
        },
        CancelScheduled: (id: number) => scheduled.delete(id),
        RegisterForUnhandledEvent: (event: string, handler: () => unknown) => {
          events.set(event, handler)
        },
        DispatchEvent: (event: string, command: string) => {
          expect(event).toBe('CitadelConCommand')
          commands.push(command)
        },
      },
      Modlock: {
        data: (handler: (value: unknown) => void) => {
          receive = handler
        },
        onUnload: (handler: () => void) => {
          unload = handler
        },
      },
    },
  )
  return {
    root,
    hudClasses,
    commands,
    unload,
    receive,
    events,
    pending: () => scheduled.size,
    tick: () => {
      const pending = [...scheduled.values()]
      scheduled.clear()
      for (const action of pending) action()
    },
  }
}

const on = 'citadel_camera_overrides_enabled 1'
const off = 'citadel_camera_overrides_enabled 0'

test('a living player keeps the hero camera, so crouching and sliding use the native rig', () => {
  const view = camera()
  view.tick()
  expect(view.commands).toEqual([])
  view.receive({ spectating: false })
  for (let i = 0; i < 5; i++) view.tick()
  expect(view.commands).toEqual([off])
})

test('the override follows spectating and is released on returning to play', () => {
  const view = camera()
  view.receive({ spectating: false })
  view.receive({ spectating: true })
  view.receive({ spectating: true })
  view.tick()
  expect(view.commands).toEqual([off, on])
  view.receive({ spectating: false })
  view.tick()
  expect(view.commands).toEqual([off, on, off])
})

test('joining clears an override an earlier session left enabled', () => {
  const view = camera()
  view.receive({})
  expect(view.commands).toEqual([off])
})

test('unload releases the override once and stops polling', () => {
  const view = camera()
  view.receive({ spectating: true })
  view.unload()
  view.unload()
  view.receive({ spectating: true })
  view.tick()
  expect(view.commands).toEqual([on, off])
  expect(view.pending()).toBe(0)
})

test('unload before any mode data changes nothing', () => {
  const view = camera()
  view.unload()
  view.tick()
  expect(view.commands).toEqual([])
  expect(view.pending()).toBe(0)
})

test('a destroyed HUD releases an override already applied', () => {
  const view = camera()
  view.receive({ spectating: true })
  view.root.valid = false
  view.tick()
  expect(view.commands).toEqual([on, off])
  expect(view.pending()).toBe(0)
})

test('entering Hideout releases the override and waits for fresh mode data', () => {
  const view = camera()
  view.receive({ spectating: true })
  view.hudClasses.add('InHideout')
  for (let i = 0; i < 3; i++) view.tick()
  view.receive({ spectating: true })
  expect(view.commands).toEqual([on, off])
  view.hudClasses.delete('InHideout')
  for (let i = 0; i < 3; i++) view.tick()
  expect(view.commands).toEqual([on, off])
  view.receive({ spectating: true })
  expect(view.commands).toEqual([on, off, on])
  view.unload()
  expect(view.commands).toEqual([on, off, on, off])
})

test('mounting in Hideout writes nothing until the mode sends data in a match', () => {
  const view = camera({ inHideout: true })
  view.receive({ spectating: true })
  for (let i = 0; i < 3; i++) view.tick()
  expect(view.commands).toEqual([])
  view.hudClasses.delete('InHideout')
  view.tick()
  expect(view.commands).toEqual([])
  view.receive({ spectating: false })
  expect(view.commands).toEqual([off])
  view.unload()
})

test('malformed data never changes the setting', () => {
  const view = camera()
  view.receive(undefined)
  view.receive('spectating')
  view.tick()
  expect(view.commands).toEqual([])
  view.unload()
})

test('leaving or quitting while spectating releases the override without waiting for unload', () => {
  for (const event of ['CitadelDisconnectFromGame', 'GameSystemGameShutdown']) {
    const view = camera()
    view.receive({ spectating: true })
    // The event goes on to the game's own handlers.
    expect(view.events.get(event)!()).toBe(false)
    view.unload()
    expect(view.commands).toEqual([on, off])
    expect(view.pending()).toBe(0)
  }
})
