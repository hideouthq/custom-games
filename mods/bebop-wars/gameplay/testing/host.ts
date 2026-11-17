// An in-memory stand-in for the modlock host and the HUD, so a test can play Game frame by frame.
// native.test.ts points the 'modlock' and './hud.tsx' imports here.
import { globeRules } from '../globe.ts'

export { Buttons, Layers } from '../../.tools/modlock/js/src/bits.ts'

interface Vec3 { x: number; y: number; z: number }
interface Angles { pitch: number; yaw: number; roll: number }
interface FakeAbility { name: string; slot: number; entity: number; upgrades: number; charges: number; cooldownStart: number; cooldownEnd: number; rechargeEnd: number; imbues: string[] }
interface Particle { readonly resource: string; position: Vec3; removed: boolean; remove(): void; move(position: Vec3): void; entity(): number }
interface Connection { readonly player: FakePlayer; readonly steamId: bigint; readonly name: string; readonly bot: boolean; readonly ready: boolean; readonly generation: number }

const bebopHero = 6
// Bebop Wars checks these hook and slow profile values after the world loads.
const definitions = new Map<string, number>([
  ['CCitadel_Modifier_HookTargetVData.m_flReturnPositionForwardOffset', 0],
  ['CCitadel_Modifier_HookTargetVData.m_flCloseEnoughDistance', 16],
  ['CCitadel_Modifier_HookTargetVData.m_flReturnSpeed', 2000 * 2 / 3],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flRampUpTime', 0],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flPercentageMultiplierStart', globeRules.slow * 100],
  ['CCitadel_Modifier_RampSlowModifierVData.m_flPercentageMultiplierEnd', globeRules.slow * 100],
])
const ground = 104
let nextEntity = 1000

class FakePlayer {
  readonly slot: number
  readonly name: string
  readonly presses: bigint[] = []
  readonly cancelled: bigint[] = []
  readonly writes: { ability: string; cooldownEnd: number | undefined }[] = []
  body: { entity: number; hero: number; team: number; health: number; maxHealth: number; souls: number; abilityPoints: number; abilityUnlocks: number; position: Vec3; velocity: Vec3; cameraAngles: Angles; eyeAngles: Angles } | undefined
  items: FakeAbility[]

  constructor(slot: number, name: string, team: number) {
    this.slot = slot
    this.name = name
    this.body = { entity: nextEntity++, hero: bebopHero, team, health: 1000, maxHealth: 1000, souls: 0, abilityPoints: 0, abilityUnlocks: 0,
      position: { x: 0, y: team === 3 ? 984 : -984, z: ground }, velocity: { x: 0, y: 0, z: 0 },
      cameraAngles: { pitch: 0, yaw: team === 3 ? -90 : 90, roll: 0 }, eyeAngles: { pitch: 0, yaw: 0, roll: 0 } }
    this.items = [{ name: 'citadel_ability_hook', slot: 2, entity: nextEntity++, upgrades: 1, charges: 0, cooldownStart: 0, cooldownEnd: 0, rechargeEnd: 0, imbues: [] }]
  }

  item(name: string): FakeAbility {
    const found = this.items.find(ability => ability.name === name)
    if (!found) throw new Error(`${this.name} holds no ${name}`)
    return found
  }

  connection(): Connection | undefined { return host.connections.find(each => each.player === this) }
  pawn() {
    const body = this.body
    return body && { ...body, eyePosition: { ...body.position, z: body.position.z + 64 } }
  }
  abilities(): readonly FakeAbility[] { return this.items.map(ability => ({ ...ability })) }
  press(button: bigint): boolean { this.presses.push(button); return true }
  cancelPress(buttons: bigint): boolean { this.cancelled.push(buttons); return true }
  refreshAbility(): boolean { return true }
  setAbility(options: { ability: string; upgrades?: number; charges?: number; cooldownEnd?: number; rechargeEnd?: number }): boolean {
    this.writes.push({ ability: options.ability, cooldownEnd: options.cooldownEnd })
    const ability = this.items.find(each => each.name === options.ability)
    if (!ability) return false
    ability.upgrades = options.upgrades ?? ability.upgrades
    ability.charges = options.charges ?? ability.charges
    ability.cooldownEnd = options.cooldownEnd ?? ability.cooldownEnd
    ability.rechargeEnd = options.rechargeEnd ?? ability.rechargeEnd
    return true
  }
  resetHero(): boolean { if (this.body) this.body.souls = 0; return true }
  adjustSouls(delta: number): boolean {
    if (!this.body) return false
    this.body.souls += delta
    return true
  }
  adjustAbilityPoints(points: number, unlocks: number): boolean {
    if (!this.body) return false
    this.body.abilityPoints += points
    this.body.abilityUnlocks += unlocks
    return true
  }
  clearItems(): boolean { this.items = this.items.filter(ability => !ability.name.startsWith('upgrade_')); return true }
  giveItem(name: string, imbue?: number): boolean {
    const imbues = this.items.filter(ability => ability.slot === imbue).map(ability => ability.name)
    const slot = [4, 5, 6, 7].find(slot => !this.items.some(ability => ability.slot === slot))
    if (slot === undefined) return false
    this.items.push({ name, slot, entity: nextEntity++, upgrades: 1, charges: 0, cooldownStart: 0, cooldownEnd: 0, rechargeEnd: 0, imbues })
    return true
  }
  giveModifier(): boolean { return true }
  teleport(position: Vec3): boolean { if (this.body) this.body.position = position; return true }
  move(position: Vec3): boolean { if (this.body) this.body.position = position; return true }
  changeTeam(team: number): boolean { if (this.body) this.body.team = team; return true }
  selectHero(_hero: string, team: number): boolean { if (this.body) { this.body.hero = bebopHero; this.body.team = team }; return true }
  respawn(): boolean { if (this.body) this.body.health = this.body.maxHealth; return true }
  blockInput(): boolean { return true }
  centerText(): boolean { return true }
  restoreStamina(): boolean { return true }
  setVelocity(): boolean { return true }
  spectate(): boolean { return true }
  sound(): boolean { return true }
  addMetric(): boolean { return true }
}

export const host = {
  connections: [] as Connection[],
  particles: [] as Particle[],
  reloadHeld: false,
  handedOff: undefined as string | undefined,
  reset(): void {
    this.connections = []
    this.particles = []
    this.reloadHeld = false
    this.handedOff = undefined
  },
  join(name: string, team: number): FakePlayer {
    const player = new FakePlayer(this.connections.length, name, team)
    this.connections.push({ player, steamId: 76561198000000000n + BigInt(player.slot), name, bot: false, ready: true, generation: 1 })
    return player
  },
}

export const Player = { of: (_slot: number) => ({ cancelPress: () => true }) }
export function players(): readonly Connection[] { return host.connections }
export function connection(slot: number): Connection | undefined { return host.connections.find(each => each.player.slot === slot) }
export function heroNamed(_name: string) { return { id: bebopHero } }
export function readDefinitionField(entry: { field: string }): number | undefined { return definitions.get(entry.field) }
export function holdReload(held: boolean): boolean { host.reloadHeld = held; return true }
export function handedOff(): string | undefined { return host.handedOff }
export function handoff(text: string): boolean { host.handedOff = text; return true }
export function createParticle(options: { resource: string; position: Vec3 }): Particle {
  const particle: Particle = {
    resource: options.resource, position: options.position, removed: false,
    remove() { particle.removed = true }, move(position) { particle.position = position }, entity: () => nextEntity++,
  }
  host.particles.push(particle)
  return particle
}
// Flat ground under the whole arena, at the height the spawns stand on.
export function trace({ start, end }: { start: Vec3; end: Vec3 }) {
  if (start.z < ground) return { position: start, startSolid: true }
  if (end.z > ground) return undefined
  const along = (start.z - ground) / (start.z - end.z)
  return { position: { x: start.x + (end.x - start.x) * along, y: start.y + (end.y - start.y) * along, z: ground }, startSolid: false }
}
export function modifierState(): boolean { return false }
export function findEntities(): number[] { return [] }
export function readField(): undefined { return undefined }
export function readModifierField(): undefined { return undefined }
export function holdModifierState(): boolean { return true }
export function damage(): boolean { return true }
export function serverCommand(): boolean { return true }
export function blockInput(): void {}
export function watchInput(): void {}
export function clearMap(): void {}
export function emitSound(): void {}
export function fireInput(): void {}
export function freeCursor(): void {}
export function precache(): void {}
export function setFreeForAll(): void {}
export function setTeamSeating(): void {}
export function log(): void {}

export function drawHud(): void {}
export function resetHud(): void {}
