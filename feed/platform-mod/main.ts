import { log, onStart, serverCommand } from 'modlock'

const commands = ['net_option MTU_PacketSize 1200', 'sv_force_transmit_ents 1']

onStart(() => {
  for (const command of commands) {
    if (!serverCommand(command)) throw new Error(`the server refused "${command}"`)
    log(`applied "${command}"`)
  }
})
