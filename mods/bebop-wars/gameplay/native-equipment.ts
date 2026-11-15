import type { Ability, Player } from 'modlock'
import { catalog, groups, productIds, type ProductId } from './catalog.ts'
import { deadlineOf, type Progression } from './model.ts'

const hookName = 'citadel_ability_hook'
type OwnedAbility = Pick<Ability, 'name' | 'slot' | 'upgrades' | 'cooldownEnd' | 'imbues'>
type EquipmentPlayer = Pick<Player, 'clearItems' | 'giveItem' | 'setAbility'> & { abilities(): readonly OwnedAbility[] }
interface Cooldowns { readonly setupUntil: number; readonly utilityUntil: number; readonly defenseUntil: number; readonly now: number }
export interface NativeItem { readonly product: ProductId; readonly slot: number }

export function nativeItemButton(slot: number): bigint | undefined {
  return Number.isInteger(slot) && slot >= 4 && slot <= 7 ? 1n << BigInt(33 + slot) : undefined
}

export function equippedProducts(progression: Pick<Progression, 'owned' | 'setup' | 'utility' | 'defense'>): ProductId[] {
  const equipped: ProductId[] = []
  for (const group of groups) {
    const product = progression[group]
    if (product !== null && progression.owned.includes(product)) equipped.push(product)
  }
  return equipped
}

export function observeEquipment(abilities: readonly OwnedAbility[]): NativeItem[] {
  const items: NativeItem[] = []
  for (const ability of abilities) {
    const product = productIds.find(product => catalog[product].nativeItem === ability.name)
    if (product !== undefined && nativeItemButton(ability.slot) !== undefined) items.push({ product, slot: ability.slot })
  }
  return items
}

function matches(abilities: readonly OwnedAbility[], desired: readonly ProductId[]): boolean {
  const items = abilities.filter(ability => ability.name.startsWith('upgrade_'))
  return items.length === desired.length && new Set(items.map(item => item.slot)).size === items.length &&
    desired.every(product => items.some(item => item.name === catalog[product].nativeItem && nativeItemButton(item.slot) !== undefined))
}

function deadline(product: ProductId, cooldowns: Cooldowns): number {
  const until = deadlineOf(cooldowns, catalog[product].group)
  return until > cooldowns.now ? until : 0
}

function hookImbued(item: OwnedAbility): boolean { return item.imbues.length === 1 && item.imbues[0] === hookName }

export function reconcileEquipment(player: EquipmentPlayer, desired: readonly ProductId[], cooldowns: Cooldowns, abilities: readonly OwnedAbility[] = player.abilities()): boolean {
  const hook = abilities.find(ability => ability.name === hookName)
  if (desired.includes('echo') && (!hook || hook.slot < 0 || hook.slot > 3)) return false
  if (!matches(abilities, desired)) {
    if (!player.clearItems()) return false
    for (const product of desired) {
      if (!player.giveItem(catalog[product].nativeItem, product === 'echo' ? hook?.slot : undefined)) return false
    }
    abilities = player.abilities()
    if (!matches(abilities, desired)) return false
  }
  let changed = false
  for (const product of desired) {
    const item = abilities.find(ability => ability.name === catalog[product].nativeItem)
    if (!item) return false
    if (product === 'echo' && !hookImbued(item)) {
      if (!player.giveItem(item.name, hook?.slot)) return false
      changed = true
    }
    const cooldownEnd = deadline(product, cooldowns)
    if (item.upgrades !== 1 || Math.abs(item.cooldownEnd - cooldownEnd) > 0.05) {
      if (!player.setAbility({ ability: item.name, upgrades: 1, cooldownEnd })) return false
      changed = true
    }
  }
  const after = changed ? player.abilities() : abilities
  return matches(after, desired) && desired.every(product => {
    const item = after.find(ability => ability.name === catalog[product].nativeItem)
    return item !== undefined && item.upgrades === 1 && Math.abs(item.cooldownEnd - deadline(product, cooldowns)) <= 0.05 && (product !== 'echo' || hookImbued(item))
  })
}
