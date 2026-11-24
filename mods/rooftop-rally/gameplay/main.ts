import {
  onInput,
  onDamage,
  onFrame,
  onPlayerAway,
  onPlayerJoin,
  onPlayerLeave,
  onPlayerReturn,
  onSpawn,
  onStart,
  onWorld,
  command,
} from 'modlock'
import { Game } from './game'
import { PracticeOpponent } from './practice'

export const game = new Game()
const practice = new PracticeOpponent()
onStart((args) => {
  game.start()
  practice.enabled = args.includes('practice')
})
onWorld(() => {
  game.world()
  practice.reset()
})
onPlayerJoin(({ connection }) => game.join(connection))
onPlayerAway(({ connection }) => game.presence(connection))
onPlayerReturn(({ connection }) => game.presence(connection))
onPlayerLeave(({ connection }) => {
  practice.leave(connection)
  game.leave(connection)
})
onSpawn((player, pawn) => game.spawned(player, pawn))
onInput((player, pressed, released) => game.input(player, pressed, released))
command('rally_choose', (player, value) => {
  game.choose(player, value)
})
command('rally_special', (player) => game.requestSpecial(player))
// The hero menu and the console both send this; every rally is played as Yamato.
command('selecthero', (player) =>
  player.chat('Rooftop Rally is played as Yamato.'),
)
onDamage(() => ({ block: true }))
onFrame((frame) => {
  game.frame(frame.timeSeconds, frame.movement)
  practice.frame(frame.timeSeconds, game)
})
