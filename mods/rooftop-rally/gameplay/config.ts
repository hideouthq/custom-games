export const metres = (value: number): number => value / 0.0254

export const rules = {
  countdown: 3,
  spawnTimeout: 8,
  serveWarning: 1,
  ballReset: 1,
  intermission: 5,
  startingPower: metres(30),
  powerCap: metres(400),
  powerMultiplier: 1.05,
  passivePowerGain: metres(0.25),
  serveSpeed: metres(1),
  minimumFlight: 0.25,
  orbitRadius: metres(14),
  orbitSlowSpeed: metres(80),
  orbitTime: 7.5,
  orbitWarning: 2.5,
  orbitPenalty: 5,
  orbitPush: metres(10),
  ballFloorHeight: 40,
  blockWindow: 0.4,
  blockCooldown: 0.8,
  blockRadius: 150,
  hitRadius: 35,
  chestHeight: 65,
  roofHalfExtent: 1668,
  minimumHeight: -120,
  spawnRadius: 1044,
  center: { x: 0, y: 0, z: 100 },
} as const

export const hero = 'hero_yamato'
export const blockEffect =
  'particles/abilities/yamato/yamato_crimson_slash.vpcf'
export const ballEffect =
  'particles/abilities/unicorn/unicorn_ball_projectile.vpcf'
