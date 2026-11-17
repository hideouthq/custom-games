export const unitsPerMetre = 39.37

export const arena = {
  pillars: 10,
  ringRadius: 1453,
  topSize: 268,
  topZ: 0,
  centreRadius: 236,
  centreZ: 79,
  standOffset: 70,
} as const

export const rules = {
  minPlayers: 2,
  maxPlayers: 8,
  countdownSeconds: 5,
  dropSeconds: 7,
  overtimeDropSeconds: 4,
  overtimeAt: 360,
  finalStandAt: 480,
  hardEndAt: 600,
  centreSeconds: 45,
  centreHoldSeconds: 1,
  startStamina: 1,
  intermissionSeconds: 7,
  matchEndSeconds: 12,
  rounds: 5,
  creditSeconds: 8,
  points: { win: 3, elimination: 1, topThree: 1 },
  topThreeMinPlayers: 4,
  maxStamina: 3,
  chargeSeconds: 3,
} as const

export const voids = {
  liveDepth: 25,
  overtimeDepth: 10,
  finalDepth: 5,
} as const

export const combat = {
  melee: { light: 50, heavy: 116 },
  knock: { light: 4, heavy: 6 },
  liftRatio: 0.5,
  maxLift: 5,
  overtimeKnock: 1.5,
  finalKnock: 2,
  ammoBudget: 150,
  reserveCap: 2,
  medkitHealth: 250,
  infiniteSeconds: 8,
} as const
