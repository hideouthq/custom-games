import { catalog, hookProfile, productIds, type ProductId } from './catalog.ts'
import type { HudView, ProductView, Side } from './hud-model.ts'
import { canShop, playing, purchaseAccess, type Fighter, type Frame, type State } from './model.ts'

function clock(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
}

function productView(id: ProductId, state: State, fighter: Fighter, access: ReturnType<typeof purchaseAccess>, souls: number): ProductView {
  const item = catalog[id], progress = fighter.progression
  const owned = progress.owned.includes(id)
  const current = progress[item.group]
  const equipped = owned && current === id
  const dead = fighter.life.kind === 'dead'
  const base = { id, name: item.name, price: item.price, cooldown: item.cooldown, description: item.description, group: item.group, category: item.category, tier: item.tier, stats: item.stats, shortfall: owned ? 0 : Math.max(0, item.price - souls) }
  if (progress.purchase?.product === id) return { ...base, state: 'pending', label: 'Buying…', detail: 'Waiting for purchase confirmation.', action: null }
  if (equipped) return { ...base, state: 'equipped', label: dead ? 'Equipped next spawn' : 'Equipped', detail: 'Owned for this match.', action: null }
  if (owned) return {
    ...base, state: 'owned', label: access.allowed ? 'Equip' : 'Owned',
    detail: access.allowed ? `Equip in place of ${current ? catalog[current].name : 'nothing'}. Both stay owned.` : access.reason,
    action: access.allowed ? { kind: 'equip', utility: id } : null,
  }
  if (item.teamOnly && state.config.teamSize === 1) return { ...base, state: 'locked', label: 'Team modes only', detail: 'Needs a teammate to use.', action: null }
  if (souls < item.price) return { ...base, state: 'unaffordable', label: `Need ${item.price - souls} more`, detail: 'Earn Souls from kills.', action: null }
  if (!access.allowed) return { ...base, state: 'locked', label: 'Shop only', detail: access.reason, action: null }
  return { ...base, state: 'buy', label: 'Buy & equip', detail: current ? `Replaces ${catalog[current].name}. Both stay owned.` : 'Yours for this match. Death keeps your items.', action: { kind: 'buy', product: id } }
}

export function present(state: State, fighter: Fighter, frame: Frame): HudView {
  const phase = state.phase, progress = fighter.progression
  const sample = frame.players.find(p => p.id === fighter.id)
  const body = sample?.body
  const hook = body?.hook
  const souls = body?.souls ?? 0
  const caught = fighter.life.kind === 'alive' && fighter.life.transit.kind !== 'none'
  const protectedNow = fighter.life.kind === 'alive' && fighter.life.protectionUntil > state.now
  const utility = progress.utility
  const profile = hookProfile(body?.hookRank ?? 0)
  let heading = '', detail = '', timer = clock(state.config.matchSeconds)
  if (phase.kind === 'warmup') {
    heading = 'Winter warmup'
    const ready = Array.from(state.fighters.values()).filter(p => p.ready && p.presence.kind === 'connected' && p.membership.kind === 'seated').length
    detail = ready === state.config.teamSize * 2 ? 'All ready · Waiting for hooks to return' : `${ready}/${state.config.teamSize * 2} ready · Buy one tool or save your 300 Souls`
  } else if (phase.kind === 'countdown') {
    heading = `Starting in ${Math.max(0, Math.ceil(phase.until - state.now))}`
    detail = 'Hook, fight and rescue. Enemy kills score points.'
    timer = clock(phase.until - state.now)
  } else if (phase.kind === 'live') {
    timer = clock(phase.until - state.now)
    if (phase.until - state.now <= 30) detail = 'Purchases close if the match reaches overtime.'
  } else if (phase.kind === 'overtime') { heading = 'Overtime'; detail = 'Next kill advantage wins · Purchases locked'; timer = 'OT' }
  else {
    heading = phase.winner === 3 ? 'Sapphire wins' : phase.winner === 2 ? 'Amber wins' : 'Match ended'
    detail = `${phase.reason} · Warmup in ${Math.max(0, Math.ceil(phase.until - state.now))}`
    timer = clock(phase.until - state.now)
  }
  const respawn = fighter.life.kind === 'dead' ? Math.max(0, Math.ceil(fighter.life.respawnAt - state.now)) : null
  if (respawn !== null && playing(state)) { heading = `Respawning in ${respawn}`; detail = 'Shop now or keep watching. Respawn continues.' }
  const roster = Array.from(state.fighters.values()).flatMap(p => {
    if (p.membership.kind !== 'seated') return []
    const status = p.presence.kind === 'away' ? 'Disconnected' : p.life.kind === 'dead' ? `${Math.max(0, Math.ceil(p.life.respawnAt - state.now))}s` : p.life.kind === 'waiting' ? 'Deploying' : p.life.transit.kind !== 'none' ? 'Caught' : phase.kind === 'warmup' ? p.ready ? 'Ready' : 'Not ready' : 'Alive'
    return [{ id: p.id, name: p.name, side: p.membership.side, status, kills: p.kills, saves: p.saves, self: p.id === fighter.id, respawn: p.life.kind === 'dead' ? Math.max(0, Math.ceil(p.life.respawnAt - state.now)) : null }]
  })
  const side: Side | undefined = fighter.membership.kind === 'seated' ? fighter.membership.side : undefined
  const access = purchaseAccess(state, fighter, frame)
  const products = productIds.map(id => productView(id, state, fighter, access, souls))
  const debug = state.config.debug ? [
    `round ${state.round} · life ${fighter.serial} · ${fighter.life.kind}`,
    `hook ${hook?.casting ? 'casting' : 'idle'} · held ${hook?.victim ?? 'none'}`,
    `transit ${fighter.life.kind === 'alive' ? fighter.life.transit.kind : 'none'}`,
  ] : []
  const feedback = progress.feedback.until > state.now ? progress.feedback.text : ''
  const purchased = productIds.find(id => (feedback === `${catalog[id].name} purchased` || feedback === `${catalog[id].name} selected`) && progress[catalog[id].group] === id)
  const purchaseNotice = purchased ? `${catalog[purchased].name} equipped` : ''
  return {
    now: state.now, lastThirty: phase.kind === 'live' && phase.until - state.now <= 30,
    purchaseNotice,
    phase: phase.kind, teamSize: state.config.teamSize, side, score: state.score, target: state.config.target,
    clock: timer, heading, detail, roster,
    feed: state.feed.map(item => ({ id: item.id, text: item.text, side: item.side })),
    notice: respawn !== null ? `Respawning in ${respawn}` : fighter.notice.until > state.now ? fighter.notice.text : feedback || (caught ? state.config.teamSize > 1 ? 'Caught! A teammate can hook you to safety.' : 'Caught!' : protectedNow ? 'Protected while deploying' : ''),
    menu: fighter.menu, utility, ready: fighter.ready, canReady: phase.kind === 'warmup' && fighter.membership.kind === 'seated',
    canShop: canShop(state, fighter), waitingForNextMatch: fighter.membership.kind === 'watching', respawn,
    wallet: souls,
    native: { generation: sample?.generation ?? 0, slot: sample?.slot ?? -1, items: body?.nativeItems ?? [], hookRank: body?.hookRank ?? 0, range: profile.rangeMeters, cooldown: profile.cooldown },
    shop: { products, allowed: access.allowed, reason: access.reason },
    debug,
  }
}
