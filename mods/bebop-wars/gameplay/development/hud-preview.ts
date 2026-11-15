import type { HudAction, HudView, Side } from '../hud-model.ts'
import { accountId, actor, configuration, initial, settle, step, type AccountId, type Frame, type State } from '../model.ts'
import { catalog } from '../catalog.ts'
import { present } from '../presentation.ts'

export type PreviewScenario = 'warmup' | 'loadout' | 'shop' | 'poor' | 'outside' | 'pending' | 'countdown' | 'live' | 'caught' | 'respawn' | 'overtime' | 'results' | 'design' | 'design-shop' | 'last30' | 'design-overtime'
export const previewScenarios: readonly PreviewScenario[] = ['warmup', 'loadout', 'shop', 'poor', 'outside', 'pending', 'countdown', 'live', 'caught', 'respawn', 'overtime', 'results', 'design', 'design-shop', 'last30', 'design-overtime']
export interface PreviewSession { state: State; frame: Frame; self: AccountId }

export function previewSession(scenario: PreviewScenario): PreviewSession {
  const design = scenario === 'design' || scenario === 'design-shop' || scenario === 'last30' || scenario === 'design-overtime'
  const names = design ? ['Mugi', 'Practice Bebop'] : ['Mugi', 'The surprisingly long teammate name', 'Frost', 'Ember', 'Snowfall', 'Orange']
  let frame: Frame = {
    now: 12, deaths: [], globes: new Map(), pulls: new Map(),
    players: names.map((name, index) => {
      const side: Side = index % 2 === 0 ? 3 : 2
      return {
        id: accountId(`preview-${index}`), slot: index, generation: 1, name, bot: false,
        body: { entity: 100 + index, side, alive: true, health: 700, maxHealth: 1000, souls: 620, abilityPoints: 2, hookRank: 1, nativeItems: [], position: { x: 0, y: side === 3 ? 984 : -984, z: 104 }, velocity: { x: 0, y: 0, z: 0 }, hook: { entity: 200 + index, casting: false, victim: undefined, startedAt: 0, cooldownEnd: 0, executed: false } },
      }
    }),
  }
  let state = step(initial(configuration([design ? 'teams=1v1' : 'teams=3v3', 'preview'])), { ...frame, now: 10 }).state
  frame = { ...frame, players: frame.players.map(sample => {
    const membership = state.fighters.get(sample.id)?.membership
    if (!sample.body || membership?.kind !== 'seated') return sample
    const side = membership.side
    return { ...sample, body: { ...sample.body, side, position: { x: 0, y: side === 3 ? 984 : -984, z: 104 } } }
  }) }
  state = step(state, frame).state
  const self = accountId('preview-0'), fighter = state.fighters.get(self)
  if (!fighter) throw new Error('Preview player was not seated')
  state.phase = { kind: 'live', until: 234 }
  state.score = { 2: 16, 3: 18 }
  state.feed = [{ id: 3, text: 'Mugi killed Ember', side: 3, until: 20 }, { id: 2, text: 'Frost saved Mugi', side: 3, until: 20 }]
  for (const player of state.fighters.values()) {
    player.kills = player.id === self ? 9 : 3
    player.saves = player.id === self ? 3 : 1
  }
  fighter.progression.owned = ['snowGlobe', 'sprint']
  fighter.progression.utility = 'sprint'
  let souls = 620, cooldownEnd = 14.3
  fighter.utilityUntil = 23.4
  if (design) {
    state.score = { 2: 2, 3: 0 }; state.phase = { kind: 'live', until: 170 }; state.feed = []
    fighter.progression.owned = []; fighter.progression.utility = null; souls = 2150
    cooldownEnd = 0; fighter.utilityUntil = 0
  }
  switch (scenario) {
    case 'warmup':
    case 'loadout':
      state.phase = { kind: 'warmup' }; state.score = { 2: 0, 3: 0 }; state.feed = []
      fighter.progression.owned = []; fighter.progression.utility = null; souls = 300
      cooldownEnd = 0; fighter.utilityUntil = 0
      fighter.menu = scenario === 'loadout' ? 'loadout' : 'closed'
      break
    case 'shop': fighter.menu = 'loadout'; break
    case 'poor': fighter.menu = 'loadout'; souls = 80; break
    case 'outside': {
      const observed = frame.players[0]
      if (observed?.body && fighter.life.kind === 'alive') {
        const position = { x: 704, y: 256, z: 0 }
        fighter.life.position = position; fighter.life.safe = position
        frame = { ...frame, players: frame.players.map(sample => sample.id === self && sample.body ? { ...sample, body: { ...sample.body, position } } : sample) }
      }
      fighter.menu = 'loadout'
      break
    }
    case 'pending': {
      fighter.menu = 'loadout'
      const ref = actor(fighter)
      if (ref) fighter.progression.purchase = { id: 40, round: state.round, actor: ref, product: 'echo' }
      break
    }
    case 'countdown': state.phase = { kind: 'countdown', until: 15 }; state.score = { 2: 0, 3: 0 }; state.feed = []; break
    case 'caught':
      if (fighter.life.kind === 'alive') fighter.life.transit = { kind: 'pull', caster: { id: accountId('preview-3'), generation: 1, life: 1 }, originBank: 3 }
      break
    case 'respawn':
      fighter.life = { kind: 'dead', respawnAt: 15, confirmed: true }
      frame = { ...frame, players: frame.players.map(sample => sample.id === self && sample.body ? { ...sample, body: { ...sample.body, alive: false } } : sample) }
      break
    case 'overtime': state.phase = { kind: 'overtime' }; state.score = { 2: 25, 3: 25 }; fighter.menu = 'loadout'; break
    case 'results': state.phase = { kind: 'results', until: 20, winner: 3, reason: 'Kill victory' }; state.score = { 2: 23, 3: 25 }; break
    case 'live': break
    case 'design': break
    case 'design-shop': fighter.menu = 'loadout'; break
    case 'last30':
      state.phase = { kind: 'live', until: 42 }
      fighter.progression.owned = ['snowGlobe', 'sprint']; fighter.progression.utility = 'sprint'; souls = 450
      cooldownEnd = 15.2; fighter.setupUntil = 20
      frame = { ...frame, players: frame.players.map(sample => sample.id === self && sample.body ? { ...sample, body: { ...sample.body, sprintActive: true } } : sample) }
      break
    case 'design-overtime':
      state.phase = { kind: 'overtime' }; state.score = { 2: 24, 3: 24 }
      fighter.progression.owned = ['snowGlobe', 'echo']; fighter.progression.utility = 'echo'; souls = 450
      break
  }
  frame = { ...frame, players: frame.players.map(sample => sample.id === self && sample.body ? { ...sample, body: { ...sample.body, souls, nativeItems: fighter.progression.owned.filter(product => product === 'snowGlobe' || product === fighter.progression.utility).map((product, index) => ({ product, slot: 4 + index })), hook: sample.body.hook ? { ...sample.body.hook, cooldownEnd } : undefined } } : sample) }
  return { state, frame, self }
}

export function previewView(session: PreviewSession): HudView {
  const fighter = session.state.fighters.get(session.self)
  if (!fighter) throw new Error('Preview player missing')
  return present(session.state, fighter, session.frame)
}

export function previewAction(session: PreviewSession, action: HudAction): void {
  const fighter = session.state.fighters.get(session.self), ref = fighter && actor(fighter)
  if (!ref) return
  const result = step(session.state, session.frame, [{ kind: 'hud', actor: ref, action }])
  session.state = result.state
  for (const command of result.commands) {
    if (command.kind !== 'buy') continue
    const sample = session.frame.players.find(player => player.id === command.actor.id)
    if (!sample?.body) continue
    const price = catalog[command.product].price, bought = sample.body.souls >= price
    if (bought) session.frame = { ...session.frame, players: session.frame.players.map(player => player.id === command.actor.id && player.body ? { ...player, body: { ...player.body, souls: player.body.souls - price } } : player) }
    session.state = settle(session.state, [{ kind: 'purchase', actor: command.actor, round: command.round, id: command.id, result: bought ? 'bought' : 'unaffordable' }])
  }
  const equipped = session.state.fighters.get(session.self)?.progression
  if (equipped) session.frame = { ...session.frame, players: session.frame.players.map(sample => sample.id === session.self && sample.body ? { ...sample, body: { ...sample.body, nativeItems: equipped.owned.filter(product => product === 'snowGlobe' || product === equipped.utility).map((product, index) => ({ product, slot: 4 + index })) } } : sample) }
}
