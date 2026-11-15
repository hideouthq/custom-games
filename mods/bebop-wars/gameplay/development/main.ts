import { command, freeCursor, log, onFrame, onMelee, onParry, onStart, onWorld, Player } from 'modlock'
import { drawHud } from '../hud.tsx'
import { configuration } from '../model.ts'
import { startGame } from '../session.ts'
import { previewSession, previewView, previewAction, previewScenarios, type PreviewScenario } from './hud-preview.ts'
import { Probe } from './probe.ts'
import { Showcase } from './showcase.ts'

onStart(all => {
  const staged = all.includes('showcase')
  const args = all.filter(arg => arg !== 'showcase')
  const config = configuration(args)
  if (config.preview) {
    let preview = previewSession('live')
    let nextRender = 0
    log('[BebopWars] HUD PREVIEW ONLY. No native game validation. /preview ' + previewScenarios.join('|'))
    onFrame(event => {
      if (event.timeSeconds < nextRender) return
      nextRender = event.timeSeconds + 0.1
      const view = previewView(preview)
      freeCursor(Player.of(0), view.menu === 'loadout' || view.phase === 'warmup')
      drawHud(Player.of(0), view, action => previewAction(preview, action))
    })
    command('preview', (_player, args) => { if (isScenario(args)) preview = previewSession(args) })
  } else {
    const game = startGame(args)
    if (config.probe) {
      const probe = new Probe()
      onWorld(() => probe.reset())
      onFrame(event => probe.tick(game, event.timeSeconds))
      onMelee(swing => probe.swing(swing))
      onParry(parry => probe.parried(parry))
    }
    if (staged) {
      const showcase = new Showcase()
      onWorld(() => showcase.reset())
      onFrame(() => showcase.tick(game))
    }
  }
})

function isScenario(value: string): value is PreviewScenario { return previewScenarios.some(name => name === value) }
