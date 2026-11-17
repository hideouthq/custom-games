import { describe, expect, test } from 'bun:test'

import { Centre } from '../gameplay/centre'
import { rules } from '../gameplay/config'

const due = rules.centreSeconds
const hold = rules.centreHoldSeconds

describe('centre', () => {
  test('a Legendary appears centreSeconds into play, once', () => {
    const centre = new Centre()
    expect(centre.tick(10)).toBe('waiting')
    expect(centre.tick(10 + due - 0.05)).toBe('waiting')
    expect(centre.open).toBe(false)
    expect(centre.tick(10 + due)).toBe('appears')
    expect(centre.open).toBe(true)
    expect(centre.tick(10 + due + 0.05)).toBe('open')
  })

  test('the deck goes to whoever stands on it for the hold', () => {
    const centre = new Centre()
    centre.tick(0)
    centre.tick(due)
    const on = (...ids: number[]) =>
      [1, 2].map((id) => ({ id, onDeck: ids.includes(id) }))
    expect(centre.hold(due, on(1))).toBeUndefined()
    expect(centre.hold(due + hold / 2, on(2))).toBeUndefined()
    expect(centre.hold(due + hold, on(1, 2))).toBeUndefined()
    expect(centre.hold(due + hold * 1.5, on(1, 2))).toBe(2)
    expect(centre.open).toBe(false)
    expect(centre.tick(due + hold * 1.5 + due - 0.05)).toBe('waiting')
    expect(centre.tick(due + hold * 1.5 + due)).toBe('appears')
  })

  test('closing stops the schedule until play starts it again', () => {
    const centre = new Centre()
    centre.tick(0)
    centre.tick(due)
    centre.close()
    expect(centre.open).toBe(false)
    expect(centre.tick(100)).toBe('waiting')
    expect(centre.tick(100 + due)).toBe('appears')
  })

  test('a broken crate takes the Legendary and sweeps its spoils a while', () => {
    const centre = new Centre()
    centre.tick(0)
    centre.tick(due)
    expect(centre.sweeping(due)).toBe(false)
    centre.broken(due)
    expect(centre.open).toBe(false)
    expect(centre.sweeping(due + 2.9)).toBe(true)
    expect(centre.sweeping(due + 3)).toBe(false)
    expect(centre.tick(due + due)).toBe('appears')
  })
})
