import {
  onInput,
  onDamage,
  onFrame,
  onPlayerJoin,
  onPlayerLeave,
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
onDamage(() => ({ block: true }))
onFrame((frame) => {
  game.frame(frame.timeSeconds, frame.movement)
  practice.frame(frame.timeSeconds, game)
})
