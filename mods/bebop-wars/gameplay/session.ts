import { command, onAbilityCast, onDamage, onDamaged, onFrame, onInput, onWorld, type Player } from 'modlock'
import { isProductId } from './catalog.ts'
import type { HudAction } from './hud-model.ts'
import { Game } from './native.ts'
import { Practice } from './practice.ts'

export function startGame(args: readonly string[]): Game {
  const game = new Game(args)
  const practice = game.state.config.practice ? new Practice() : undefined
  game.start()

  onWorld(map => { game.world(map); practice?.reset() })
  onInput((player, pressed, released) => game.input(player, pressed, released))
  onDamage(hit => game.damage(hit))
  onDamaged(hit => game.damaged(hit))
  onAbilityCast(cast => game.cast(cast))
  onFrame(event => {
    game.tick(event)
    practice?.tick(game)
  })

  function request(player: Player, action: HudAction): void {
    for (const fighter of game.state.fighters.values()) {
      if (fighter.presence.kind === 'connected' && fighter.presence.slot === player.slot) {
        game.request(fighter.id, action)
        return
      }
    }
  }
  command('bebop_buy', (player, value) => { if (isProductId(value)) request(player, { kind: 'buy', product: value }) })
  command('bebop_equip', (player, value) => { if (isProductId(value)) request(player, { kind: 'equip', utility: value }) })
  for (const name of ['buyitem', 'buyactiveitem', 'buydependentitem', 'purchase']) {
    command(name, player => { player.chat('Buy equipment from the Bebop Wars shop cards.') })
  }
  command('sellitem', player => { player.chat('Equipment lasts this match and cannot be sold. Use the shop to switch owned utilities.') })
  command('ready', player => request(player, { kind: 'ready' }))
  command('loadout', (player, args) => request(player, { kind: args === 'close' ? 'close' : 'shop' }))
  return game
}
