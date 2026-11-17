import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { specialIds, specials } from '../gameplay/special'
import { Panel } from './panorama'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
const library = read('../.tools/modlock/js/built/layout.js')
const scripts = ['rally.js', 'specials.js'].map((name) =>
  read(`../content/citadel_addons/new_deadlock_game/panorama/scripts/${name}`),
)
const rallyIds = [
  'health_and_abilities_container',
  'minimap_persp',
  'CitadelHudHeroShop',
  'gameplay_hud_dead',
  'spectator_count',
]

type State = {
  id: string
  style: Record<string, string>
  text: string
  visible: boolean
  attributes: Record<string, string>
  children: State[]
}
function state(panel: Panel): State {
  return {
    id: panel.id,
    style: Object.fromEntries(
      Object.entries(panel.style).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
    text: panel.text,
    visible: panel.visible,
    attributes: Object.fromEntries(
      [...panel.attributes].filter(([, value]) => value !== ''),
    ),
    children: panel.children
      .filter((child) => child.valid && !child.made && child.id !== 'RallyHud')
      .map(state),
  }
}

function ui(nativeAbilityReady = true, sendChoices = true) {
  const screen = new Panel('root')
  const hud = new Panel('Hud', screen, 'CitadelHud')
  for (const id of rallyIds) new Panel(id, hud)
  hud.FindChildTraverse('minimap_persp')!.style.visibility = 'visible'
  hud.FindChildTraverse('CitadelHudHeroShop')!.style.opacity = '0.9'
  hud.FindChildTraverse('gameplay_hud_dead')!.visible = false
  const root = new Panel('RallyHud', screen)
  for (const id of [
    'RoundLabel',
    'RoundDetail',
    'AbilityCards',
    'RallyAbility',
    'SpecialName',
    'SpecialStatus',
  ])
    new Panel(id, root)
  const slot = new Panel(
    'slot_signature_3',
    root.FindChildTraverse('RallyAbility'),
    'CitadelAbilityIcon',
  )
  const loadAbility = () => {
    const button = new Panel('button_container', slot)
    new Panel('', button).AddClass('ability_bg')
    const images = new Panel('', button)
    images.AddClass('image_container')
    new Panel('', images, 'Label').AddClass('ability_name')
    new Panel('ability_image', images, 'Image').AddClass('ability_image')
    new Panel('cooldown_mask', images)
    const key = new Panel('', button)
    key.AddClass('ability_key_container')
    new Panel('ability_binding_component', key, 'CitadelBinding')
    new Panel('', button, 'Label').AddClass('cooldown_timer')
  }
  if (nativeAbilityReady) loadAbility()
  const dispatched: unknown[][] = []
  const scheduled = new Map<number, () => void>()
  const listeners: ((sound: string) => void)[] = []
  let scheduleId = 0
  const sandbox = createContext({
    $: {
      GetContextPanel: () => root,
      Msg: () => {},
      CreatePanel: (type: string, parent: Panel, id: string) =>
        Object.assign(new Panel(id, parent, type), { made: true }),
      DispatchEvent: (...args: unknown[]) => dispatched.push(args),
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
      CancelScheduled: (id: number) => {
        scheduled.delete(id)
      },
    },
  })
  const changed = () =>
    listeners.forEach((listener) => listener('modlock_data_changed'))
  const update = (value: unknown) => {
    root.SetAttributeString('modlock_route_special', JSON.stringify(value))
    changed()
  }
  const choices = {
    choices: specialIds.map((id) => ({ id, ...specials[id] })),
    nativeAbilityId: 123,
    playerSlot: 2,
  }
  const special = { choice: null, armed: false, available: true }
  const before = state(hud)
  if (sendChoices)
    root.SetAttributeString('modlock_route_choices', JSON.stringify(choices))
  root.SetAttributeString('modlock_route_special', JSON.stringify(special))
  for (const source of [library, ...scripts]) runInContext(source, sandbox)
  return {
    screen,
    hud,
    root,
    slot,
    before,
    scheduled,
    dispatched,
    update,
    special,
    choices,
    changed,
    unload: () => {
      root.SetAttributeString('modlock_unloading', '1')
      changed()
      root.DeleteAsync()
    },
    loadAbility,
    flush: () => {
      const pending = [...scheduled.values()]
      scheduled.clear()
      for (const action of pending) action()
    },
  }
}

test('picker shows three full cards with descriptions and stats before hover, and sends only a choice command', () => {
  const view = ui()
  const cards = view.root.FindChildTraverse('AbilityCards')!
  expect(cards.children).toHaveLength(3)
  expect(view.root.classes.has('Choosing')).toBe(true)
  for (const id of specialIds) {
    const button = cards.FindChildTraverse('Choose_' + id)!
    expect(button.paneltype).toBe('Button')
    expect(button.FindChildTraverse('RallyCardArt')?.image).toBe(
      specials[id].icon,
    )
    expect(button.FindChildTraverse('ChoiceName')?.text).toBe(specials[id].name)
    expect(button.FindChildTraverse('ChoiceCooldown')?.text).toBe(
      specials[id].cooldown + 's cooldown',
    )
    expect(button.FindChildTraverse('ChoiceText')?.text).toBe(
      specials[id].description,
    )
    expect(button.FindChildTraverse('ChoiceStat')?.text).toBe(specials[id].stat)
    expect(button.FindChildTraverse('ChoiceSelect')?.text).toBe(
      'CLICK TO CHOOSE',
    )
    expect(button.FindChildTraverse('CardPaper')?.paneltype).toBe('Image')
  }
  cards.FindChildTraverse('Choose_blink')!.events.get('onactivate')!()
  expect(view.dispatched).toEqual([['CitadelConCommand', 'rally_choose blink']])
  view.update({ ...view.special, choice: 'blink' })
  expect(view.root.classes.has('Choosing')).toBe(false)
  expect(view.root.classes.has('HasSpecial')).toBe(true)
  expect(view.slot.FindChildTraverse('RallySpecialImage')?.image).toBe(
    specials.blink.icon,
  )
  cards.FindChildTraverse('Choose_powerSlash')!.events.get('onactivate')!()
  expect(view.dispatched).toHaveLength(1)
  view.slot.events.get('onactivate')!()
  expect(view.dispatched[1]).toEqual(['CitadelConCommand', 'rally_special'])
  view.update({ ...view.special, choice: 'blink', available: false })
  view.slot.events.get('onactivate')!()
  expect(view.dispatched).toHaveLength(2)
})

test('custom hover replaces donor stats in a native tooltip and restores the pooled panel on unload', () => {
  const view = ui()
  const tooltip = new Panel(
    'tooltip',
    view.screen,
    'CitadelTooltipAbilityDetails',
  )
  tooltip.AddClass('TooltipVisible')
  const details = new Panel(
    'AbilityDetailsPanel',
    tooltip,
    'AbilityDetailsPanel',
  )
  const name = new Panel('', details, 'Label')
  name.AddClass('AbilityName')
  const tiers = new Panel('AbilityUpgradeList', tooltip)
  const sections = new Panel('SectionsContainer', details)
  const donorStats = new Panel('NativeHealingSlash', sections)
  view.update({ ...view.special, choice: 'timeFreeze' })
  view.slot.events.get('onmouseover')!()
  view.flush()
  expect(view.dispatched).toContainEqual([
    'CitadelShowAbilityDetailsTooltip',
    view.slot,
    123,
    2,
  ])
  expect(shown(name)).toBe('Time Freeze')
  expect(name.text).toBe('')
  expect(tiers.style.visibility).toBe('collapse')
  expect(donorStats.style.visibility).toBe('collapse')
  const custom = sections.FindChildTraverse('RallySpecialDescription')!
  expect(custom.FindChildTraverse('RallySpecialText')?.text).toBe(
    specials.timeFreeze.description,
  )
  view.unload()
  expect(tiers.style.visibility).toBeNull()
  expect(donorStats.style.visibility).toBeNull()
  expect(name.style.visibility).toBeNull()
  expect(shown(name)).toBe('')
  expect(custom.IsValid()).toBe(false)
  expect(view.dispatched.at(-1)).toEqual([
    'CitadelHideAbilityDetailsTooltip',
    view.slot,
  ])
})

test('selected icon stays ready when the engine replaces the donor image and readiness classes', () => {
  const view = ui()
  view.update({ ...view.special, choice: 'timeFreeze' })
  const original = view.slot.FindChildTraverse('ability_image')!
  const selected = view.slot.FindChildTraverse('RallySpecialImage')!
  expect(selected).toBeDefined()
  const images = original.GetParent()!
  const mask = view.slot.FindChildTraverse('cooldown_mask')!
  const background = view.slot.FindChildrenWithClassTraverse('ability_bg')[0]!
  const key = view.slot.FindChildrenWithClassTraverse(
    'ability_key_container',
  )[0]!
  const timer = view.slot.FindChildrenWithClassTraverse('cooldown_timer')[0]!
  timer.text = '17'
  mask.style.clip = 'radial(50% 50%, 0deg, 220deg)'
  for (let i = 0; i < 3; i++) {
    original.SetImage(specials.powerSlash.icon)
    view.slot.AddClass('ability_not_ready')
    view.slot.AddClass('not_trained')
    expect(selected.image).toBe(specials.timeFreeze.icon)
    expect(selected.style.opacity).toBe('1')
    expect(background.style.opacity).toBe('1')
    expect(images.style.opacity).toBe('1')
    expect(images.style.washColor).toBe('none')
    expect(key.style.opacity).toBe('1')
    expect(mask.style.opacity).toBe('0')
    view.flush()
    expect(original.image).toBe(specials.powerSlash.icon)
    expect(original.style.visibility).toBe('collapse')
    expect(selected.image).toBe(specials.timeFreeze.icon)
    expect(selected.style.visibility).toBe('visible')
    expect(selected.style.opacity).toBe('1')
    expect(selected.style.washColor).toBe('#252923')
    expect(background.style.opacity).toBe('1')
    expect(background.style.washColor).toBe('#eeeae3')
    expect(images.style.opacity).toBe('1')
    expect(images.style.washColor).toBe('none')
    expect(images.style.saturation).toBe('1')
    expect(key.style.opacity).toBe('1')
    expect(mask.style.opacity).toBe('0')
    expect(images.children.indexOf(selected)).toBeLessThan(
      images.children.indexOf(mask),
    )
  }
  view.update({ ...view.special, choice: 'timeFreeze', available: false })
  expect(selected.style.opacity).toBe('0.5')
  expect(background.style.opacity).toBe('0.18')
  expect(key.style.opacity).toBe('0.55')
  expect(mask.style.opacity).toBe('0.9')
  expect(mask.style.clip).toBe('radial(50% 50%, 0deg, 220deg)')
  expect(timer.text).toBe('17')
  expect(
    view.slot.FindChildTraverse('ability_binding_component')?.paneltype,
  ).toBe('CitadelBinding')
  view.update({ ...view.special, choice: 'timeFreeze', available: true })
  expect(selected.style.opacity).toBe('1')
  expect(background.style.opacity).toBe('1')
  expect(mask.style.opacity).toBe('0')
  view.unload()
})

test('late native ability loading gets the selected icon without changed server data', () => {
  const view = ui(false)
  view.update({ ...view.special, choice: 'blink' })
  view.loadAbility()
  view.flush()
  expect(view.slot.FindChildTraverse('RallySpecialImage')?.image).toBe(
    specials.blink.icon,
  )
  expect(view.slot.FindChildTraverse('ability_image')?.style.visibility).toBe(
    'collapse',
  )
  view.slot.FindChildTraverse('RallySpecialImage')!.events.get('onactivate')!()
  expect(view.dispatched).toEqual([['CitadelConCommand', 'rally_special']])
  view.unload()
})

function shown(label: Panel): string {
  if (label.style.visibility !== 'collapse') return label.text
  const siblings = label.GetParent()!.children
  return (
    siblings
      .slice(siblings.indexOf(label) + 1)
      .find((sibling) => sibling.valid && sibling.made)?.text ?? ''
  )
}

function directWrites(old: State, panel: Panel): string[] {
  const now = state(panel)
  const saved = Object.keys(
    JSON.parse(panel.GetAttributeString('modlock_native', '') || '{}'),
  )
  const found: string[] = []
  for (const name of new Set([
    ...Object.keys(old.style),
    ...Object.keys(now.style),
  ]))
    if (old.style[name] !== now.style[name] && !saved.includes(`style.${name}`))
      found.push(`${old.id} style.${name}`)
  if (old.text !== now.text) found.push(`${old.id} text`)
  const children = panel.children.filter(
    (child) =>
      child.valid &&
      !child.made &&
      child.id !== 'RallyHud' &&
      child.id !== 'RallySpecialDescription',
  )
  old.children.forEach((child, index) => {
    if (children[index]) found.push(...directWrites(child, children[index]))
  })
  return found
}

test('the rally hides native HUD panels only through Modlock.native and unloading hands each panel back', () => {
  const view = ui()
  const tooltip = new Panel(
    'tooltip',
    view.screen,
    'CitadelTooltipAbilityDetails',
  )
  tooltip.AddClass('TooltipVisible')
  const details = new Panel(
    'AbilityDetailsPanel',
    tooltip,
    'AbilityDetailsPanel',
  )
  const name = new Panel('', details, 'Label')
  name.AddClass('AbilityName')
  name.text = '{s:ability_name}'
  const sections = new Panel('SectionsContainer', details)
  new Panel('NativeHealingSlash', sections)
  const tooltipBefore = state(tooltip)
  view.update({ ...view.special, choice: 'blink' })
  view.slot.events.get('onmouseover')!()
  view.flush()
  for (const id of rallyIds) {
    const panel = view.hud.FindChildTraverse(id)!
    expect(panel.style.visibility).toBe('collapse')
    expect(panel.style.opacity).toBe('0')
    expect(panel.visible).toBe(false)
  }
  expect(shown(name)).toBe(specials.blink.name)
  expect(directWrites(view.before, view.hud)).toEqual([])
  expect(directWrites(tooltipBefore, tooltip)).toEqual([])
  view.unload()
  view.flush()
  expect(view.scheduled.size).toBe(0)
  expect(state(view.hud)).toEqual(view.before)
  expect(state(tooltip)).toEqual(tooltipBefore)
  expect(view.hud.FindChildTraverse('minimap_persp')!.style.visibility).toBe(
    'visible',
  )
  expect(view.hud.FindChildTraverse('CitadelHudHeroShop')!.style.opacity).toBe(
    '0.9',
  )
  expect(view.hud.FindChildTraverse('gameplay_hud_dead')!.visible).toBe(false)
})

test('the cards wait for the choices route, and a new notice alone repaints nothing', () => {
  const view = ui(true, false)
  const cards = view.root.FindChildTraverse('AbilityCards')!
  expect(cards.children).toHaveLength(0)
  expect(view.root.classes.has('Choosing')).toBe(false)
  view.root.SetAttributeString(
    'modlock_route_choices',
    JSON.stringify(view.choices),
  )
  view.changed()
  expect(cards.children).toHaveLength(3)
  expect(view.root.classes.has('Choosing')).toBe(true)
  view.update({ ...view.special, choice: 'blink' })
  const image = view.slot.FindChildTraverse('RallySpecialImage')!
  image.style.opacity = 'painted elsewhere'
  view.root.SetAttributeString(
    'modlock_data',
    JSON.stringify({ title: 'ROUND 2', detail: '', spectating: false }),
  )
  view.changed()
  expect(image.style.opacity).toBe('painted elsewhere')
  view.update({ ...view.special, choice: 'blink', available: false })
  expect(image.style.opacity).toBe('0.5')
  view.unload()
})
