import { hide, hideHud, itemId, sheet, show, theme, type Player, type Style } from 'modlock'
import { catalog } from './catalog.ts'
import type { HudAction, HudView, RosterView, Side } from './hud-model.ts'

const { tones, plate, pillEdge } = theme
const colour = {
  panel: plate.color, line: pillEdge,
  text: tones.text, secondary: tones.muted, muted: '#8c8375',
  owned: tones.success, warning: tones.gold, error: tones.danger,
  sapphire: tones.sapphire, amber: tones.amber,
}
const body: Style = { face: 'body', fontSize: 13.5, color: colour.text, noWrap: true }
const block: Style = { ...body, face: 'block', uppercase: true }
const panel: Style = { background: colour.panel, borderRadius: plate.radius, borderWidth: 1, borderColor: colour.line }
type Send = (action: HudAction) => void
let configured = new WeakMap<Player, number>()
let overtimeStarted = new WeakMap<Player, number>()
export function resetHud(): void { configured = new WeakMap(); overtimeStarted = new WeakMap() }

export function drawHud(player: Player, view: HudView, send: Send): void {
  if (configured.get(player) !== view.native.generation) {
    hide(player)
    sheet('overlay.css')
    hideHud(player, ['topBar', 'ammo', 'minimap', 'stats'])
    configured.set(player, view.native.generation)
  }
  if (view.phase !== 'overtime') overtimeStarted.delete(player)
  else if (!overtimeStarted.has(player)) overtimeStarted.set(player, view.now)
  const overtimeNotice = view.phase === 'overtime' && view.now - (overtimeStarted.get(player) ?? view.now) < 5
  show(player, <HudSurface view={view} send={send} overtimeNotice={overtimeNotice} />)
}

export function HudSurface({ view, send, overtimeNotice = false }: { view: HudView; send: Send; overtimeNotice?: boolean }) {
  const shopping = view.menu === 'loadout' && view.phase !== 'overtime'
  return <panel key="winter-overlay" style={{ width: '100%', height: '100%' }}>
    <layout key="shop-bridge" src="loadout_bridge.xml" data={{ menu: shopping ? 'loadout' : 'closed', canShop: view.canShop, native: view.native, shop: { ...view.shop, products: view.shop.products.map(product => ({ ...product, nativeId: itemId(catalog[product.id].nativeItem) })) } }} style={{ width: 0, height: 0 }} />
    <layout key="native-hook" src="native_hook.xml" data={{ ...view.native, hookId: itemId('citadel_ability_hook') }} style={{ width: 0, height: 0 }} />
    {!shopping ? <Scoreboard key="scoreboard" view={view} /> : null}
    {!shopping ? <panel key="feed" style={{ horizontalAlign: 'right', margin: [180, 24, 0, 0], flow: 'down' }}>{view.feed.slice(-4).map(entry => <label key={String(entry.id)} style={{ ...body, color: entry.side === 3 ? colour.sapphire : entry.side === 2 ? colour.amber : colour.text, margin: [0, 0, 6, 0] }}>{entry.text}</label>)}</panel> : null}
    <Notice key="notice" view={view} shopping={shopping} overtimeNotice={overtimeNotice} />
    {view.phase === 'warmup' && !shopping ? <Warmup key="warmup" view={view} send={send} /> : null}
    {view.phase === 'countdown' || view.waitingForNextMatch ? <panel key="phase" style={{ ...panel, horizontalAlign: 'center', margin: [160, 0, 0, 0], padding: [12, 20], flow: 'down' }}>
      <label style={{ ...block, fontSize: 20, horizontalAlign: 'center' }}>{view.waitingForNextMatch ? 'Waiting for a seat' : view.heading}</label>
      <label style={{ ...body, color: colour.secondary, horizontalAlign: 'center', margin: [6, 0, 0, 0] }}>{view.waitingForNextMatch ? 'You can join the next match.' : view.detail}</label>
    </panel> : null}
    {view.phase === 'results' ? <Results key="results" view={view} /> : null}
    {view.debug.length ? <panel key="debug" style={{ ...panel, horizontalAlign: 'right', margin: [16, 16, 0, 0], padding: 12, flow: 'down' }}>
      <label style={{ ...block, fontSize: 12 }}>BEBOP WARS · DEVELOPER VIEW</label>
      {view.debug.map((line, i) => <label key={String(i)} style={{ ...body, fontSize: 12, color: colour.muted }}>{line}</label>)}
    </panel> : null}
  </panel>
}

function Icon({ name, size = 20, style = {} }: { name: string; size?: number; style?: Style }) {
  return <panel class={`OverlayImage icon-${name}`} style={{ width: size, height: size, ...style }} />
}
const half = 178
function Scoreboard({ view }: { view: HudView }) {
  const overtime = view.phase === 'overtime'
  return <panel style={{ horizontalAlign: 'center', margin: [14, 0, 0, 0], flow: 'down' }}>
    <label style={{ ...block, fontSize: 14, letterSpacing: 2, shadow: true, horizontalAlign: 'center', color: overtime ? colour.warning : colour.secondary }}>{overtime ? 'Overtime · Next kill wins' : `First to ${view.target}`}</label>
    <panel style={{ flow: 'right', horizontalAlign: 'center', height: 48, margin: [5, 0, 0, 0], padding: [0, 24], background: plate.color, borderRadius: 24, borderWidth: 1, borderColor: pillEdge }}>
      <Points side={3} view={view} />
      <Divider />
      <label style={{ ...block, width: 96, fontSize: 26, textAlign: 'center', verticalAlign: 'center', color: overtime || view.lastThirty ? colour.warning : colour.text }}>{view.clock}</label>
      <Divider />
      <Points side={2} view={view} />
    </panel>
    <panel style={{ flow: 'right', horizontalAlign: 'center', margin: [7, 0, 0, 0] }}>
      <Names side={3} view={view} />
      <panel style={{ width: 96 + 2 * 33 }} />
      <Names side={2} view={view} />
    </panel>
  </panel>
}
function Divider() {
  return <panel style={{ width: 1, height: 24, margin: [0, 16], verticalAlign: 'center', background: '#ffefd770', opacity: 0.5 }} />
}
function Points({ side, view }: { side: Side; view: HudView }) {
  const right = side === 2, accent = right ? colour.amber : colour.sapphire
  const name = <label style={{ ...block, width: half - 52, fontSize: 15, letterSpacing: 1, verticalAlign: 'center', textAlign: right ? 'right' : 'left', color: accent }}>{right ? 'Amber' : 'Sapphire'}</label>
  const points = <label style={{ ...block, width: 52, fontSize: 30, verticalAlign: 'center', textAlign: right ? 'left' : 'right' }}>{view.score[side]}</label>
  return <panel style={{ flow: 'right', width: half, height: '100%' }}>{right ? [points, name] : [name, points]}</panel>
}
function Names({ side, view }: { side: Side; view: HudView }) {
  const right = side === 2
  return <panel style={{ flow: 'down', width: half }}>
    {view.roster.filter(member => member.side === side).map(member => <Name key={member.id} member={member} right={right} />)}
  </panel>
}
function Name({ member, right }: { member: RosterView; right: boolean }) {
  const down = member.respawn !== null
  const name = <label key="name" tooltip={member.name} style={{ ...body, maxWidth: half - 40, fontSize: 15, shadow: true, textOverflow: 'ellipsis', color: down ? colour.muted : member.self ? tones.accent : colour.text }}>{member.name}</label>
  const respawn = down ? <label key="respawn" style={{ ...block, fontSize: 13, shadow: true, verticalAlign: 'center', margin: [0, 7], color: colour.error }}>{member.respawn}s</label> : null
  return <panel style={{ flow: 'right', height: 21, horizontalAlign: right ? 'right' : 'left' }}>{right ? [respawn, name] : [name, respawn]}</panel>
}

function Notice({ view, shopping, overtimeNotice }: { view: HudView; shopping: boolean; overtimeNotice: boolean }) {
  const text = view.purchaseNotice || view.notice || (overtimeNotice ? 'Overtime. Next kill advantage wins. Shop closed.' : view.lastThirty ? 'Overtime at 0:00. Purchases close.' : '')
  if (!text) return null
  const warning = text.startsWith('Overtime at 0:00.') ? 'Overtime at 0:00.' : text.startsWith('Overtime.') ? 'Overtime.' : ''
  const icon = view.purchaseNotice ? 'check-white' : overtimeNotice ? 'lock-white' : view.lastThirty ? 'clock-white' : 'info-white'
  return <panel style={{ ...panel, horizontalAlign: 'center', verticalAlign: 'bottom', margin: [0, 0, shopping ? 80 : 220, 0], height: 36, padding: [8, 16, 8, 12], borderRadius: 18, flow: 'right' }}>
    <Icon name={icon} size={18} style={{ margin: [0, 9, 0, 0], tint: view.purchaseNotice ? colour.owned : overtimeNotice || view.lastThirty ? colour.warning : colour.secondary }} />
    {warning ? <label style={{ ...body, fontSize: 14.5, bold: true, color: colour.warning, margin: [0, 4, 0, 0] }}>{warning}</label> : null}
    <label style={{ ...body, fontSize: 14.5, bold: true }}>{warning ? text.slice(warning.length).trimStart() : text}</label>
  </panel>
}
function TextButton({ text, action, send, height = 30, disabled = false }: { text: string; action: HudAction; send: Send; height?: number; disabled?: boolean }) {
  return <button class="OverlayButton" disabled={disabled} onPress={() => send(action)} style={{ height, padding: [0, 10], background: '#ffefd71f', borderRadius: 4, borderWidth: 0 }} hover={{ background: '#ffefd73d' }}>
    <label style={{ ...body, fontSize: 13.5, verticalAlign: 'center', color: disabled ? colour.muted : colour.text }}>{text}</label>
  </button>
}
function Warmup({ view, send }: { view: HudView; send: Send }) {
  return <panel style={{ ...panel, horizontalAlign: 'center', verticalAlign: 'bottom', margin: [0, 0, 330, 0], padding: [12, 16], flow: 'down' }}>
    <label style={{ ...block, fontSize: 16 }}>WINTER WARMUP</label>
    <panel style={{ flow: 'right', height: 30, margin: [8, 0, 0, 0] }}>
      <label style={{ ...body, color: colour.secondary, verticalAlign: 'center', margin: [0, 16, 0, 0] }}>{view.detail}</label>
      <TextButton text={view.ready ? 'Ready' : 'Ready up'} action={{ kind: 'ready' }} send={send} disabled={!view.canReady} />
    </panel>
  </panel>
}
function Results({ view }: { view: HudView }) {
  return <panel style={{ ...panel, horizontalAlign: 'center', verticalAlign: 'center', width: 560, padding: 20, flow: 'down' }}>
    <label style={{ ...block, fontSize: 24, horizontalAlign: 'center' }}>{view.heading}</label>
    <label style={{ ...body, color: colour.secondary, horizontalAlign: 'center', margin: [6, 0, 18, 0] }}>{view.detail}</label>
    <panel style={{ flow: 'right', width: '100%', height: 24 }}><label style={{ ...block, fontSize: 11.5, width: 'fill', color: colour.muted }}>PLAYERS</label><label style={{ ...block, fontSize: 11.5, width: 88, color: colour.muted, textAlign: 'right' }}>KILLS</label><label style={{ ...block, fontSize: 11.5, width: 68, color: colour.muted, textAlign: 'right' }}>SAVES</label></panel>
    {view.roster.map(member => <panel key={member.id} style={{ flow: 'right', width: '100%', height: 30 }}>
      <label style={{ ...body, width: 'fill', textOverflow: 'ellipsis', color: member.side === 3 ? colour.sapphire : colour.amber }}>{member.name}</label>
      <label style={{ ...body, width: 88, textAlign: 'right' }}>{member.kills}</label><label style={{ ...body, width: 68, textAlign: 'right' }}>{member.saves}</label>
    </panel>)}
  </panel>
}
