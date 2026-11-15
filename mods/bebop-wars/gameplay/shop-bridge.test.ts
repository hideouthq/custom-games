import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const library = read('../.tools/modlock/js/built/layout.js')
const scripts = {
  items: read('../content/citadel_addons/bebop_wars/panorama/scripts/native_items.js'),
  bridge: read('../content/citadel_addons/bebop_wars/panorama/scripts/loadout_bridge.js'),
  hook: read('../content/citadel_addons/bebop_wars/panorama/scripts/native_hook.js'),
}

class Panel {
  valid = true
  made = false
  hovered = false
  visible = true
  hittest = true
  hittestchildren = true
  text = ''
  image = ''
  style: Record<string, string | null | undefined> = {}
  attributes = new Map<string, string>()
  classes = new Set<string>()
  children: Panel[] = []
  events = new Map<string, () => unknown>()
  variables: Record<string, string | number> = {}
  readonly paneltype: string
  readonly parent: Panel | null
  readonly id: string
  constructor(paneltype: string, parent: Panel | null = null, id = '', classes: string[] = []) {
    this.paneltype = paneltype; this.parent = parent; this.id = id; parent?.children.push(this)
    classes.forEach(name => this.classes.add(name))
  }
  IsValid() { return this.valid }
  GetParent() { return this.parent }
  GetChildCount() { return this.children.length }
  GetChild(index: number) { return this.children[index] }
  FindChildTraverse(id: string): Panel | null { return this.children.find(child => child.id === id && child.valid) ?? this.children.flatMap(child => child.FindChildTraverse(id) ?? [])[0] ?? null }
  FindChildrenWithClassTraverse(name: string): Panel[] { return this.children.flatMap(child => [...(child.classes.has(name) ? [child] : []), ...child.FindChildrenWithClassTraverse(name)]) }
  BHasClass(name: string) { return this.classes.has(name) }
  BHasHoverStyle() { return this.hovered }
  AddClass(name: string) { this.classes.add(name) }
  SetHasClass(name: string, on: boolean) { if (on) this.classes.add(name); else this.classes.delete(name) }
  GetAttributeString(name: string, fallback: string) { return this.attributes.get(name) ?? fallback }
  SetAttributeString(name: string, value: string) { this.attributes.set(name, value) }
  SetPanelEvent(name: string, callback: () => unknown) { this.events.set(name, callback) }
  SetDialogVariable(name: string, value: string) { this.variables[name] = value }
  SetDialogVariableInt(name: string, value: number) { this.variables[name] = value }
  SetImage(value: string) { this.image = value }
  MoveChildBefore(child: Panel, before: Panel) { this.children.splice(this.children.indexOf(child), 1); this.children.splice(this.children.indexOf(before), 0, child) }
  MoveChildAfter(child: Panel, after: Panel) { this.children.splice(this.children.indexOf(child), 1); this.children.splice(this.children.indexOf(after) + 1, 0, child) }
  DeleteAsync() { this.valid = false }
  RemoveAndDeleteChildren() { for (const child of this.children) child.valid = false; this.children = [] }
}

const product = { id: 'snowGlobe', nativeId: 100, name: 'Snow Globe', price: 300, cooldown: 16, description: 'Throw and detonate a snowball.', state: 'buy', label: 'Buy', detail: 'Yours this match.', action: { kind: 'buy', product: 'snowGlobe' } }
const echo = { ...product, id: 'echo', nativeId: 101, name: 'Echo Shard', action: null }
function shopData(menu = 'closed', canShop = true, items: { product: string; slot: number }[] = []) {
  return { menu, canShop, native: { slot: 4, items }, shop: { allowed: true, reason: '', products: [product, echo] } }
}
const hookData = { hookId: 123, slot: 4, range: 36, cooldown: 4 }

function localized(label: Panel, value: string) {
  label.text = value
  return label
}

function nativeHud() {
  const root = new Panel('Panel', null, 'root')
  const hud = new Panel('CitadelHud', root, 'Hud')
  const shop = new Panel('CitadelHudHeroShop', hud, 'CitadelHudHeroShop')
  const shell = new Panel('Panel', shop, 'ShopModListsContainer')
  const catalog = new Panel('Panel', shell, 'ShopModsSelectedBuild')
  for (const id of ['ShopNavigation', 'ReadOnlyShop', 'PriceTierShortcuts', 'RecentPurchasesPanel', 'ShopSettingsButton']) new Panel('Panel', shop, id)
  const quickBuy = new Panel('CitadelHudQuickbuy', hud, 'CitadelHudQuickbuy')
  quickBuy.style.visibility = 'visible'

  const signature = new Panel('Panel', hud, 'hud_signature')
  for (const index of [1, 2, 4]) new Panel('CitadelAbilityIcon', signature, `slot_signature_${index}`)
  const hook = new Panel('CitadelAbilityIcon', signature, 'slot_signature_3')
  const button = new Panel('Panel', hook, 'button_container')
  const hookImage = new Panel('Image', button, 'ability_image')
  hookImage.hittest = false
  const binding = new Panel('CitadelBinding', button, 'ability_binding_component')
  const pip = new Panel('Panel', new Panel('Panel', hook, 'AbilityButton'), 'AbilityUnlock1')
  let upgrades = 0
  pip.SetPanelEvent('onactivate', () => { upgrades++ })
  pip.SetPanelEvent('onmouseover', () => {})

  const inventory = new Panel('ActiveAbilitiesMenu', hud, 'ActiveAbilitiesMenu')
  for (let index = 0; index < 4; index++) {
    const slot = new Panel('DraggableAbilityIcon', inventory, `abilityButton${index}`)
    const images = new Panel('Panel', slot, 'image_container')
    new Panel('Image', images, 'ability_image').image = 'native-donor-glyph'
    new Panel('Panel', images, 'cooldown_mask')
    new Panel('Label', slot, '', ['ability_name']).text = 'Cold Front'
  }
  const grid = new Panel('CitadelModsPurchasedPanel', hud, 'ModPurchasedPanelUniversal')
  const snowIcon = new Panel('CitadelModIcon', grid, 'ModIcon0', ['iceBlast'])
  new Panel('Image', snowIcon, 'ModIconImage').image = 'native-cold-front'
  const echoIcon = new Panel('CitadelModIcon', grid, 'ModIcon1', ['powerShard'])
  new Panel('Image', echoIcon, 'ModIconImage').image = 'native-echo'

  const abilityTip = new Panel('CitadelTooltipAbilityDetails', root, 'AbilityTooltip', ['TooltipVisible'])
  const details = new Panel('Panel', abilityTip, 'AbilityDetailsPanel')
  const abilityName = localized(new Panel('Label', details, 'Title', ['AbilityName']), 'Localized native Hook')
  const description = localized(new Panel('Label', details, 'AbilityDescription'), 'Native description')
  const damage = new Panel('Panel', details, 'AbilityProperty_Damage')
  new Panel('Label', damage, 'ScalingStatLabel')
  const range = new Panel('Panel', details, 'AbilityProperty_AbilityCastRange')
  for (const row of [damage, range]) {
    localized(new Panel('Label', row, 'Current', ['CurrentValue']), 'Native value')
    localized(new Panel('Label', row, 'Base', ['BaseValue']), 'Native base')
  }
  const cooldown = new Panel('Panel', details, 'AbilityCooldown')
  localized(new Panel('Label', cooldown, 'BaseLabel'), '23s')
  const tiers = new Panel('Panel', abilityTip, 'AbilityUpgradeList')
  for (let i = 0; i < 3; i++) {
    const tier = new Panel('Panel', tiers, `Tier${i}`)
    localized(new Panel('Label', tier, 'upgradeDesc'), `Native tier ${i}`)
    localized(new Panel('Label', tier, 'Bonus', ['upgradeBonusAmount']), '+20%')
  }

  const hiddenTip = new Panel('CitadelTooltipAbilityDetails', root, 'PooledTooltip')
  localized(new Panel('Label', new Panel('Panel', hiddenTip, 'AbilityDetailsPanel'), 'Title', ['AbilityName']), 'Hidden native tooltip')
  const itemTip = new Panel('CitadelTooltipModDetails', root, 'CitadelModDetailsTooltip', ['TooltipVisible'])
  const itemName = localized(new Panel('Label', itemTip, 'ModName'), 'Native Cold Front')
  const itemCost = localized(new Panel('Label', itemTip, '', ['ModCost']), '1600')
  new Panel('Panel', itemTip, 'ModImage').style.backgroundImage = 'native-art'
  const attributes = new Panel('Panel', itemTip, '', ['AttributesContainer'])
  const sections = new Panel('Panel', attributes, 'SectionsContainer')

  return { root, hud, shop, shell, catalog, quickBuy, hiddenTip, hook, hookImage, binding, pip, upgrades: () => upgrades, inventory, snowIcon, echoIcon, abilityTip, abilityName, description, range, cooldown, tiers, itemTip, itemName, itemCost, sections }
}

function game() {
  const ui = nativeHud()
  const scheduled = new Map<number, () => void>()
  const events: unknown[][] = []
  let next = 0
  function layout(sources: string[]) {
    const context = new Panel('Panel', ui.hud, 'ModeLayout')
    const listeners: ((sound: string) => void)[] = []
    const sandbox = createContext({
      $: {
        GetContextPanel: () => context,
        Msg: () => {},
        CreatePanel: (type: string, parent: Panel, id: string) => Object.assign(new Panel(type, parent, id), { made: true }),
        Schedule: (_delay: number, callback: () => void) => { scheduled.set(++next, callback); return next },
        CancelScheduled: (handle: number) => { scheduled.delete(handle) },
        DispatchEvent: (...args: unknown[]) => { events.push(args) },
        RegisterForUnhandledEvent: (name: string, callback: (sound: string) => void) => { if (name === 'PlaySoundEffect') listeners.push(callback) },
      },
    })
    const changed = () => listeners.forEach(listener => listener('modlock_data_changed'))
    return {
      context,
      run() { for (const source of [library, ...sources]) runInContext(source, sandbox) },
      data(value: unknown) { context.SetAttributeString('modlock_data', JSON.stringify(value)); changed() },
      unload() { context.SetAttributeString('modlock_unloading', '1'); changed(); context.DeleteAsync() },
    }
  }
  const shop = layout([scripts.items, scripts.bridge])
  const hook = layout([scripts.hook])
  return {
    ...ui, events, scheduled, layout, shopLayout: shop, hookLayout: hook,
    tick() { [...scheduled.entries()].forEach(([handle, callback]) => { scheduled.delete(handle); callback() }) },
    start(data: unknown = shopData()) {
      shop.data(data); hook.data(hookData)
      shop.run(); hook.run()
      this.tick()
    },
  }
}

type State = { id: string; type: string; style: Record<string, unknown>; text: string; visible: boolean; hittest: boolean; hittestchildren: boolean; image: string; events: string[]; attributes: Record<string, string>; children: State[] }
const created = new Set(['ModeLayout', 'BebopNativeCatalog', 'BebopItemArt', 'BebopItemDetails'])
const natives = (panel: Panel) => panel.children.filter(child => child.valid && !child.made && !created.has(child.id))
function shown(label: Panel): string {
  if (label.style.visibility !== 'collapse') return label.text
  const siblings = label.GetParent()!.children
  return siblings.slice(siblings.indexOf(label) + 1).find(sibling => sibling.valid && sibling.made)?.text ?? ''
}
function state(panel: Panel): State {
  return {
    id: panel.id, type: panel.paneltype,
    style: Object.fromEntries(Object.entries(panel.style).filter(([, value]) => value !== null && value !== undefined)),
    text: panel.text, visible: panel.visible, hittest: panel.hittest, hittestchildren: panel.hittestchildren, image: panel.image,
    events: [...panel.events.keys()],
    attributes: Object.fromEntries([...panel.attributes].filter(([, value]) => value !== '')),
    children: natives(panel).map(state),
  }
}
function directWrites(old: State, panel: Panel, path = ''): string[] {
  const here = `${path}/${old.id || old.type}`
  const now = state(panel)
  const saved = Object.keys(JSON.parse(panel.GetAttributeString('modlock_native', '') || '{}'))
  const found: string[] = []
  for (const name of new Set([...Object.keys(old.style), ...Object.keys(now.style)])) if (old.style[name] !== now.style[name] && !saved.includes(`style.${name}`)) found.push(`${here} style.${name}`)
  for (const name of ['visible', 'hittest', 'hittestchildren'] as const) if (old[name] !== now[name] && !saved.includes(name)) found.push(`${here} ${name}`)
  if (old.text !== now.text) found.push(`${here} text`)
  if (old.image !== now.image) found.push(`${here} image`)
  if (old.events.join() !== now.events.join()) found.push(`${here} events`)
  if (Object.keys(now.attributes).some(name => name !== 'modlock_native' && !(name in old.attributes))) found.push(`${here} attributes`)
  const children = natives(panel)
  old.children.forEach((child, index) => { if (children[index]) found.push(...directWrites(child, children[index], here)) })
  return found
}

test('every native change goes through Modlock.native and unloading puts the whole HUD back', () => {
  const ui = game()
  const before = state(ui.root)
  ui.start(shopData('closed', true, [{ product: 'snowGlobe', slot: 5 }, { product: 'echo', slot: 4 }]))
  ui.shop.AddClass('gShopOpen'); ui.tick()
  ui.hook.hovered = true; ui.tick()
  const snowSlot = ui.inventory.FindChildTraverse('abilityButton1')!
  snowSlot.hovered = true; ui.tick()
  assert.equal(ui.catalog.style.visibility, 'collapse')
  assert.equal(ui.quickBuy.style.visibility, 'collapse')
  assert.equal(shown(ui.abilityName), 'Hook')
  assert.equal(shown(ui.itemName), 'Snow Globe')
  assert.equal(snowSlot.FindChildTraverse('ability_image')?.style.opacity, '0')
  assert.deepEqual(directWrites(before, ui.root), [])
  ui.shopLayout.unload(); ui.hookLayout.unload()
  ui.tick()
  assert.equal(ui.scheduled.size, 0)
  ui.shop.SetHasClass('gShopOpen', false)
  assert.deepEqual(state(ui.root), before)
})

test('native shop keeps its shell and wallet, replacing only catalog content', () => {
  const ui = game()
  ui.start()
  assert.equal(ui.shop.style.opacity, undefined)
  assert.equal(ui.catalog.style.visibility, 'collapse')
  const card = ui.shell.FindChildTraverse('BebopProduct_snowGlobe')
  assert.equal(card?.paneltype, 'CitadelShopMod')
  assert.equal(card?.style.width, undefined)
  ui.shell.FindChildTraverse('BebopBuy_snowGlobe')?.events.get('onactivate')?.()
  assert.deepEqual(ui.events.filter(event => event[0] === 'CitadelConCommand'), [['CitadelConCommand', 'bebop_buy snowGlobe']])
})

test('browse-only cards cannot buy and owned utilities use explicit equip requests', () => {
  const ui = game()
  ui.start()
  const data = shopData()
  const commands = () => ui.events.filter(event => event[0] === 'CitadelConCommand')
  ui.shopLayout.data({ ...data, shop: { allowed: false, reason: 'Return to your shop.', products: [{ ...product, state: 'locked', action: null }] } })
  ui.shell.FindChildTraverse('BebopBuy_snowGlobe')?.events.get('onactivate')?.()
  assert.deepEqual(commands(), [])
  assert.equal(ui.shell.FindChildTraverse('BebopShopAccess')?.text, 'Return to your shop.')
  ui.shopLayout.data({ ...data, shop: { ...data.shop, products: [{ ...product, action: { kind: 'equip', utility: 'echo' } }] } })
  ui.shell.FindChildTraverse('BebopBuy_snowGlobe')?.events.get('onactivate')?.()
  assert.deepEqual(commands(), [['CitadelConCommand', 'bebop_equip echo']])
})

test('native open survives delayed server acknowledgement and closes explicitly', () => {
  const ui = game()
  ui.start()
  const commands = () => ui.events.filter(event => event[0] === 'CitadelConCommand')
  ui.shop.AddClass('gShopOpen'); ui.tick()
  ui.shopLayout.data(shopData()); ui.tick()
  ui.shopLayout.data(shopData('loadout')); ui.tick()
  assert.deepEqual(commands(), [['CitadelConCommand', 'loadout']])
  ui.shop.SetHasClass('gShopOpen', false); ui.tick()
  assert.deepEqual(commands()[1], ['CitadelConCommand', 'loadout close'])
})

test('server lock closes native shop once without an echo close command', () => {
  const ui = game()
  ui.start()
  ui.shop.AddClass('gShopOpen'); ui.tick()
  ui.shopLayout.data(shopData('loadout')); ui.shopLayout.data(shopData('closed', false)); ui.tick()
  ui.shop.SetHasClass('gShopOpen', false); ui.tick()
  assert.deepEqual(ui.events.filter(event => event[0] === 'CitadelConCommand' || event[0] === 'CitadelExitUpgradeShop'), [['CitadelConCommand', 'loadout'], ['CitadelExitUpgradeShop']])
})

test('a replacement shop layout keeps the native catalog and Quick Buy hidden until it unloads too', () => {
  const ui = game()
  ui.start()
  const replacement = ui.layout([scripts.items, scripts.bridge])
  replacement.data(shopData()); replacement.run(); ui.tick()
  ui.shopLayout.unload(); ui.tick()
  assert.equal(ui.quickBuy.style.visibility, 'collapse')
  assert.equal(ui.catalog.style.visibility, 'collapse')
  replacement.unload(); ui.tick()
  assert.equal(ui.quickBuy.style.visibility, 'visible')
  assert.equal(ui.catalog.style.visibility, null)
})

test('hovering Hook shows Bebop values in place of the pooled tooltip\'s labels without writing them, and leaving hands them back', () => {
  const ui = game()
  ui.start()
  ui.hookImage.hovered = true; ui.tick()
  assert.deepEqual(ui.events.at(-1), ['CitadelShowAbilityDetailsTooltip', ui.hookImage, 123, 4])
  assert.equal(shown(ui.abilityName), 'Hook')
  assert.match(shown(ui.description), /55%/)
  assert.equal(shown(ui.range.FindChildTraverse('Current')!), '36m')
  assert.equal(shown(ui.cooldown.FindChildTraverse('BaseLabel')!), '4s')
  assert.match(shown(ui.tiers.GetChild(2)!.FindChildTraverse('upgradeDesc')!), /Rebound/)
  assert.equal(ui.hiddenTip.FindChildTraverse('Title')?.text, 'Hidden native tooltip')
  assert.equal(ui.abilityName.text, 'Localized native Hook')
  ui.abilityName.text = 'Localized Uppercut'
  ui.hookImage.hovered = false; ui.tick()
  assert.deepEqual(ui.events.at(-1), ['CitadelHideAbilityDetailsTooltip', ui.hookImage])
  assert.equal(shown(ui.abilityName), 'Localized Uppercut')
  assert.equal(ui.abilityTip.FindChildrenWithClassTraverse('AbilityName').filter(label => label.valid).length, 1)
  assert.equal(shown(ui.range.FindChildTraverse('Current')!), 'Native value')
  assert.equal(shown(ui.tiers.GetChild(0)!.FindChildTraverse('upgradeDesc')!), 'Native tier 0')
})

test('Hook key and upgrade pip hovers share the custom tiers and leave the native upgrade action alone', () => {
  const ui = game()
  ui.start()
  for (const target of [ui.binding, ui.pip]) {
    target.hovered = true; ui.tick()
    assert.deepEqual(ui.events.at(-1), ['CitadelShowAbilityDetailsTooltip', target, 123, 4])
    assert.match(shown(ui.tiers.GetChild(1)!.FindChildTraverse('upgradeDesc')!), /4s total/)
    target.hovered = false; ui.tick()
  }
  ui.pip.events.get('onactivate')?.()
  assert.equal(ui.upgrades(), 1)
  assert.deepEqual([...ui.pip.events.keys()], ['onactivate', 'onmouseover'])
})

test('a Hook tooltip the engine fills late, or a rank change, is rewritten while hovered', () => {
  const ui = game()
  ui.start()
  ui.hook.hovered = true; ui.tick()
  const tier = ui.tiers.GetChild(0)!.FindChildTraverse('upgradeDesc')!
  tier.text = 'Native +20% weapon damage'; ui.tick()
  assert.match(shown(tier), /36m total/)
  ui.hookLayout.data({ ...hookData, range: 30, cooldown: 5 }); ui.tick()
  assert.equal(shown(ui.range.FindChildTraverse('Current')!), '30m')
  assert.equal(shown(ui.cooldown.FindChildTraverse('BaseLabel')!), '5s')
})

test('Bebop shows only the Hook ability slot', () => {
  const ui = game()
  ui.start()
  for (const index of [1, 2, 4]) assert.equal(ui.root.FindChildTraverse(`slot_signature_${index}`)?.style.visibility, 'collapse')
  assert.equal(ui.hook.style.visibility, undefined)
})

test('owned items wear Bebop art and names in their native slots, and hovering one opens its native details with Bebop text', () => {
  const ui = game()
  ui.start(shopData('closed', true, [{ product: 'snowGlobe', slot: 6 }]))
  const slot = ui.inventory.FindChildTraverse('abilityButton2')!
  const image = slot.FindChildTraverse('ability_image')!
  const cover = slot.FindChildTraverse('BebopItemArt')!
  assert.match(cover.image, /snow-globe/)
  assert.equal(image.image, 'native-donor-glyph')
  assert.equal(image.style.opacity, '0')
  assert.deepEqual(image.GetParent()!.children.map(child => child.id), ['ability_image', 'BebopItemArt', 'cooldown_mask'])
  assert.equal(shown(slot.FindChildrenWithClassTraverse('ability_name')[0]!), 'Snow Globe')
  assert.equal(slot.style.tooltipPosition, 'top right left bottom')
  assert.equal(ui.inventory.FindChildTraverse('abilityButton0')?.FindChildTraverse('BebopItemArt'), null)
  slot.hovered = true; ui.tick()
  assert.deepEqual(ui.events.at(-1), ['CitadelShowModTooltip', slot, 100, 4])
  assert.equal(shown(ui.itemName), 'Snow Globe')
  assert.equal(shown(ui.itemCost), '300')
  assert.equal(ui.itemTip.FindChildTraverse('ModImage')?.style.backgroundImage, 'url("file://{images}/{addon}/overlay/items/snow-globe_png.vtex")')
  assert.equal(ui.sections.style.visibility, 'collapse')
  assert.equal(ui.itemTip.FindChildTraverse('BebopItemTimer')?.text, '16s')
  assert.equal(ui.itemTip.FindChildTraverse('BebopItemDescription')?.text, product.description)
  slot.hovered = false; ui.tick()
  assert.deepEqual(ui.events.at(-1), ['CitadelHideModTooltip', slot, 100, 4])
  assert.equal(shown(ui.itemName), 'Native Cold Front')
  assert.equal(ui.itemTip.FindChildTraverse('ModImage')?.style.backgroundImage, 'native-art')
  assert.equal(ui.sections.style.visibility, null)
  assert.equal(ui.itemTip.FindChildTraverse('BebopItemDetails'), null)
})

test('the purchased grid covers only Snow Globe art and leaves the engine-selected Echo art', () => {
  const ui = game()
  ui.start(shopData('closed', true, [{ product: 'snowGlobe', slot: 5 }, { product: 'echo', slot: 4 }]))
  assert.match(ui.snowIcon.FindChildTraverse('BebopItemArt')?.image ?? '', /snow-globe/)
  assert.equal(ui.snowIcon.FindChildTraverse('ModIconImage')?.style.opacity, '0')
  assert.equal(ui.echoIcon.FindChildTraverse('BebopItemArt'), null)
  assert.equal(ui.echoIcon.FindChildTraverse('ModIconImage')?.style.opacity, undefined)
  ui.echoIcon.hovered = true; ui.tick()
  assert.equal(shown(ui.itemName), 'Echo Shard')
  ui.echoIcon.hovered = false; ui.snowIcon.hovered = true; ui.tick()
  assert.equal(shown(ui.itemName), 'Snow Globe')
})

test('shop cards open native item details on hover and close them on leave', () => {
  const ui = game()
  ui.start()
  const cell = ui.shell.FindChildTraverse('BebopBuy_snowGlobe')!
  const card = cell.FindChildTraverse('BebopProduct_snowGlobe')!
  cell.events.get('onmouseover')?.()
  assert.deepEqual(ui.events.at(-1), ['CitadelShowModTooltip', card, 100, 4])
  assert.equal(shown(ui.itemName), 'Snow Globe')
  ui.tick()
  assert.equal(shown(ui.itemName), 'Snow Globe')
  cell.events.get('onmouseout')?.()
  assert.equal(shown(ui.itemName), 'Native Cold Front')
})

test('shop cards use stock card geometry and mark owned and equipped utilities', () => {
  const ui = game()
  ui.start()
  const card = ui.shell.FindChildTraverse('BebopProduct_snowGlobe')!
  assert.equal(card.style.width, undefined)
  assert.equal(card.hittest, false)
  assert.equal(card.hittestchildren, false)
  assert.equal(card.BHasClass('isTech'), true)
  assert.equal(card.BHasClass('ModTier1'), true)
  assert.equal(card.BHasClass('owned'), false)
  ui.shopLayout.data({ ...shopData(), shop: { allowed: true, reason: '', products: [{ ...product, state: 'equipped' }, echo] } })
  assert.equal(card.BHasClass('owned'), true)
})

test('the catalog boxes cards in headed sections, as plain rectangles, and leaves the price to the tooltip', () => {
  const ui = game()
  const sprint = { ...product, id: 'sprint', nativeId: 102, name: 'Sprint', group: 'utility', category: 'weapon', tier: 1, state: 'unaffordable', label: 'Need 120 more', action: null }
  const shard = { ...echo, group: 'utility', category: 'spirit', tier: 2, price: 600, state: 'equipped', label: 'Equipped' }
  const products = [{ ...product, group: 'setup', category: 'spirit', tier: 1 }, sprint, shard]
  ui.start({ ...shopData(), shop: { allowed: true, reason: '', products } })
  const setup = ui.shell.FindChildTraverse('BebopSection_setup'), utility = ui.shell.FindChildTraverse('BebopSection_utility')
  assert.ok(setup?.FindChildTraverse('BebopBuy_snowGlobe'))
  assert.ok(utility?.FindChildTraverse('BebopBuy_sprint') && utility.FindChildTraverse('BebopBuy_echo'))
  assert.equal(ui.shell.FindChildTraverse('BebopSectionName_utility')?.text, 'Utility')

  const card = ui.shell.FindChildTraverse('BebopProduct_sprint')!
  assert.equal(card.style.uiScale, '150%')
  assert.equal(card.style.transform, undefined)
  assert.equal(card.BHasClass('isActiveItem'), false)
  assert.equal(card.BHasClass('isWeapon'), true)
  assert.equal(card.BHasClass('canAffordMod'), false)
  assert.equal(ui.shell.FindChildTraverse('BebopProduct_echo')?.BHasClass('ModTier2'), true)

  assert.equal(ui.shell.FindChildTraverse('BebopStatus_sprint')?.text, '')
  assert.equal(ui.shell.FindChildTraverse('BebopStatus_echo')?.text, '')
  ui.shopLayout.data({ ...shopData(), shop: { allowed: true, reason: '', products: [products[0], { ...sprint, state: 'owned', label: 'Equip', action: { kind: 'equip', utility: 'sprint' } }, shard] } })
  assert.equal(ui.shell.FindChildTraverse('BebopStatus_sprint')?.text, 'EQUIP')
})

test('the item tooltip lists headline stats as boxes and rebuilds them for another item', () => {
  const ui = game()
  const snow = { ...product, stats: [{ value: '40%', label: 'Movement Slow' }, { value: '4m', label: 'Burst Radius' }] }
  const shard = { ...echo, state: 'unaffordable', label: 'Need 300 more', stats: [{ value: 'Reset', label: 'Hook Cooldown' }] }
  ui.start({ ...shopData(), shop: { allowed: true, reason: '', products: [snow, shard] } })
  ui.shell.FindChildTraverse('BebopBuy_snowGlobe')!.events.get('onmouseover')!()
  // A released tooltip body stays in the tree until the frame ends, as in Panorama; read the live one.
  const live = (panel: Panel, id: string): Panel | undefined => panel.valid ? panel.id === id ? panel : panel.children.map(child => live(child, id)).find(Boolean) : undefined
  const stats = () => live(ui.itemTip, 'BebopItemStats')!
  assert.deepEqual(stats().children.map(box => box.children.map(label => label.text)), [['40%', 'Movement Slow'], ['4m', 'Burst Radius']])
  ui.shell.FindChildTraverse('BebopBuy_snowGlobe')!.events.get('onmouseout')!()
  ui.shell.FindChildTraverse('BebopBuy_echo')!.events.get('onmouseover')!()
  assert.deepEqual(stats().children.map(box => box.children.map(label => label.text)), [['Reset', 'Hook Cooldown']])
  assert.notEqual(live(ui.itemTip, 'BebopItemState')!.style.color, '#9be3b7')
})
