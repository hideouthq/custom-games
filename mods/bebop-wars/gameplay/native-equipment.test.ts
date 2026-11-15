import assert from 'node:assert/strict'
import test from 'node:test'
import { catalog } from './catalog.ts'
import { equippedProducts, nativeItemButton, observeEquipment, reconcileEquipment } from './native-equipment.ts'

type Player = Parameters<typeof reconcileEquipment>[0]
type Ability = ReturnType<Player['abilities']>[number]

function fixture() {
  let abilities: Ability[] = [{ name: 'citadel_ability_hook', slot: 2, upgrades: 1, cooldownEnd: 0, imbues: [] }]
  let clearCount = 0
  let reads = 0
  let failGrant: string | undefined
  let failWrites = false
  let ignoreImbue = false
  const writes: string[] = []
  const grants: { item: string; imbue: number | undefined }[] = []
  const player: Player = {
    abilities: () => { reads++; return abilities },
    clearItems: () => { clearCount++; abilities = abilities.filter(ability => !ability.name.startsWith('upgrade_')); return true },
    giveItem: (item, imbue) => {
      grants.push({ item, imbue })
      if (item === failGrant) return false
      const target = abilities.find(ability => ability.slot === imbue)
      const imbues = target && !ignoreImbue ? [target.name] : []
      if (abilities.some(ability => ability.name === item)) {
        abilities = abilities.map(ability => ability.name === item ? { ...ability, imbues } : ability)
      } else {
        const slot = [4, 5, 6, 7].find(slot => !abilities.some(ability => ability.slot === slot))
        if (slot === undefined) return false
        abilities = [...abilities, { name: item, slot, upgrades: 1, cooldownEnd: 0, imbues }]
      }
      return true
    },
    setAbility: options => {
      writes.push(options.ability)
      if (failWrites) return false
      abilities = abilities.map(ability => ability.name === options.ability ? { ...ability, upgrades: options.upgrades ?? ability.upgrades, cooldownEnd: options.cooldownEnd ?? ability.cooldownEnd } : ability)
      return true
    },
  }
  return { player, writes, grants,
    get abilities() { return abilities }, set abilities(value: Ability[]) { abilities = value },
    get clears() { return clearCount }, get reads() { return reads },
    set failGrant(value: string | undefined) { failGrant = value },
    set failWrites(value: boolean) { failWrites = value },
    set ignoreImbue(value: boolean) { ignoreImbue = value },
  }
}

const cooldowns = { now: 10, setupUntil: 20, utilityUntil: 25 }

test('equipped donors are the owned item chosen in each section, in section order', () => {
  assert.deepEqual(equippedProducts({ owned: ['snowGlobe', 'sprint', 'echo'], setup: 'snowGlobe', utility: 'echo', defense: null }), ['snowGlobe', 'echo'])
  assert.deepEqual(equippedProducts({ owned: ['snowGlobe'], setup: 'snowGlobe', utility: 'sprint', defense: null }), ['snowGlobe'])
  assert.deepEqual(equippedProducts({ owned: ['sprint', 'snowGlobe'], setup: null, utility: null, defense: null }), [])
  assert.deepEqual(equippedProducts({ owned: ['etherealShift', 'knockdown', 'piano', 'shrinkRay'], setup: 'piano', utility: 'shrinkRay', defense: 'etherealShift' }), ['piano', 'shrinkRay', 'etherealShift'])
})

test('native active slots map to current user item buttons, not hero buttons or item five', () => {
  assert.deepEqual([4, 5, 6, 7].map(nativeItemButton), [137438953472n, 274877906944n, 549755813888n, 1099511627776n])
  for (const slot of [-1, 0, 3, 8, 23, 4.5, NaN]) assert.equal(nativeItemButton(slot), undefined)
})

test('install grants actual native donors and Hook imbue with existing authoritative deadlines', () => {
  const f = fixture()
  f.abilities = f.abilities.map(ability => ({ ...ability, slot: 1 }))
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'echo'], cooldowns), true)
  assert.deepEqual(f.grants, [{ item: catalog.snowGlobe.nativeItem, imbue: undefined }, { item: catalog.echo.nativeItem, imbue: 1 }])
  assert.deepEqual(observeEquipment(f.abilities), [{ product: 'snowGlobe', slot: 4 }, { product: 'echo', slot: 5 }])
  assert.equal(f.abilities.find(ability => ability.name === catalog.snowGlobe.nativeItem)?.cooldownEnd, 20)
  assert.equal(f.abilities.find(ability => ability.name === catalog.echo.nativeItem)?.cooldownEnd, 25)
})

test('matching inventory preserves user slot rearrangement without native writes or extra reads', () => {
  const f = fixture()
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns), true)
  f.abilities = f.abilities.map(ability => ability.name === catalog.snowGlobe.nativeItem ? { ...ability, slot: 7 } : ability)
  const clears = f.clears, writes = f.writes.length, reads = f.reads
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns, f.abilities), true)
  assert.equal(f.clears, clears)
  assert.equal(f.writes.length, writes)
  assert.equal(f.reads, reads)
  assert.deepEqual(observeEquipment(f.abilities), [{ product: 'snowGlobe', slot: 7 }, { product: 'sprint', slot: 5 }])
})

test('switching utilities preserves shared cooldown and keeps only equipped donors', () => {
  const f = fixture()
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns), true)
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'echo'], cooldowns), true)
  assert.equal(f.abilities.some(ability => ability.name === catalog.sprint.nativeItem), false)
  assert.equal(f.abilities.find(ability => ability.name === catalog.echo.nativeItem)?.cooldownEnd, 25)
  assert.equal(f.abilities.find(ability => ability.name === catalog.snowGlobe.nativeItem)?.cooldownEnd, 20)
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns), true)
  assert.equal(f.abilities.find(ability => ability.name === catalog.sprint.nativeItem)?.cooldownEnd, 25)
})

test('partial grant failure is reported and retry restores the complete requested inventory', () => {
  const f = fixture()
  f.failGrant = catalog.sprint.nativeItem
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns), false)
  assert.deepEqual(observeEquipment(f.abilities), [{ product: 'snowGlobe', slot: 4 }])
  f.failGrant = undefined
  assert.equal(reconcileEquipment(f.player, ['snowGlobe', 'sprint'], cooldowns), true)
  assert.equal(observeEquipment(f.abilities).length, 2)
  assert.equal(f.abilities.find(ability => ability.name === catalog.sprint.nativeItem)?.cooldownEnd, 25)
})

test('restore repairs missing donors, rejects unverifiable imbue, and avoids clearing when Hook is absent', () => {
  const f = fixture()
  assert.equal(reconcileEquipment(f.player, ['echo'], cooldowns), true)
  f.abilities = f.abilities.filter(ability => ability.name === 'citadel_ability_hook')
  f.ignoreImbue = true
  assert.equal(reconcileEquipment(f.player, ['echo'], cooldowns), false)
  const clears = f.clears
  f.ignoreImbue = false
  assert.equal(reconcileEquipment(f.player, ['echo'], cooldowns), true)
  assert.equal(f.clears, clears)
  f.abilities = f.abilities.filter(ability => ability.name !== 'citadel_ability_hook')
  assert.equal(reconcileEquipment(f.player, ['echo'], cooldowns), false)
  assert.equal(f.clears, clears)
})

test('cooldown write failure leaves inventory retryable and expired cooldowns become ready', () => {
  const f = fixture()
  f.failWrites = true
  assert.equal(reconcileEquipment(f.player, ['snowGlobe'], cooldowns), false)
  const clears = f.clears
  f.failWrites = false
  assert.equal(reconcileEquipment(f.player, ['snowGlobe'], cooldowns), true)
  assert.equal(f.clears, clears)
  assert.equal(reconcileEquipment(f.player, ['snowGlobe'], { ...cooldowns, now: 30 }), true)
  assert.equal(f.abilities.find(ability => ability.name === catalog.snowGlobe.nativeItem)?.cooldownEnd, 0)
})

test('unexpected native items are removed without changing the native Hook', () => {
  const f = fixture()
  const hook = f.abilities[0]
  f.player.giveItem('upgrade_ability_refresher')
  assert.equal(reconcileEquipment(f.player, [], cooldowns), true)
  assert.deepEqual(f.abilities, [hook])
})
