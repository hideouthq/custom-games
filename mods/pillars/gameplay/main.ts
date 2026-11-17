import {
  command,
  onAbilityCast,
  onDamage,
  onDamaged,
  onFrame,
  onPlayerJoin,
  onPlayerLeave,
  onSpawn,
  onStart,
  onWorld,
} from 'modlock'

import { Game } from './game'

export const game = new Game()

onStart((args) => game.start(args))
onWorld(() => game.world())
onPlayerJoin(({ connection }) => game.join(connection))
onPlayerLeave(({ connection }) => game.leave(connection))
onSpawn((player) => game.spawned(player))
onAbilityCast((cast) => game.cast(cast))
onDamage((hit) => game.damage(hit))
onDamaged((hit) => game.damaged(hit))
onFrame((frame) => game.frame(frame.timeSeconds, frame.movement))
command('pillars', (player, args) => game.dev(player, args))
// The hero menu and the console both send this; heroes are dealt for the match.
command('selecthero', (player) =>
  player.chat('Heroes are dealt for the whole match and cannot be changed.'),
)
