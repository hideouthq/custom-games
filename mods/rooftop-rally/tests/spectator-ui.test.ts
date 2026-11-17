import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { Panel } from './panorama'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
const library = read('../.tools/modlock/js/built/layout.js')
const rally = read(
  '../content/citadel_addons/new_deadlock_game/panorama/scripts/rally.js',
)

function setNativeVisibility(panel: Panel, visible: boolean): void {
  panel.visible = visible
  panel.style.visibility = visible ? 'visible' : 'collapse'
  panel.style.opacity = visible ? '0.75' : '0'
}

function nativePanel(id: string, parent: Panel): Panel {
  const panel = new Panel(id, parent)
  setNativeVisibility(panel, true)
  return panel
}

function expectVisibility(panel: Panel, visible: boolean): void {
  expect(panel.visible).toBe(visible)
  expect(panel.style).toEqual({
    visibility: visible ? 'visible' : 'collapse',
    opacity: visible ? '0.75' : '0',
  })
}

function ui() {
  const top = new Panel('Hud')
  const root = new Panel('RallyHud', top)
  new Panel('RoundLabel', root)
  new Panel('RoundDetail', root)
  const controls = [nativePanel('spectate_bar', top)]
  for (const panel of controls) setNativeVisibility(panel, false)
  const health = nativePanel('health_and_abilities_container', top)
  const respawn = nativePanel('gameplay_hud_dead', top)
  const scheduled = new Map<number, () => void>()
  let scheduleId = 0
  const listeners: ((sound: string) => void)[] = []
  const changed = () =>
    listeners.forEach((listener) => listener('modlock_data_changed'))
  const sandbox = createContext({
    $: {
      GetContextPanel: () => root,
      Msg: () => {},
      RegisterForUnhandledEvent: (
        name: string,
        listener: (sound: string) => void,
      ) => {
        if (name === 'PlaySoundEffect') listeners.push(listener)
      },
      Schedule: (_seconds: number, action: () => void) => {
        scheduled.set(++scheduleId, action)
        return scheduleId
      },
      CancelScheduled: (id: number) => scheduled.delete(id),
    },
  })
  for (const source of [library, rally]) runInContext(source, sandbox)
  const update = (value: unknown) => {
    root.SetAttributeString('modlock_data', JSON.stringify(value))
    changed()
  }
  const unload = () => {
    root.SetAttributeString('modlock_unloading', '1')
    changed()
    root.DeleteAsync()
  }
  return {
    top,
    root,
    controls,
    health,
    respawn,
    update,
    unload,
    pending: () => scheduled.size,
    sweep: () => {
      const pending = [...scheduled.values()]
      scheduled.clear()
      for (const action of pending) action()
    },
  }
}

test('native spectator visibility survives playing and spectating data updates and sweeps', () => {
  const view = ui()
  for (const spectating of [false, true, true, false]) {
    view.update({ spectating })
    expect(view.root.classes.has('Spectating')).toBe(spectating)
    for (const panel of view.controls) {
      setNativeVisibility(panel, spectating)
    }
    for (let i = 0; i < 3; i++) {
      view.update({ spectating })
      view.sweep()
      for (const panel of view.controls) expectVisibility(panel, spectating)
      expectVisibility(view.health, false)
      expectVisibility(view.respawn, false)
    }
  }
  view.unload()
})

test('replacement native spectator panels retain their own visibility while replacement health HUD is suppressed', () => {
  const view = ui()
  view.update({ spectating: true })
  for (const panel of [...view.controls, view.health]) panel.valid = false
  const controls = view.controls.map((panel) => nativePanel(panel.id, view.top))
  const health = nativePanel(view.health.id, view.top)
  for (const visible of [true, false, true]) {
    for (const panel of controls) setNativeVisibility(panel, visible)
    view.sweep()
    for (const panel of controls) expectVisibility(panel, visible)
    expectVisibility(health, false)
  }
  view.unload()
  expectVisibility(health, true)
})

test('unload restores the suppressed HUD without rolling back native spectator visibility', () => {
  const view = ui()
  expectVisibility(view.health, false)
  view.update({ spectating: true })
  for (const panel of view.controls) setNativeVisibility(panel, true)
  view.unload()
  expect(view.pending()).toBe(0)
  view.sweep()
  for (const panel of view.controls) expectVisibility(panel, true)
  expectVisibility(view.health, true)
})
